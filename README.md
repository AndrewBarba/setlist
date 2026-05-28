# setlist

A Node.js library and CLI for ordering a dance-music setlist optimally.

Given a CSV of tracks (title, key, BPM, optionally artist), it produces an
ordering that respects the conventions DJs actually use when planning a
mix:

- **Camelot wheel harmonics** — adjacent keys mix; opposite-wheel keys clash.
- **Tempo trend** — energy should generally climb across the set, with
  bias against going down.
- **Extended-mix bridges** — extended tracks have drum/bass intros that
  partially mask harmonic clashes, so they can carry transitions that
  would otherwise be jarring.
- **Half/double-time matching** — `87 BPM ↔ 174 BPM` is a real D&B trick;
  the scorer treats it as compatible (with a small discount).

The output is a re-ordered track list plus per-transition compatibility
scores and a total score (`0` to `n−1`), so you can see exactly why the
ordering chose what it chose.

## Installation

Requires Node.js ≥23.6 (built-in TypeScript support, no build step needed
for source).

```bash
npm install setlist          # library
npx setlist < tracks.csv     # CLI (after install)
```

## Quickstart

```bash
# Run the source directly (no build step)
cat tracks.csv | node bin/setlist.ts

# After install, use the installed bin
cat tracks.csv | npx setlist

# Pin reproducibility with a seed
cat tracks.csv | npx setlist --seed 42
```

Output (pretty format, default):

```
Setlist (10 tracks, score: 8.541)
────────────────────────────────────────
 1. 8A    118 BPM       Belong (Original Mix) — Tycho  →[0.85]
 2. 4A    124 BPM [EXT] Pjanoo (Club Mix) — Eric Prydz  →[1.00]
 3. 8B    125 BPM [EXT] A Sky Full of Stars — Coldplay  →[1.00]
 ...
```

## CLI

```
USAGE:
  cat tracks.csv | setlist [OPTIONS]
  setlist [OPTIONS] < tracks.csv

OPTIONS:
  -f, --format <FMT>      Output format: pretty (default), json, or csv
  -s, --seed <N>          PRNG seed for reproducible output
  -i, --iterations <N>    SA iterations (default scales with input size)
  -d, --drop-below <X>    Drop tracks that force transitions below this
                          threshold (0–1). Dropped tracks are reported.
  -h, --help              Show usage
```

### Input format

CSV on stdin. Headers are required and matched case-insensitively.
Column order is flexible.

| Column   | Required | Description                                                  |
| -------- | -------- | ------------------------------------------------------------ |
| `title`  | Yes      | Track title. Title content also drives extended detection.   |
| `key`    | Yes      | Camelot (`8B`) or classical (`Am`, `F# minor`, `Bb major`).  |
| `bpm`    | Yes      | Number, optionally with a `bpm` suffix (`128`, `128.5 BPM`). |
| `artist` | No       | Any string.                                                  |

Extra columns (album, time, URL, etc.) are ignored. UTF-8 BOMs are
stripped. Quoted fields and escaped quotes per RFC 4180 are supported.

The `extended` flag for each track is derived from the title via marker
detection (`Extended Mix`, `Club Mix`, `Long Version`, `12"`, …) —
there's no separate column for it, since real-world DJ pool exports
rarely include one.

### Output formats

**`--format pretty`** (default): Human-readable table with position, key,
BPM, extended marker, title (with artist), and transition score
annotations.

**`--format json`**: The full `Sequence` object — tracks, transitions,
totalScore, and dropped — pretty-printed.

**`--format csv`**: Machine-readable CSV with columns
`position,title,artist,key,bpm,extended,score_to_next,status`. The
`status` column distinguishes `sequenced` from `dropped` tracks. The CSV
output is itself a valid input format for re-running the tool.

### Examples

```bash
# Basic run, default everything
cat tracks.csv | setlist

# Reproducible run with a seed
cat tracks.csv | setlist --seed 42

# Save as JSON for further processing
cat tracks.csv | setlist --format json > sequenced.json

# Drop tracks that force any transition below 0.1
cat tracks.csv | setlist --drop-below 0.1

# Higher-quality optimization (slower)
cat tracks.csv | setlist --iterations 500000

# Output CSV, re-sequence later
cat tracks.csv | setlist --format csv > sequenced.csv
cat sequenced.csv | setlist                  # parses cleanly
```

### Exit codes

- `0` — success
- `1` — runtime error (bad input, parse failure, empty stdin)
- `2` — usage error (invalid flag)

## Library

The library is exported from `index.ts`. Public API:

```ts
import {
  // Parsing
  parseSetlist,
  normalizeKey,
  normalizeBpm,
  isExtendedTitle,

  // Scoring
  harmonicScore,
  bpmScore,
  compatibility,

  // Sequencing
  sequence,

  // Types
  type Track,
  type Sequence,
  type SequenceOptions,
  type CamelotKey,
  type Bpm,
} from "setlist";
```

### Typical usage

```ts
import { readFile } from "node:fs/promises";
import { parseSetlist, sequence } from "setlist";

const csv = await readFile("tracks.csv", "utf8");
const tracks = parseSetlist(csv);

const result = sequence(tracks, { seed: 42, dropBelow: 0.1 });

for (let i = 0; i < result.tracks.length; i++) {
  const t = result.tracks[i]!;
  const trans = result.transitions[i];
  console.log(
    `${t.title} (${t.key}, ${t.bpm} BPM)`,
    trans !== undefined ? `→ ${trans.toFixed(2)}` : "",
  );
}
console.log(`Total: ${result.totalScore.toFixed(3)}`);
console.log(`Dropped: ${result.dropped.length}`);
```

The library is pure — no I/O, no globals. Input is a string (CSV) or a
`Track[]`; output is a `Sequence` value. The CLI is a thin wrapper that
handles stdin/stdout.

### Branded types

Two types are _branded_ to enforce normalization at the type level:

- `CamelotKey` is `"1A" | "1B" | … | "12B"` — a string-literal union of
  the 24 valid Camelot positions. Use `normalizeKey(input)` to produce
  one from raw input.
- `Bpm` is `number & { readonly [bpmBrand]: never }`. Use
  `normalizeBpm(input)` to produce one; the phantom symbol is the
  type-level proof that the value passed validation (range, format, etc.).

You can't stuff a raw `string` or `number` into a `Track.key` or
`Track.bpm` field without going through the normalizers (or an explicit
cast). This prevents the most common bug class — propagating
unvalidated CSV data into the rest of the pipeline.

## How it works

Three independent scoring dimensions, then an integration step, then a
search over orderings.

### 1. Key (Camelot harmonic distance)

Keys are normalized to Camelot wheel notation (`1A`–`12B`). The
harmonic-compatibility score is looked up in a hand-tuned 7×2 table
indexed by `(numberDistance, modeSwap)`:

| Wheel distance                       | Same mode | Mode swap |
| ------------------------------------ | --------- | --------- |
| 0 (identical / relative major-minor) | 1.00      | 0.90      |
| 1 (perfect 5th/4th / diagonal)       | 0.90      | 0.55      |
| 2                                    | 0.45      | 0.25      |
| 3                                    | 0.25      | 0.10      |
| 4                                    | 0.10      | 0.05      |
| 5                                    | 0.05      | 0.02      |
| 6 (opposite side)                    | 0.00      | 0.00      |

The wheel is circular — `1B → 12B` is one step, not eleven. Values are
calibrated to standard DJ-mixing conventions: same key and relative
minor/major are both excellent; one wheel step is the canonical "energy
boost" or "energy drop"; opposite-side jumps are effectively unmixable
on harmonic grounds alone.

### 2. Tempo (BPM scoring with half/double-time folding)

BPM scoring is asymmetric — going up beats going down.

- Plateau at `1.0` from `Δ = 0` to `Δ = +2` (same tempo or a small bump
  up — both ideal).
- Linear ramp down to `0.0` over `4` BPM for negative deltas.
- Linear ramp down to `0.0` over `7` BPM for positive deltas beyond the
  plateau.

Before computing the delta, the algorithm considers three candidate
target BPMs — the literal `to`, `2 × to`, and `½ × to` — and picks the
one closest to `from`. If a fold won (`87 ↔ 174` D&B-style), the score
is multiplied by `0.85` to reflect that the technique requires explicit
DJ work.

The asymmetric ramps bake in the "trend up" preference at the per-pair
level — optimal sequences naturally start low and climb without any
extra global term.

### 3. Extended escape hatch (partial harmonic blend)

When the _incoming_ track is extended (per title detection), its
harmonic score is partially blended toward `1.0`:

```
final_harmonic = α + (1 − α) × raw_harmonic    where α = 0.5
```

- Raw `1.0` → `1.00` (no change)
- Raw `0.9` → `0.95`
- Raw `0.45` → `0.73`
- Raw `0.0` → `0.50` (worst-case floor)

This rewards extended tracks as bridges across harmonic distance, but
doesn't erase the distance entirely — a 4-step wheel jump still scores
worse than a 1-step jump even when extended. Only `to.extended` matters;
the _outgoing_ track's extended flag doesn't enter the score.

Tempo is **never** discounted by extended. A bad BPM transition stays bad.

### 4. Integration: geometric mean

```
compatibility(from, to) = sqrt(harmonic × tempo)
```

Geometric mean keeps the result in `[0, 1]` with intuitive scaling.
`0.5 × 0.5 = 0.5` (versus raw product's `0.25`) — "mediocre on both
axes" reads as mediocre, not unmixable. A zero in either dimension
collapses the whole score to zero, which is the correct gating: tempo
clashes can't be papered over.

### 5. Sequencing: greedy warm start + simulated annealing

1. **Greedy warm start.** Pick a starting track (weighted random,
   biased toward low BPM) and append the highest-compat next track at
   each step. Produces a decent baseline ordering quickly.
2. **Simulated annealing.** Propose neighbor moves (50% swap two random
   positions, 50% relocate a track from one position to another).
   Accept improvements unconditionally; accept regressions with
   probability `exp(Δ / T)`. Cool geometrically from `T = 0.5` to
   `T = 0.001` over the iteration count.
3. **Return the best-seen ordering** across all iterations, not the
   final SA state (which may have wandered).

Default iteration count: `max(2000, n² × 100)`. This is empirically in
the quality plateau for typical setlists (10–60 tracks). Override with
`--iterations` if you want longer/shorter searches.

### 6. Optional filtering (`--drop-below`)

When `--drop-below <threshold>` is set, the algorithm iteratively
removes tracks that force transitions below the threshold:

1. Sequence the current set.
2. Find the worst transition. If it's strictly above the threshold,
   stop.
3. Otherwise, try removing each endpoint and re-sequencing; drop
   whichever endpoint yields a higher re-sequenced total.
4. Repeat.

Drop decisions are sensitive to SA quality, so the filter internally
uses a higher iteration multiplier (`n² × 500` with a `50,000` floor)
than the default sequencing path. This ensures drops are based on
near-global-optimum arrangements, not on local-optimum noise.

The threshold is **inclusive** — `--drop-below 0` catches literal
zero-score transitions; `--drop-below 0.3` catches anything at or below
`0.3`.

Dropped tracks are reported in the output (pretty: "Dropped" section;
JSON: `dropped` array; CSV: `status` column).

## Project structure

```
bin/
  setlist.ts        CLI entry point (stdin, arg parsing, dispatch)
  format.ts         Pure formatters: pretty, json, csv

lib/
  types.ts          Core types: CamelotKey, Bpm, Track
  key.ts            Key parsing + normalization (Camelot/classical)
  bpm.ts            BPM parsing + validation
  extended.ts       Title-based extended-mix detection
  csv.ts            CSV → Track[] parsing
  harmonic.ts       Camelot wheel distance + harmonic scoring
  tempo.ts          BPM delta + tempo scoring (with half/double folding)
  compat.ts         Pairwise compatibility (integration layer)
  sequence.ts       Sequencer: greedy warm start + SA + optional filter
  rng.ts            Seeded PRNG (mulberry32)

tests/              One file per lib module, plus format.test.ts
                    and a couple of integration tests.

index.ts            Public API re-exports
```

The lib modules are layered bottom-up: types → key/bpm/extended → csv,
harmonic/tempo → compat → sequence. Each layer has its own test file
covering its public surface independently.

## Development

Day-to-day development runs the TypeScript source directly under Node —
no build step required.

```bash
npm test                             # run the test suite (node:test)
npm run typecheck                    # tsc --noEmit (full strict check)
node bin/setlist.ts < tracks.csv     # run CLI from source
npm run build                        # emit dist/ for npm distribution
npm pack --dry-run                   # preview what would publish to npm
```

The test suite (243 tests across 11 files) covers parsing edge cases
(BOMs, quoting, classical key disambiguation like `Bb` vs `Bm` vs `Bbm`),
scoring properties (boundedness, asymmetry, monotonic falloff), and
sequencing invariants (set preservation, seed determinism, BPM trend).
Tests live alongside their corresponding `lib/` module and use Node's
built-in `node:test` runner via a thin shim in `tests/_helpers.ts`.

### Build & publishing

For **npm publishing**, a build step compiles `lib/`, `bin/`, and
`index.ts` to `dist/`. This is necessary because Node disables
TypeScript type-stripping inside `node_modules/` (a deliberate runtime
restriction, not something a flag can override). The build runs
automatically via the `prepack` hook before `npm publish`.

Build artifacts use `.js` import extensions; source uses `.ts`
extensions. TypeScript's `rewriteRelativeImportExtensions` handles the
translation, so source can be run directly under Node while published
artifacts conform to Node ESM resolution rules.

## Design notes

A few decisions worth flagging:

**Why a brand for `Bpm` but a literal union for `CamelotKey`?** Camelot
has 24 valid values that fit naturally in a string-literal union, so
exhaustiveness comes for free from the type system. BPM is a numeric
range that TS can't express directly, so a phantom brand is the only
way to mark "validated" at the type level.

**Why simulated annealing instead of exact search?** Setlists of 15+
tracks already exceed Held-Karp's practical limit (`O(n² · 2ⁿ)`). SA
scales smoothly, has natural randomness (so different seeds produce
different valid orderings), and reliably finds near-optimal solutions
on real DJ pool exports. For the input sizes that matter (10–60
tracks), the quality gap versus exact is negligible.

**Why partial blend for extended, not full discount?** An extended
intro masks harmonic clash during the mix-in window, but once the
melody enters, real key distance becomes audible. A full discount
(`harmonic = 1.0`) implied that key distance disappears entirely,
which is too generous. The partial blend keeps harmonic distance as a
meaningful signal while rewarding extended tracks as bridges.

**Why `--drop-below` is inclusive (`≤` not `<`)?** The most natural
user request — "drop the literal zeros" — translates to
`--drop-below 0`. Strict-less-than would make that a no-op. The
inclusive interpretation matches user intent at the cost of a small
semantic stretch.

**Why a `status` column in CSV output even when nothing's dropped?**
Schema stability. Consumers can rely on 8 columns regardless of
whether filtering was used. The one extra "sequenced" value is a tiny
cost for predictable parsing.

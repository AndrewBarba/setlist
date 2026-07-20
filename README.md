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
  -i, --iterations <N>    SA iterations (default scales with input size and is
                          tuned for best results — several seconds on typical lists)
  -d, --drop-below <X>    Drop tracks that force transitions below this
                          threshold (0–1). Dropped tracks are reported.
  -k, --ignore-bpm        Sort by key compatibility only (for sets played at
                          a single master tempo)
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

# Playing the whole set at one master tempo? Sort by key only.
cat tracks.csv | setlist --ignore-bpm

# Faster, lower-quality optimization (the default favors quality)
cat tracks.csv | setlist --iterations 200000

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
| 2 (but see energy boosts below)      | 0.45      | 0.25      |
| 3                                    | 0.25      | 0.10      |
| 4                                    | 0.10      | 0.05      |
| 5 (but see energy boosts below)      | 0.05      | 0.02      |
| 6 (opposite side)                    | 0.00      | 0.00      |

The wheel is circular — `1B → 12B` is one step, not eleven. Values are
calibrated to standard DJ-mixing conventions: same key and relative
minor/major are both excellent; one wheel step is the canonical
compatible move; opposite-side jumps are effectively unmixable on
harmonic grounds alone.

**The energy boost exceptions (+2 and −5 / +7 mixes).** Two moves are
*directional* overrides that score **0.70** on the same ring, both from
Mixed In Key's "Energy Boost" playbook. Each Camelot step is a perfect
fifth (7 semitones), so:

- **+2** (e.g. `5A → 7A`): +14 ≡ +2 semitones — the incoming track
  sounds a whole tone higher. MIK's primary energy boost; also fairly
  smooth (the keys share 5 of 7 pitches).
- **−5 ≡ +7** (e.g. `12A → 7A`, `8A → 3A`): +49 ≡ +1 semitone — one
  semitone higher. The "Armin Van Buuren variation"; a bigger perceived
  lift, harsher during long blends.

The overrides only apply going *up*: the reverses (`7A → 5A` whole-tone
drop, `3A → 8A` semitone drop) keep their table scores (0.45 / 0.05),
and mode-swapped variants aren't the documented technique and keep
theirs too. This makes `harmonicScore(from, to)` asymmetric —
consistent with the tempo score, which already prefers up over down.

The 0.70 weight is deliberate: above the diagonal (0.55) so a boost is
a genuinely attractive bridge, but below canonical moves (0.90) so the
sequencer only reaches for it when no same-key / ±1 / relative option
exists — "use in moderation," encoded as relative ordering.

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
2. **Simulated annealing.** Propose neighbor moves — 25% swap two
   random positions, 25% relocate a single track, 35% 2-opt segment
   reversal, 15% relocate a contiguous block of 2–4 tracks. Accept
   improvements unconditionally; accept regressions with probability
   `exp(Δ / T)`. Cool geometrically from `T = 0.5` to `T = 0.001` over
   the iteration count.

   The segment moves matter because the objective is *asymmetric*
   (tempo trend + directional energy boosts): greedy often builds
   coherent runs pointed the wrong way, and flipping a run via single
   swaps means crossing a deep score valley that annealing won't cross
   at low temperature. Reversal fixes a mis-directed run in one move.
   Without these moves the search reliably pins itself in local optima
   on larger lists (~0.2–0.7 total score below optimum, with high
   run-to-run variance).
3. **Restarts.** The iteration budget is split across 3 independent
   greedy-start + SA runs; the best result wins. Restarts attack a
   failure mode a bigger budget can't: a greedy start can land in a
   basin containing a catastrophic seam (e.g. a 0.0 transition) that
   annealing can't escape once cooled. Three fresh starts are three
   independent chances at a good basin, for the same total cost.
4. **Return the best-seen ordering** across all iterations, not the
   final SA state (which may have wandered).

Move proposals are scored *incrementally* — only the edges a move
touches are re-evaluated (O(1) for swaps and block moves, O(segment)
for reversals) instead of rescanning the whole ordering. This makes
each iteration ~10× cheaper at typical sizes, which funds a much larger
default budget.

Default iteration count: `max(200000, n² × 6000)`, deliberately tuned
for **best results over speed** — roughly 5 seconds on a 41-track list,
where it lands within noise of the global optimum on every seed with no
catastrophic seams. Pass a lower `--iterations` if you want speed over
quality (results degrade gracefully).

### 6. BPM-agnostic mode (`--ignore-bpm`)

When the whole set will be played at a single master tempo, each
track's recorded BPM is irrelevant — sorting should be purely harmonic.
With `--ignore-bpm` (`ignoreBpm: true` in the API):

- Transitions are scored with `harmonicCompatibility` — the Camelot
  harmonic score with the extended-track blend, no tempo term.
- Reported transition scores are harmonic-only too.
- The greedy warm start picks a uniform random starting track instead
  of biasing toward low BPM.
- `--drop-below` still works and drops harmonic outliers.

### 7. Optional filtering (`--drop-below`)

When `--drop-below <threshold>` is set, the algorithm iteratively
removes tracks that force transitions below the threshold:

1. Sequence the current set.
2. Find the worst transition. If it's strictly above the threshold,
   stop.
3. Otherwise, try removing each endpoint and re-sequencing; drop
   whichever endpoint yields a higher re-sequenced total.
4. Repeat.

Drop decisions are sensitive to SA quality — a track only looks like a
genuine outlier if it can't fit even in a near-optimal arrangement. The
default iteration budget is already tuned for near-optimal results, so
inner passes use it as-is. Note each drop costs up to 3 extra
sequencing passes, so `--drop-below` runs take a small multiple of the
plain sequencing time.

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

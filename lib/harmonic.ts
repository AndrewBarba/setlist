import type { CamelotKey, CamelotMode } from "./types.ts";

/**
 * The Camelot wheel decomposed: a position (1–12) and a mode (A=minor / B=major).
 *
 * We keep this as a lightweight internal struct rather than re-exporting it,
 * because callers reason in terms of CamelotKey strings; this is just the
 * internal shape used for distance math.
 */
interface DecomposedKey {
  number: number;
  mode: CamelotMode;
}

/**
 * Result of measuring the distance between two Camelot keys on the wheel.
 *
 *   - `numberDistance` — shortest path around the 12-position circle.
 *     Range: 0..6 (since the wheel wraps, 7+ steps would be shorter going
 *     the other way).
 *   - `modeSwap`        — `true` if the two keys live on different rings
 *     (A vs B), i.e. one is minor and the other is major.
 */
export interface CamelotDistance {
  numberDistance: number;
  modeSwap: boolean;
}

/**
 * Hand-tuned harmonic-compatibility scores indexed by
 * `[numberDistance][modeSwap ? 1 : 0]`.
 *
 * Values reflect standard Camelot DJ-mixing conventions:
 *
 *   - `(0, sameMode)` — identical key. Perfect.
 *   - `(0, modeSwap)` — relative minor/major (e.g. 8B ↔ 8A). Shares the
 *     pitch set; very compatible, mainly a mood shift.
 *   - `(1, sameMode)` — adjacent on the wheel (perfect 5th / 4th). The
 *     classic "energy boost" / "energy drop" move; equally compatible to
 *     identical for DJ purposes.
 *   - `(1, modeSwap)` — diagonal. Workable, used by some DJs, but less
 *     standard.
 *   - `(≥2, ...)`     — non-canonical Camelot moves; degrade quickly.
 *   - `(6, ...)`      — opposite side of the wheel. Effectively unmixable
 *     for harmonic purposes; only an extended-track bridge will save it.
 *
 * Note: distances 2 and 5, same mode, have *directional* exceptions —
 * the "energy boost" mixes (+2 and −5 ≡ +7) — handled in
 * {@link harmonicScore} before this table is consulted. The table values
 * cover only the non-boost directions: −2 (a whole-tone drop; still
 * workable, keys share 5 of 7 pitches) and +5 ≡ −7 (a semitone drop;
 * near-unmixable).
 *
 * The numbers are deliberately tunable from one place rather than buried
 * in a formula. Sweep them during sequencer tuning if needed.
 */
const HARMONIC_SCORE_TABLE: readonly (readonly [number, number])[] = [
  /* numDist 0 */ [1.0, 0.9],
  /* numDist 1 */ [0.9, 0.55],
  /* numDist 2 */ [0.45, 0.25],
  /* numDist 3 */ [0.25, 0.1],
  /* numDist 4 */ [0.1, 0.05],
  /* numDist 5 */ [0.05, 0.02],
  /* numDist 6 */ [0.0, 0.0],
];

/**
 * Score for the "energy boost" mixes — Mixed In Key's two documented
 * directional techniques, both staying on the same ring:
 *
 *   - **+2** (the primary energy boost): add 2 to the key code, e.g.
 *     `5A → 7A`. Each Camelot step is a perfect fifth (7 semitones), so
 *     +2 steps ≡ 14 ≡ +2 semitones — the incoming track sounds a whole
 *     tone higher. Keys share 5 of 7 pitches, so it's also reasonably
 *     smooth harmonically.
 *   - **−5 ≡ +7** (the "Armin Van Buuren variation"): subtract 5, e.g.
 *     `12A → 7A`, `8A → 3A`. 7 steps ≡ 49 ≡ +1 semitone: one semitone
 *     higher — a bigger perceived lift, harsher during a long blend.
 *
 * Crucially both are directional. The reverses (−2 = whole-tone drop,
 * +5 ≡ −7 = semitone drop) are not recognized techniques and keep their
 * table scores.
 *
 * Weighted at 0.7: above the diagonal (0.55) so a boost is a genuinely
 * good option, but below the canonical moves (0.9) so the sequencer only
 * reaches for it when no ±1 / same-key / relative option exists —
 * matching the "use it in moderation" guidance for these techniques.
 */
const ENERGY_BOOST_SCORE = 0.7;

/**
 * Clockwise step counts (see {@link clockwiseSteps}) that qualify as an
 * energy boost when the mode is unchanged: +2 (whole tone up) and
 * +7 ≡ −5 (semitone up).
 */
const ENERGY_BOOST_STEPS: ReadonlySet<number> = new Set([2, 7]);

/**
 * Decompose a Camelot key string into its number and mode.
 *
 * Trusts that the input has already been validated (e.g. via the
 * `CamelotKey` type), so no runtime parsing checks are performed.
 */
function decompose(key: CamelotKey): DecomposedKey {
  const mode = key.slice(-1) as CamelotMode;
  const number = Number(key.slice(0, -1));
  return { number, mode };
}

/**
 * Shortest distance between two positions on a circular index space of
 * size `modulus`. E.g. on the 12-position wheel, `circularDist(1, 12)` is
 * `1`, not `11`.
 */
function circularDist(a: number, b: number, modulus: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, modulus - raw);
}

/**
 * Signed clockwise steps from `from` to `to` on the 12-position wheel,
 * in `0..11`. E.g. `steps(8, 3)` is `7` (equivalently −5 counterclockwise)
 * — the energy-boost move. Unlike `circularDist`, this preserves
 * direction, which matters because some Camelot techniques only work one
 * way around the wheel.
 */
function clockwiseSteps(from: number, to: number): number {
  return (to - from + 12) % 12;
}

/**
 * Measure the wheel distance and mode relationship between two Camelot keys.
 *
 * `numberDistance` is the shortest path around the 12-position circle (0–6);
 * `modeSwap` is `true` when the keys are on different rings (A ↔ B).
 *
 * Useful both for `harmonicScore` and for any downstream caller that wants
 * to inspect *why* a transition scored a given way.
 */
export function camelotDistance(a: CamelotKey, b: CamelotKey): CamelotDistance {
  const da = decompose(a);
  const db = decompose(b);
  return {
    numberDistance: circularDist(da.number, db.number, 12),
    modeSwap: da.mode !== db.mode,
  };
}

/**
 * Harmonic-compatibility score for the transition `from → to`, in `[0, 1]`.
 *
 * `1.0` = identical key; `0.9` = a canonical Camelot move (adjacent number
 * or relative minor/major); `0.7` = a directional "energy boost" mix
 * (+2 or −5 ≡ +7 on the same ring, e.g. `5A → 7A`, `8A → 3A` — see
 * {@link ENERGY_BOOST_SCORE}); values otherwise degrade as the wheel
 * distance grows. `0.0` indicates the opposite side of the wheel —
 * essentially unmixable on harmonic grounds alone.
 *
 * NOTE: because of the energy-boost rules this function is *not*
 * symmetric — `harmonicScore("8A", "3A")` is `0.7` while
 * `harmonicScore("3A", "8A")` is `0.05`. Argument order is
 * outgoing-track, incoming-track.
 *
 * The exact curve lives in {@link HARMONIC_SCORE_TABLE}, which is
 * deliberately hand-tuned rather than computed: standard Camelot mixing
 * theory doesn't follow a clean exponential, and explicit values are easier
 * to reason about and adjust during sequencer tuning.
 */
export function harmonicScore(from: CamelotKey, to: CamelotKey): number {
  const df = decompose(from);
  const dt = decompose(to);
  const modeSwap = df.mode !== dt.mode;

  // Energy boosts (+2 or −5 ≡ +7, same ring): the incoming track sounds
  // a whole tone / semitone higher respectively. Directional — the
  // reverse moves are pitch drops and fall through to their table scores.
  if (!modeSwap && ENERGY_BOOST_STEPS.has(clockwiseSteps(df.number, dt.number))) {
    return ENERGY_BOOST_SCORE;
  }

  const numberDistance = circularDist(df.number, dt.number, 12);
  // numberDistance is constrained to 0..6 by circularDist, so this lookup
  // is always defined; the non-null assertion is safe.
  const row = HARMONIC_SCORE_TABLE[numberDistance]!;
  return row[modeSwap ? 1 : 0]!;
}

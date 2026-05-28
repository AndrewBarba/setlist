import type { Bpm } from "./types.ts";

/**
 * The BPM delta between two tracks, after considering half/double-time
 * folding.
 *
 *   - `delta`  — signed effective delta (`effectiveTo - from`).
 *     A `+3` means the incoming track is 3 BPM faster than the outgoing
 *     track once any half/double-time adjustment has been applied.
 *   - `folded` — `true` if we used 2× or ½× of the incoming track's BPM
 *     to find the closest match. Folded matches still score, but with a
 *     small discount (they require explicit DJ technique to execute).
 */
export interface BpmDelta {
  delta: number;
  folded: boolean;
}

/**
 * Range (in BPM) over which a *negative* delta degrades from full score to
 * zero. Going *down* in tempo is more jarring than going up — especially
 * for sets that should trend up — so this range is tighter than UP_RANGE.
 */
const DOWN_RANGE = 4;

/**
 * Range (in BPM) over which a *positive* delta beyond the plateau degrades
 * from full score to zero. Wider than DOWN_RANGE because a moderate
 * energy lift is musically expected.
 */
const UP_RANGE = 7;

/**
 * Upper end of the "ideal" plateau. Deltas from 0 to PLATEAU_HIGH score 1.0
 * — same BPM or a small bump up is equally great.
 */
const PLATEAU_HIGH = 2;

/**
 * Score multiplier applied when the best match required half- or
 * double-time folding (e.g. 87 ↔ 174). The technique is valid but takes
 * explicit work, so it's penalized slightly versus a natural match.
 */
const FOLDED_DISCOUNT = 0.85;

/**
 * Compute the effective BPM delta from `from` to `to`, considering
 * half/double-time folding.
 *
 * For each direction (`to`, `2 × to`, `½ × to`) we compute the candidate
 * delta and choose the one with the smallest absolute value. If a folded
 * candidate wins, `folded` is `true`.
 *
 * Examples:
 *   - `bpmDelta(120, 124)` → `{ delta: 4, folded: false }`
 *   - `bpmDelta(120, 60)`  → `{ delta: 0, folded: true }` (60 → 120)
 *   - `bpmDelta(120, 240)` → `{ delta: 0, folded: true }` (240 → 120)
 *   - `bpmDelta(87, 174)`  → `{ delta: 0, folded: true }` (D&B trick)
 */
export function bpmDelta(from: Bpm, to: Bpm): BpmDelta {
  const candidates: ReadonlyArray<{ effective: number; folded: boolean }> = [
    { effective: to, folded: false },
    { effective: 2 * to, folded: true },
    { effective: 0.5 * to, folded: true },
  ];

  let best = candidates[0]!;
  for (const c of candidates) {
    if (Math.abs(c.effective - from) < Math.abs(best.effective - from)) {
      best = c;
    }
  }

  return { delta: best.effective - from, folded: best.folded };
}

/**
 * Convert a raw signed delta into a base score in `[0, 1]`, without the
 * folding discount.
 *
 * Curve:
 *   - `0 ≤ delta ≤ PLATEAU_HIGH` → `1.0` (ideal: same BPM or slight bump up)
 *   - `delta < 0`                → linear ramp to 0 over `DOWN_RANGE` BPM
 *   - `delta > PLATEAU_HIGH`     → linear ramp to 0 over `UP_RANGE` BPM
 *
 * The asymmetric ramps bake in the "trending up" preference: a negative
 * delta of equal magnitude scores worse than a positive one.
 */
function scoreFromDelta(delta: number): number {
  if (delta >= 0 && delta <= PLATEAU_HIGH) return 1.0;
  if (delta < 0) return Math.max(0, 1 - Math.abs(delta) / DOWN_RANGE);
  return Math.max(0, 1 - (delta - PLATEAU_HIGH) / UP_RANGE);
}

/**
 * Tempo-compatibility score between two BPMs, in `[0, 1]`.
 *
 * `1.0` means a trivial mix (same tempo or a small upward bump); the score
 * falls off asymmetrically — faster for negative deltas (going down) than
 * for positive ones (going up). Half/double-time matches are considered
 * compatible but discounted slightly (by {@link FOLDED_DISCOUNT}) since
 * they require explicit DJ technique.
 *
 * This function is intentionally asymmetric in `from`/`to`: the order
 * matters because going from 120 to 124 is musically different from
 * going from 124 to 120, even though the raw delta has the same magnitude.
 */
export function bpmScore(from: Bpm, to: Bpm): number {
  const { delta, folded } = bpmDelta(from, to);
  const base = scoreFromDelta(delta);
  return folded ? base * FOLDED_DISCOUNT : base;
}

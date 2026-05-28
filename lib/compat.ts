import { harmonicScore } from "./harmonic.ts";
import { bpmScore } from "./tempo.ts";
import type { Track } from "./types.ts";

/**
 * Blend factor for the extended-track harmonic discount.
 *
 * When the incoming track is extended, its raw harmonic score is blended
 * toward `1.0`:
 *
 *   `final = α + (1 - α) × raw`
 *
 * With `α = 0.5`:
 *   - `raw = 1.0` → `1.00` (no change; already perfect)
 *   - `raw = 0.9` → `0.95`
 *   - `raw = 0.45` → `0.73`
 *   - `raw = 0.0` → `0.50` (worst case is bounded at α)
 *
 * Rationale: an extended intro masks key during the mix-in window, but
 * once the melody enters, a real key clash is still audible. The blend
 * keeps harmonic distance meaningful while rewarding extended tracks as
 * bridges. A "full discount" (raw → 1.0) was too generous; this is the
 * tunable middle ground.
 */
const EXTENDED_HARMONIC_BLEND = 0.5;

/**
 * Pairwise compatibility score for an A → B transition, in `[0, 1]`.
 *
 * Combines two independent dimensions:
 *
 *   1. **Tempo** — {@link bpmScore} (asymmetric: rewards small upward
 *      deltas, penalizes downward deltas, considers half/double-time
 *      folding). Always applied; never discounted by `extended`.
 *   2. **Harmonic** — {@link harmonicScore} on the Camelot wheel. When
 *      `to.extended` is true, the raw harmonic score is partially blended
 *      toward `1.0` via {@link EXTENDED_HARMONIC_BLEND} — extended tracks
 *      forgive harmonic distance, but they don't erase it.
 *
 * Combined via geometric mean: `sqrt(harmonic × tempo)`. Keeps the result
 * in `[0, 1]` with intuitive scaling; preserves the "0.5 × 0.5 = 0.5"
 * interpretation rather than collapsing to a raw product (0.25).
 *
 * Asymmetric in `(from, to)` because direction-of-motion (tempo trend) is
 * part of the score, and only the *incoming* track's `extended` flag
 * matters (the intro is what overlaps during the harmonic-clash window).
 */
export function compatibility(from: Track, to: Track): number {
  const tempo = bpmScore(from.bpm, to.bpm);
  const rawHarmonic = harmonicScore(from.key, to.key);
  const harmonic = to.extended
    ? EXTENDED_HARMONIC_BLEND + (1 - EXTENDED_HARMONIC_BLEND) * rawHarmonic
    : rawHarmonic;
  return Math.sqrt(harmonic * tempo);
}

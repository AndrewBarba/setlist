import type { ScoreFn } from "./compat.ts";
import type { Track } from "./types.ts";

/**
 * A candidate perturbation of an ordering, described symbolically so its
 * score impact can be computed incrementally (O(edges touched)) instead
 * of rescanning the whole array (O(n)).
 *
 *   - `swap`    — exchange the tracks at positions `i` and `j` (`i < j`).
 *   - `reverse` — reverse the segment `[lo, hi]` inclusive (`lo < hi`).
 *     The classic 2-opt move.
 *   - `block`   — remove the `len` tracks starting at `start`, then
 *     re-insert them (order preserved) at index `insertAt` *of the
 *     shortened array*. `len = 1` is a single-track relocate; `len ≥ 2`
 *     is an or-opt block move.
 *
 * Only positions are stored — a `Move` is only meaningful against the
 * array it was proposed for.
 */
export type Move =
  | { kind: "swap"; i: number; j: number }
  | { kind: "reverse"; lo: number; hi: number }
  | { kind: "block"; start: number; len: number; insertAt: number };

/**
 * Edge score between two optional tracks: the pairwise score, or `0`
 * when either side is out of bounds (the ordering has no edge there).
 * Keeping the guard here lets the delta formulas ignore array ends.
 */
function edge(score: ScoreFn, a: Track | undefined, b: Track | undefined): number {
  return a !== undefined && b !== undefined ? score(a, b) : 0;
}

/**
 * Propose a random move against an ordering of length `n` (requires
 * `n ≥ 2`). Move mix:
 *
 *   - 25% swap
 *   - 25% single-track relocate (`block` with `len = 1`)
 *   - 35% 2-opt segment reversal
 *   - 15% or-opt block relocate (`len` 2–4, clamped to `n - 1`)
 *
 * The segment moves are essential, not a luxury. The objective is
 * *asymmetric* (tempo prefers up-trends; harmonic scoring has directional
 * energy-boost moves), and greedy construction routinely builds runs of
 * tracks that are internally coherent but pointed the wrong way (e.g. a
 * descending-BPM chain). Fixing a mis-directed run with only swaps and
 * single relocations requires stepping through many individually-terrible
 * intermediate orderings — a deep score valley that annealing essentially
 * never crosses once the temperature drops. A reversal flips the whole
 * run in one move, and a block relocate re-stitches coherent mini-runs
 * without dismantling them.
 *
 * Empirically (41-track real-world setlist), swap+relocate alone plateaus
 * ~0.2–0.7 total score below the optimum regardless of iteration budget,
 * with high run-to-run variance — the search gets pinned in local optima.
 * Adding reversal + block moves converges near-optimally and tightens
 * variance by ~3×.
 */
export function proposeMove(n: number, rng: () => number): Move {
  const roll = rng();
  const i = Math.floor(rng() * n);
  let j = Math.floor(rng() * n);
  while (j === i) j = Math.floor(rng() * n);

  if (roll < 0.25) {
    return { kind: "swap", i: Math.min(i, j), j: Math.max(i, j) };
  }
  if (roll < 0.5) {
    // Single-track relocate: remove at i, insert at j. j ranges over
    // [0, n-1], which is exactly the valid insertion range for the
    // shortened (n-1)-length array; j ≠ i guarantees a real change.
    return { kind: "block", start: i, len: 1, insertAt: j };
  }
  if (roll < 0.85) {
    return { kind: "reverse", lo: Math.min(i, j), hi: Math.max(i, j) };
  }
  // Or-opt: block length 2–4, clamped so at least one track stays
  // outside the block (a full-array "block move" would be a no-op).
  const len = Math.min(2 + Math.floor(rng() * 3), n - 1);
  const start = Math.min(i, n - len);
  const insertAt = Math.floor(rng() * (n - len + 1));
  return { kind: "block", start, len, insertAt };
}

/**
 * Score delta the move would produce under the given scoring function,
 * computed incrementally from only the edges it touches.
 *
 * Because the score may be asymmetric, a reversal changes *every*
 * internal edge of the segment (each pair flips direction), so its cost
 * is O(segment length). Swap and block moves touch a constant number of
 * edges and cost O(1).
 *
 * Must be called with the same array the move was proposed against,
 * *before* `applyMove`.
 */
export function moveDelta(arr: readonly Track[], move: Move, score: ScoreFn): number {
  switch (move.kind) {
    case "swap": {
      const { i, j } = move;
      const a = arr[i]!;
      const b = arr[j]!;
      if (j === i + 1) {
        // Adjacent swap: the inner edge flips direction.
        return (
          edge(score, arr[i - 1], b) +
          score(b, a) +
          edge(score, a, arr[j + 1]) -
          edge(score, arr[i - 1], a) -
          score(a, b) -
          edge(score, b, arr[j + 1])
        );
      }
      return (
        edge(score, arr[i - 1], b) +
        edge(score, b, arr[i + 1]) +
        edge(score, arr[j - 1], a) +
        edge(score, a, arr[j + 1]) -
        edge(score, arr[i - 1], a) -
        edge(score, a, arr[i + 1]) -
        edge(score, arr[j - 1], b) -
        edge(score, b, arr[j + 1])
      );
    }

    case "reverse": {
      const { lo, hi } = move;
      // Boundary edges are replaced; every internal edge flips direction.
      let delta =
        edge(score, arr[lo - 1], arr[hi]) +
        edge(score, arr[lo], arr[hi + 1]) -
        edge(score, arr[lo - 1], arr[lo]) -
        edge(score, arr[hi], arr[hi + 1]);
      for (let k = lo; k < hi; k++) {
        delta += score(arr[k + 1]!, arr[k]!) - score(arr[k]!, arr[k + 1]!);
      }
      return delta;
    }

    case "block": {
      const { start, len, insertAt } = move;
      const blockFirst = arr[start]!;
      const blockLast = arr[start + len - 1]!;
      const left = arr[start - 1];
      const right = arr[start + len];

      // Destination neighbors, addressed in the shortened array (block
      // removed). When the destination straddles the removal gap
      // (insertAt === start), destLeft/destRight equal left/right and
      // the join and destination terms cancel — delta is 0, correctly.
      const shortLen = arr.length - len;
      const shortAt = (q: number): Track | undefined => (q < start ? arr[q] : arr[q + len]);
      const destLeft = insertAt > 0 ? shortAt(insertAt - 1) : undefined;
      const destRight = insertAt < shortLen ? shortAt(insertAt) : undefined;

      return (
        edge(score, left, right) + // join where the block was removed
        edge(score, destLeft, blockFirst) + // stitch block into destination
        edge(score, blockLast, destRight) -
        edge(score, left, blockFirst) - // old block boundary edges
        edge(score, blockLast, right) -
        edge(score, destLeft, destRight) // old destination edge
      );
    }
  }
}

/**
 * Apply the move to the array in place. Swap is O(1); reversal is
 * O(segment); block relocate is O(n) (array splice), which is a fast
 * memmove in practice.
 */
export function applyMove(arr: Track[], move: Move): void {
  switch (move.kind) {
    case "swap": {
      const { i, j } = move;
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      return;
    }
    case "reverse": {
      let { lo, hi } = move;
      while (lo < hi) {
        [arr[lo], arr[hi]] = [arr[hi]!, arr[lo]!];
        lo++;
        hi--;
      }
      return;
    }
    case "block": {
      const { start, len, insertAt } = move;
      const block = arr.splice(start, len);
      arr.splice(insertAt, 0, ...block);
      return;
    }
  }
}

import { compatibility } from "./compat.ts";
import { createRng } from "./rng.ts";
import type { Track } from "./types.ts";

/**
 * The result of sequencing a set of tracks.
 *
 *   - `tracks`      — the input tracks, reordered. Same length as input
 *     UNLESS filtering was requested via `dropBelow` (see below).
 *   - `transitions` — per-pair compatibility scores; `transitions[i]` is
 *     the score from `tracks[i]` to `tracks[i + 1]`. Always
 *     `tracks.length - 1` entries.
 *   - `totalScore`  — sum of `transitions`. Higher is better. Two
 *     sequences of the same input are directly comparable by this number.
 *   - `dropped`     — tracks excluded from the sequence by the
 *     `dropBelow` filter. Empty array when no filtering was applied.
 *     Order reflects the order in which tracks were dropped.
 */
export interface Sequence {
  tracks: Track[];
  transitions: number[];
  totalScore: number;
  dropped: Track[];
}

/**
 * Tuning knobs for the sequencer.
 *
 *   - `seed`        — explicit PRNG seed. Omit for time-based randomness
 *     (every call may produce a different ordering); supply for
 *     reproducible runs (tests, "give me that mix again").
 *   - `iterations`  — number of simulated-annealing steps. Default scales
 *     with input size and is tuned for typical setlists; raising it
 *     yields slightly better quality at proportional cost.
 *   - `dropBelow`   — if provided, iteratively drop tracks that force
 *     transitions below this threshold (in `[0, 1]`). Tracks that don't
 *     fit the flow are removed and reported in `Sequence.dropped`.
 *     Omit (or set to `undefined`) to keep every input track.
 */
export interface SequenceOptions {
  seed?: number;
  iterations?: number;
  dropBelow?: number;
}

/**
 * SA temperature at the start of the run. Large enough that early
 * iterations accept moderate-quality regressions ~50%+ of the time,
 * which lets the search escape local optima.
 */
const T_START = 0.5;

/**
 * SA temperature at the end of the run. Small enough that the final
 * iterations behave like pure greedy — no further regressions accepted.
 */
const T_END = 0.001;

/**
 * Order a list of tracks for DJ-mixing compatibility.
 *
 * Strategy:
 *   1. **Greedy warm start.** Pick a starting track (weighted toward low
 *      BPM) and repeatedly append the highest-compat next track.
 *   2. **Simulated annealing.** Propose neighbor moves (random swap or
 *      relocate), accept improvements unconditionally and regressions
 *      with probability `exp(Δ / T)`. Cool geometrically from `T_START`
 *      to `T_END`. Return the best ordering seen at any point.
 *   3. **Optional filtering.** If `options.dropBelow` is set, iteratively
 *      remove tracks that force transitions below the threshold and
 *      re-sequence the rest. Each drop chooses the endpoint of the worst
 *      transition whose removal yields the best re-sequenced total.
 *
 * Edge cases:
 *   - 0 tracks → empty sequence.
 *   - 1 track  → singleton with no transitions.
 *   - Filtering can reduce the set down to 0 or 1 tracks in extreme
 *     cases — the returned `Sequence` reflects whatever survived.
 */
export function sequence(tracks: readonly Track[], options: SequenceOptions = {}): Sequence {
  if (tracks.length === 0) return emptySequence();
  if (tracks.length === 1) {
    return { tracks: [tracks[0]!], transitions: [], totalScore: 0, dropped: [] };
  }

  if (options.dropBelow === undefined) {
    const result = sequenceCore(tracks, options);
    return { ...result, dropped: [] };
  }

  return sequenceWithDropping(tracks, options, options.dropBelow);
}

/**
 * Single sequencing pass (greedy warm start + SA, no filtering). The
 * `dropped` field is not part of this result; filtering is layered on top.
 */
function sequenceCore(
  tracks: readonly Track[],
  options: SequenceOptions,
): Omit<Sequence, "dropped"> {
  // Seed once; the same rng instance drives the warm start, the SA move
  // selection, and the Metropolis acceptance — so a single seed fully
  // reproduces a run.
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = createRng(seed);

  // SA iteration count scales as O(n²) — more tracks means more candidate
  // transitions to explore. The 100× multiplier is empirically tuned to
  // sit in the "quality plateau" for typical inputs (10–60 tracks):
  // higher values yield diminishing returns at proportional runtime cost.
  // The 2000 floor keeps tiny inputs from being under-explored.
  const iterations = options.iterations ?? Math.max(2000, tracks.length * tracks.length * 100);

  const initial = greedyConstruct(tracks, rng);
  const optimized = simulatedAnnealing(initial, iterations, rng);
  return materializeSequence(optimized);
}

/**
 * Iteration multiplier for the inner SA passes that drive drop decisions.
 *
 * The drop algorithm reacts to SA's worst transition: if SA can't find a
 * good arrangement for a particular track, that track looks like an
 * outlier and gets dropped. But "SA failed at default iteration count"
 * is very different from "this track genuinely can't fit". To avoid
 * dropping tracks that *could* fit if SA tried harder, we use a much
 * higher iteration multiplier here than the default sequencing path.
 *
 * Empirically, `n² × 500` reliably finds near-global-optimum arrangements
 * for typical setlists (10–60 tracks); higher values show diminishing
 * returns. The `50_000` floor handles tiny inputs.
 */
const DROP_ITERATION_MULTIPLIER = 500;
const DROP_ITERATION_FLOOR = 50_000;

/**
 * Iterative drop loop: sequence, find worst transition, drop the
 * better-removable endpoint, repeat until no transition is below the
 * threshold (or too few tracks remain).
 *
 * Picking which endpoint to drop is non-trivial — the outlier may be
 * either the source or the destination of the bad transition. We
 * disambiguate by trying both removals and keeping whichever produces a
 * higher re-sequenced total. That costs 2 extra sequencing passes per
 * drop, which for typical inputs (a handful of drops) is negligible.
 *
 * Each inner sequencing pass uses an elevated iteration budget (see
 * `DROP_ITERATION_MULTIPLIER`) so drop decisions are based on
 * near-global-optimum arrangements, not on SA's local-optimum noise.
 */
function sequenceWithDropping(
  tracks: readonly Track[],
  options: SequenceOptions,
  threshold: number,
): Sequence {
  let current: Track[] = tracks.slice();
  const dropped: Track[] = [];

  // Pull dropBelow out so the inner pass doesn't recurse. Also boost the
  // iteration count when the user hasn't pinned it — drop decisions
  // depend on SA finding the genuine best arrangement, not a local one.
  const innerOptions: SequenceOptions = { ...options };
  delete innerOptions.dropBelow;
  if (innerOptions.iterations === undefined) {
    innerOptions.iterations = Math.max(
      DROP_ITERATION_FLOOR,
      tracks.length * tracks.length * DROP_ITERATION_MULTIPLIER,
    );
  }

  while (current.length >= 2) {
    const result = sequenceCore(current, innerOptions);

    let worstIdx = -1;
    let worstScore = Infinity;
    for (let i = 0; i < result.transitions.length; i++) {
      if (result.transitions[i]! < worstScore) {
        worstScore = result.transitions[i]!;
        worstIdx = i;
      }
    }

    // Exit when no transitions exist OR the worst one is strictly above
    // the threshold. The threshold is *inclusive* — `--drop-below 0`
    // catches literal zero-score transitions; `--drop-below 0.3` catches
    // anything at or below 0.3.
    if (worstIdx === -1 || worstScore > threshold) {
      return { ...result, dropped };
    }

    // Try removing each endpoint of the worst transition. The endpoint
    // whose removal produces the higher re-sequenced total is the
    // outlier we want to drop.
    const fromTrack = result.tracks[worstIdx]!;
    const toTrack = result.tracks[worstIdx + 1]!;

    const withoutFrom = current.filter((t) => t !== fromTrack);
    const withoutTo = current.filter((t) => t !== toTrack);

    // Quick path: if one of the sub-sequences has < 2 tracks, just pick
    // the other — sequencing a singleton or empty is meaningless.
    let dropFrom: boolean;
    if (withoutTo.length < 2) {
      dropFrom = true;
    } else if (withoutFrom.length < 2) {
      dropFrom = false;
    } else {
      const seqWithoutFrom = sequenceCore(withoutFrom, innerOptions);
      const seqWithoutTo = sequenceCore(withoutTo, innerOptions);
      dropFrom = seqWithoutFrom.totalScore > seqWithoutTo.totalScore;
    }

    const toRemove = dropFrom ? fromTrack : toTrack;
    dropped.push(toRemove);
    current = current.filter((t) => t !== toRemove);
  }

  // Loop exit with < 2 tracks: return whatever's left.
  if (current.length === 1) {
    return {
      tracks: [current[0]!],
      transitions: [],
      totalScore: 0,
      dropped,
    };
  }
  return { tracks: [], transitions: [], totalScore: 0, dropped };
}

function emptySequence(): Sequence {
  return { tracks: [], transitions: [], totalScore: 0, dropped: [] };
}

/**
 * Choose a starting-track index, weighted toward lower BPMs.
 *
 * The lowest-BPM track is most likely to be chosen; higher BPMs taper
 * down to a `+1` floor weight (so even the fastest track has a non-zero
 * chance). SA can override this choice if a different start scores higher.
 */
function pickStartIndex(tracks: readonly Track[], rng: () => number): number {
  let maxBpm = -Infinity;
  for (const t of tracks) {
    if (t.bpm > maxBpm) maxBpm = t.bpm;
  }
  const weights = tracks.map((t) => maxBpm - t.bpm + 1);
  let total = 0;
  for (const w of weights) total += w;

  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Greedy construction. Pick a start, then repeatedly take the highest-
 * compat track from the remaining pool. Ties broken by input order.
 */
function greedyConstruct(tracks: readonly Track[], rng: () => number): Track[] {
  const remaining = tracks.slice();
  const startIdx = pickStartIndex(remaining, rng);
  const [start] = remaining.splice(startIdx, 1);
  const ordered: Track[] = [start!];

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1]!;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const score = compatibility(last, remaining[i]!);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next!);
  }

  return ordered;
}

/**
 * Simulated annealing over swap/relocate moves. Returns the best-seen
 * ordering across all iterations.
 */
function simulatedAnnealing(initial: Track[], iterations: number, rng: () => number): Track[] {
  let current = initial.slice();
  let currentScore = totalCompat(current);
  let best = current.slice();
  let bestScore = currentScore;

  const cooling = iterations > 0 ? Math.exp(Math.log(T_END / T_START) / iterations) : 1;
  let T = T_START;

  for (let iter = 0; iter < iterations; iter++) {
    const proposal = neighbor(current, rng);
    const proposalScore = totalCompat(proposal);
    const delta = proposalScore - currentScore;

    if (delta > 0 || rng() < Math.exp(delta / T)) {
      current = proposal;
      currentScore = proposalScore;
      if (currentScore > bestScore) {
        best = current.slice();
        bestScore = currentScore;
      }
    }
    T *= cooling;
  }

  return best;
}

/**
 * Generate a neighbor ordering: 50% swap two random positions, 50%
 * relocate a track from one position to another. Both preserve the
 * permutation invariant.
 */
function neighbor(arr: Track[], rng: () => number): Track[] {
  const result = arr.slice();
  const n = arr.length;
  if (n < 2) return result;

  const i = Math.floor(rng() * n);
  let j = Math.floor(rng() * n);
  while (j === i) j = Math.floor(rng() * n);

  if (rng() < 0.5) {
    [result[i], result[j]] = [result[j]!, result[i]!];
  } else {
    const [moved] = result.splice(i, 1);
    result.splice(j, 0, moved!);
  }
  return result;
}

/** Sum of pairwise compatibilities along the ordering. */
function totalCompat(tracks: readonly Track[]): number {
  let total = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    total += compatibility(tracks[i]!, tracks[i + 1]!);
  }
  return total;
}

/**
 * Materialize a final ordering into the structural Sequence shape (minus
 * the `dropped` field, which is layered on by the caller). Transitions
 * are recomputed from scratch so the exposed scores are authoritative.
 */
function materializeSequence(tracks: Track[]): Omit<Sequence, "dropped"> {
  const transitions: number[] = [];
  let total = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    const score = compatibility(tracks[i]!, tracks[i + 1]!);
    transitions.push(score);
    total += score;
  }
  return { tracks, transitions, totalScore: total };
}

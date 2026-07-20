import { compatibility, harmonicCompatibility } from "./compat.ts";
import type { ScoreFn } from "./compat.ts";
import { applyMove, moveDelta, proposeMove } from "./moves.ts";
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
 *     with input size and is tuned for best results (several seconds on
 *     typical setlists); lower it if you want speed over quality.
 *   - `dropBelow`   — if provided, iteratively drop tracks that force
 *     transitions below this threshold (in `[0, 1]`). Tracks that don't
 *     fit the flow are removed and reported in `Sequence.dropped`.
 *     Omit (or set to `undefined`) to keep every input track.
 *   - `ignoreBpm`   — sort by harmonic compatibility only. Use when the
 *     whole set will be played at a single master tempo (so every
 *     track's recorded BPM is irrelevant). Transition scores in the
 *     result are harmonic-only too, and the low-BPM start bias is
 *     replaced by a uniform random start.
 */
export interface SequenceOptions {
  seed?: number;
  iterations?: number;
  dropBelow?: number;
  ignoreBpm?: boolean;
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
 *      BPM, or uniform when `ignoreBpm` is set) and repeatedly append
 *      the highest-scoring next track. Transition scoring is
 *      `compatibility` (harmonic × tempo) or `harmonicCompatibility`
 *      when `options.ignoreBpm` is set.
 *   2. **Simulated annealing.** Propose neighbor moves (swap, relocate,
 *      2-opt segment reversal, or block relocate — see `lib/moves.ts`),
 *      score them incrementally, accept improvements unconditionally and
 *      regressions with probability `exp(Δ / T)`. Cool geometrically
 *      from `T_START` to `T_END`. Return the best ordering seen at any
 *      point.
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
 * Number of independent greedy-start + SA runs per sequencing pass. The
 * iteration budget is split evenly across restarts and the best result
 * wins.
 *
 * Restarts attack a failure mode that a bigger budget doesn't: the
 * greedy warm start picks a basin of attraction, and some basins contain
 * catastrophic seams (e.g. a 0.0-score transition) that annealing can't
 * escape once cooled — no matter how many iterations it gets. Three
 * fresh starts give three independent chances to land in a good basin,
 * at zero additional cost. Empirically (41-track real-world setlist)
 * this eliminated the occasional zero-seam output at the default budget
 * and tightened run-to-run variance.
 */
const RESTARTS = 3;

/**
 * Single sequencing pass (greedy warm start + SA with restarts, no
 * filtering). The `dropped` field is not part of this result; filtering
 * is layered on top.
 */
function sequenceCore(
  tracks: readonly Track[],
  options: SequenceOptions,
): Omit<Sequence, "dropped"> {
  // Seed once; the same rng instance drives all restarts — the warm
  // starts, the SA move selection, and the Metropolis acceptance — so a
  // single seed fully reproduces a run.
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = createRng(seed);
  const scoreFn: ScoreFn = options.ignoreBpm ? harmonicCompatibility : compatibility;

  // SA iteration count scales as O(n²) — more tracks means more candidate
  // transitions to explore. The 6000× multiplier is deliberately tuned
  // for *best results over speed*: on a 41-track real-world setlist it
  // runs in ~5s and lands within noise of the global optimum on every
  // seed, with no catastrophic seams. It's affordable because move
  // evaluation is incremental (O(edges touched), not O(n)). The 200k
  // floor keeps tiny inputs from being under-explored (they're fast
  // regardless). Pass explicit `iterations` to trade quality for speed.
  const iterations = options.iterations ?? Math.max(200_000, tracks.length * tracks.length * 6000);
  const perRestart = Math.floor(iterations / RESTARTS);

  let best: Track[] | undefined;
  let bestScore = -Infinity;
  for (let r = 0; r < RESTARTS; r++) {
    const initial = greedyConstruct(tracks, rng, scoreFn, options.ignoreBpm === true);
    const optimized = simulatedAnnealing(initial, perRestart, rng, scoreFn);
    const score = totalScore(optimized, scoreFn);
    if (score > bestScore) {
      best = optimized;
      bestScore = score;
    }
  }
  return materializeSequence(best!, scoreFn);
}

/**
 * Iterative drop loop: sequence, find worst transition, drop the
 * better-removable endpoint, repeat until no transition is below the
 * threshold (or too few tracks remain).
 *
 * Picking which endpoint to drop is non-trivial — the outlier may be
 * either the source or the destination of the bad transition. We
 * disambiguate by trying both removals and keeping whichever produces a
 * higher re-sequenced total. That costs 2 extra sequencing passes per
 * drop — expect `--drop-below` runs to take a small multiple of the
 * plain sequencing time.
 *
 * Drop decisions depend on SA finding the genuine best arrangement (a
 * track only looks like an outlier if it can't fit even in a
 * near-optimal ordering). The default iteration budget is already tuned
 * for near-optimal results, so inner passes simply use it as-is.
 */
function sequenceWithDropping(
  tracks: readonly Track[],
  options: SequenceOptions,
  threshold: number,
): Sequence {
  let current: Track[] = tracks.slice();
  const dropped: Track[] = [];

  // Pull dropBelow out so the inner pass doesn't recurse.
  const innerOptions: SequenceOptions = { ...options };
  delete innerOptions.dropBelow;

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
 * Choose a starting-track index.
 *
 * Normally weighted toward lower BPMs: the lowest-BPM track is most
 * likely to be chosen; higher BPMs taper down to a `+1` floor weight (so
 * even the fastest track has a non-zero chance). SA can override this
 * choice if a different start scores higher.
 *
 * When `ignoreBpm` is set, BPM carries no meaning, so the start is
 * uniform random instead. Either path consumes exactly one rng draw.
 */
function pickStartIndex(tracks: readonly Track[], rng: () => number, ignoreBpm: boolean): number {
  if (ignoreBpm) {
    return Math.floor(rng() * tracks.length);
  }

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
 * Greedy construction. Pick a start, then repeatedly take the
 * highest-scoring next track from the remaining pool. Ties broken by
 * input order.
 */
function greedyConstruct(
  tracks: readonly Track[],
  rng: () => number,
  scoreFn: ScoreFn,
  ignoreBpm: boolean,
): Track[] {
  const remaining = tracks.slice();
  const startIdx = pickStartIndex(remaining, rng, ignoreBpm);
  const [start] = remaining.splice(startIdx, 1);
  const ordered: Track[] = [start!];

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1]!;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const score = scoreFn(last, remaining[i]!);
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
 * How often (in iterations) to recompute the running score from scratch.
 *
 * The SA loop tracks `currentScore` by accumulating incremental move
 * deltas. Each accumulation can introduce ~1 ulp of floating-point error;
 * over millions of iterations that drift is still far below any real
 * score difference (~1e-11 vs deltas of ~1e-3), but a periodic O(n)
 * resync makes the invariant airtight for negligible cost.
 */
const RESYNC_INTERVAL = 100_000;

/**
 * Simulated annealing over the symbolic move set (swap, relocate,
 * segment reversal, block relocate — see `lib/moves.ts`). Returns the
 * best-seen ordering across all iterations.
 *
 * Move scoring is incremental: each proposal is evaluated via
 * `moveDelta` (O(edges touched)) rather than rescanning the whole
 * ordering (O(n)), and only *accepted* moves mutate the current array.
 * This is what makes the default iteration budget affordable.
 */
function simulatedAnnealing(
  initial: Track[],
  iterations: number,
  rng: () => number,
  scoreFn: ScoreFn,
): Track[] {
  if (initial.length < 2 || iterations <= 0) return initial.slice();

  const current = initial.slice();
  let currentScore = totalScore(current, scoreFn);
  let best = current.slice();
  let bestScore = currentScore;

  const cooling = Math.exp(Math.log(T_END / T_START) / iterations);
  let T = T_START;

  for (let iter = 0; iter < iterations; iter++) {
    const move = proposeMove(current.length, rng);
    const delta = moveDelta(current, move, scoreFn);

    if (delta > 0 || rng() < Math.exp(delta / T)) {
      applyMove(current, move);
      currentScore += delta;
      if (currentScore > bestScore) {
        best = current.slice();
        bestScore = currentScore;
      }
    }
    T *= cooling;

    if ((iter + 1) % RESYNC_INTERVAL === 0) {
      currentScore = totalScore(current, scoreFn);
    }
  }

  return best;
}

/** Sum of pairwise transition scores along the ordering. */
function totalScore(tracks: readonly Track[], scoreFn: ScoreFn): number {
  let total = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    total += scoreFn(tracks[i]!, tracks[i + 1]!);
  }
  return total;
}

/**
 * Materialize a final ordering into the structural Sequence shape (minus
 * the `dropped` field, which is layered on by the caller). Transitions
 * are recomputed from scratch so the exposed scores are authoritative.
 */
function materializeSequence(tracks: Track[], scoreFn: ScoreFn): Omit<Sequence, "dropped"> {
  const transitions: number[] = [];
  let total = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    const score = scoreFn(tracks[i]!, tracks[i + 1]!);
    transitions.push(score);
    total += score;
  }
  return { tracks, transitions, totalScore: total };
}

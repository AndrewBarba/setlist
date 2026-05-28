/**
 * Mulberry32: a tiny, fast, decent-quality seeded PRNG.
 *
 * Implementation by Tommy Ettinger, public domain. We pick this over
 * larger generators (xoshiro, PCG) because the sequencer doesn't need
 * cryptographic strength; it just needs reproducibility from a seed and
 * a uniform-enough distribution for the SA acceptance criterion.
 *
 * Returns a function that produces a number in `[0, 1)` on each call.
 * Same seed → identical sequence.
 *
 * The seed is masked to 32 unsigned bits, so `0` and `2³²` produce the
 * same stream (intentional — callers don't need to think about width).
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

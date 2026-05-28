import { assert, assertAlmostEquals, assertEquals, test } from "./_helpers.ts";
import { compatibility } from "../lib/compat.ts";
import { harmonicScore } from "../lib/harmonic.ts";
import { bpmScore } from "../lib/tempo.ts";
import type { Bpm, CamelotKey, Track } from "../lib/types.ts";

/**
 * Test-only Track factory. Tests own their inputs, so the brand casts on
 * `bpm` and `key` are safe; the production constructors (`normalizeKey`,
 * `normalizeBpm`) are what untrusted input must pass through.
 */
function track(partial: { title?: string; key: string; bpm: number; extended?: boolean }): Track {
  return {
    title: partial.title ?? "track",
    key: partial.key as CamelotKey,
    bpm: partial.bpm as Bpm,
    extended: partial.extended ?? false,
  };
}

test("compatibility: perfect transition (same key, same BPM)", () => {
  const a = track({ key: "8B", bpm: 128 });
  const b = track({ key: "8B", bpm: 128 });
  assertEquals(compatibility(a, b), 1.0);
});

test("compatibility: canonical Camelot move with ideal BPM bump", () => {
  // Adjacent key, +2 BPM — both at peak on their respective curves.
  // Geometric mean of (0.9, 1.0) ≈ 0.949.
  const a = track({ key: "8B", bpm: 128 });
  const b = track({ key: "9B", bpm: 130 });
  assertAlmostEquals(compatibility(a, b), Math.sqrt(0.9 * 1.0));
});

test("compatibility: opposite-side key without extended → bad", () => {
  // 1A → 7A is the maximum wheel distance (6). Harmonic = 0, so total = 0
  // regardless of tempo.
  const a = track({ key: "1A", bpm: 128 });
  const b = track({ key: "7A", bpm: 128 });
  assertEquals(compatibility(a, b), 0);
});

test("compatibility: extended next track partially discounts opposite-key match", () => {
  // Same scenario but `to.extended = true`. With the α=0.5 blend, raw
  // harmonic of 0.0 (opposite side) is blended to 0.5 (not 1.0). Tempo
  // is perfect, so total = sqrt(0.5 × 1.0) ≈ 0.707.
  const a = track({ key: "1A", bpm: 128 });
  const b = track({ key: "7A", bpm: 128, extended: true });
  assertAlmostEquals(compatibility(a, b), Math.sqrt(0.5 * 1.0));
});

test("compatibility: extended discount scales with raw harmonic", () => {
  // Same key + extended: raw 1.0, blended 1.0, total 1.0.
  const a = track({ key: "8B", bpm: 128 });
  const sameKeyExt = track({ key: "8B", bpm: 128, extended: true });
  assertEquals(compatibility(a, sameKeyExt), 1.0);

  // Adjacent key + extended: raw 0.9, blended 0.95, total = sqrt(0.95).
  const adjacentExt = track({ key: "9B", bpm: 128, extended: true });
  assertAlmostEquals(compatibility(a, adjacentExt), Math.sqrt(0.95));

  // Worst case: opposite + extended, blended floor at 0.5.
  const opposite = track({ key: "2B", bpm: 128, extended: true });
  assertAlmostEquals(compatibility(a, opposite), Math.sqrt(0.5));
});

test("compatibility: extended never makes a transition worse than non-extended", () => {
  // For any key pair at any tempo, the extended version of the incoming
  // track should score ≥ the non-extended version. The blend is one-way
  // (toward 1.0), so it can only help.
  const keys: CamelotKey[] = ["1A", "5B", "8A", "8B", "11A", "12B"];
  for (const ka of keys) {
    for (const kb of keys) {
      const from = track({ key: ka, bpm: 128 });
      const toPlain = track({ key: kb, bpm: 130 });
      const toExt = track({ key: kb, bpm: 130, extended: true });
      assert(
        compatibility(from, toExt) >= compatibility(from, toPlain),
        `${ka}→${kb}: extended (${compatibility(from, toExt)}) < plain (${compatibility(
          from,
          toPlain,
        )})`,
      );
    }
  }
});

test("compatibility: extended FROM track does NOT rescue (intent: only to.extended)", () => {
  // The escape hatch is the incoming track's intro, not the outgoing
  // track's outro. If only the outgoing track is extended, harmonic
  // stands as-is.
  const a = track({ key: "1A", bpm: 128, extended: true });
  const b = track({ key: "7A", bpm: 128, extended: false });
  assertEquals(compatibility(a, b), 0);
});

test("compatibility: BPM trend bias is preserved end-to-end", () => {
  // Two same-key transitions with mirrored BPM deltas. The +4 transition
  // should beat the -4 transition.
  const a = track({ key: "8B", bpm: 128 });
  const fasterB = track({ key: "8B", bpm: 132 });
  const slowerB = track({ key: "8B", bpm: 124 });
  const up = compatibility(a, fasterB);
  const down = compatibility(a, slowerB);
  assert(up > down, `expected up (${up}) > down (${down})`);
});

test("compatibility: half-time match is mixable but discounted", () => {
  // Same key, but 87 ↔ 174 is a D&B half/double-time pair. Folded tempo
  // score is 0.85 (perfect base × FOLDED_DISCOUNT), harmonic is 1.0.
  const a = track({ key: "8B", bpm: 87 });
  const b = track({ key: "8B", bpm: 174 });
  assertAlmostEquals(compatibility(a, b), Math.sqrt(1.0 * 0.85));
});

test("compatibility: bad on one axis drags down a perfect other axis", () => {
  // Perfect tempo, poor harmonic (2-step wheel jump).
  const a = track({ key: "8B", bpm: 128 });
  const b = track({ key: "10B", bpm: 128 });
  const score = compatibility(a, b);
  // Should be between 0 and 1, not 0 and not 1.
  assert(score > 0 && score < 1, `expected 0 < ${score} < 1`);
  // Geometric mean of (harmonic_2step, 1.0) = sqrt(harmonic_2step).
  assertAlmostEquals(score, Math.sqrt(harmonicScore("8B", "10B")));
});

test("compatibility: scoring is asymmetric in (from, to)", () => {
  // Direction matters for tempo trend. 128 → 132 should beat 132 → 128.
  const a = track({ key: "8B", bpm: 128 });
  const b = track({ key: "8B", bpm: 132 });
  const forward = compatibility(a, b);
  const reverse = compatibility(b, a);
  assert(forward > reverse, `forward (${forward}) should > reverse (${reverse})`);
});

test("compatibility: bounded in [0, 1] for arbitrary tracks", () => {
  // Sweep across realistic BPM ranges and a sample of keys.
  const keys: CamelotKey[] = ["1A", "5B", "8A", "8B", "12B"];
  for (const ka of keys) {
    for (const kb of keys) {
      for (const fromBpm of [70, 100, 128, 174]) {
        for (const toBpm of [60, 90, 130, 175]) {
          for (const ext of [false, true]) {
            const score = compatibility(
              track({ key: ka, bpm: fromBpm }),
              track({ key: kb, bpm: toBpm, extended: ext }),
            );
            assert(
              score >= 0 && score <= 1,
              `score out of range for ${ka}→${kb} ${fromBpm}→${toBpm} ext=${ext}: ${score}`,
            );
          }
        }
      }
    }
  }
});

test("compatibility: matches the underlying geometric-mean formula", () => {
  // Spot-check that the integration matches sqrt(harmonic × tempo)
  // exactly for a transition that exercises both dimensions.
  const a = track({ key: "8B", bpm: 128 });
  const b = track({ key: "9A", bpm: 131 }); // diagonal key, +3 BPM
  const expected = Math.sqrt(harmonicScore("8B", "9A") * bpmScore(a.bpm, b.bpm));
  assertAlmostEquals(compatibility(a, b), expected);
});

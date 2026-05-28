import { assert, assertAlmostEquals, assertEquals, test } from "./_helpers.ts";
import { bpmDelta, bpmScore } from "../lib/tempo.ts";
import type { Bpm } from "../lib/types.ts";

/** Cast helper — tests own their inputs, so the brand bypass is safe. */
const b = (n: number): Bpm => n as Bpm;

test("bpmDelta: direct delta when close", () => {
  assertEquals(bpmDelta(b(120), b(120)), { delta: 0, folded: false });
  assertEquals(bpmDelta(b(120), b(124)), { delta: 4, folded: false });
  assertEquals(bpmDelta(b(120), b(115)), { delta: -5, folded: false });
});

test("bpmDelta: folds via 2× for half-time tracks", () => {
  // 60 BPM treated as 120 BPM (half-time annotation) → perfect match.
  assertEquals(bpmDelta(b(120), b(60)), { delta: 0, folded: true });
  // Slight offset still folds correctly.
  assertEquals(bpmDelta(b(120), b(62)), { delta: 4, folded: true });
});

test("bpmDelta: folds via ½× for double-time tracks", () => {
  // 240 treated as 120.
  assertEquals(bpmDelta(b(120), b(240)), { delta: 0, folded: true });
  // 174 treated as 87 (D&B trick) — but from is 87, so delta is 0.
  assertEquals(bpmDelta(b(87), b(174)), { delta: 0, folded: true });
});

test("bpmDelta: prefers direct over folded when both are close", () => {
  // 120 → 121: direct delta is +1, folded would be +121 or -60.5.
  // Direct wins.
  assertEquals(bpmDelta(b(120), b(121)), { delta: 1, folded: false });
});

test("bpmScore: ideal plateau is 1.0 from 0 to +2", () => {
  assertEquals(bpmScore(b(120), b(120)), 1.0);
  assertEquals(bpmScore(b(120), b(121)), 1.0);
  assertEquals(bpmScore(b(120), b(122)), 1.0);
});

test("bpmScore: negative deltas degrade faster than positive", () => {
  // ±N comparison: negative should always be ≤ positive of same magnitude.
  for (const mag of [1, 2, 3, 4]) {
    const up = bpmScore(b(120), b(120 + mag));
    const down = bpmScore(b(120), b(120 - mag));
    assert(down <= up, `at magnitude ${mag}: down (${down}) should be ≤ up (${up})`);
  }
});

test("bpmScore: positive delta curve", () => {
  // Plateau ends at +2, then linear ramp over UP_RANGE=7 to zero at +9.
  assertEquals(bpmScore(b(120), b(122)), 1.0);
  assertAlmostEquals(bpmScore(b(120), b(123)), 1 - 1 / 7);
  assertAlmostEquals(bpmScore(b(120), b(125)), 1 - 3 / 7);
  assertAlmostEquals(bpmScore(b(120), b(129)), 0);
  // Beyond zero point stays at zero (no negative scores).
  assertEquals(bpmScore(b(120), b(200)), 0);
});

test("bpmScore: negative delta curve", () => {
  // Linear ramp over DOWN_RANGE=4 to zero at -4.
  assertAlmostEquals(bpmScore(b(120), b(119)), 1 - 1 / 4);
  assertAlmostEquals(bpmScore(b(120), b(118)), 1 - 2 / 4);
  assertAlmostEquals(bpmScore(b(120), b(116)), 0);
  // Beyond zero point stays at zero.
  assertEquals(bpmScore(b(120), b(100)), 0);
});

test("bpmScore: half/double matches score lower than direct", () => {
  // 120 ↔ 120: direct, 1.0.
  // 120 ↔ 60:  folded, should be 1.0 × FOLDED_DISCOUNT (0.85).
  assertAlmostEquals(bpmScore(b(120), b(60)), 0.85);
  assertAlmostEquals(bpmScore(b(120), b(240)), 0.85);
});

test("bpmScore: folded match with small effective delta", () => {
  // 120 ↔ 62: folded effective delta = +4 → base 1 - 2/7 ≈ 0.714,
  // then × 0.85 ≈ 0.607.
  const expected = (1 - 2 / 7) * 0.85;
  assertAlmostEquals(bpmScore(b(120), b(62)), expected);
});

test("bpmScore: bounded in [0, 1]", () => {
  // Sweep a wide range to confirm no value escapes the range.
  for (let from = 60; from <= 200; from += 10) {
    for (let to = 40; to <= 250; to += 10) {
      const score = bpmScore(b(from), b(to));
      assert(score >= 0 && score <= 1, `bpmScore(${from}, ${to}) = ${score} out of range`);
    }
  }
});

test("bpmScore: asymmetric in from/to", () => {
  // Going up from 120 to 124 should score better than going down from
  // 124 to 120, even though |delta| is identical.
  const up = bpmScore(b(120), b(124));
  const down = bpmScore(b(124), b(120));
  assert(up > down, `expected ${up} > ${down}`);
});

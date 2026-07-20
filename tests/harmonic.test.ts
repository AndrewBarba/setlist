import { assert, assertEquals, test } from "./_helpers.ts";
import { camelotDistance, harmonicScore } from "../lib/harmonic.ts";
import type { CamelotKey } from "../lib/types.ts";

/**
 * Test helper: cast a computed string to `CamelotKey` for use in loops that
 * generate keys dynamically. Tests own their inputs, so the cast is safe.
 */
const k = (s: string): CamelotKey => s as CamelotKey;

test("camelotDistance: same key", () => {
  assertEquals(camelotDistance("8B", "8B"), {
    numberDistance: 0,
    modeSwap: false,
  });
});

test("camelotDistance: mode swap (relative minor/major)", () => {
  assertEquals(camelotDistance("8B", "8A"), {
    numberDistance: 0,
    modeSwap: true,
  });
});

test("camelotDistance: adjacent on the wheel", () => {
  assertEquals(camelotDistance("8B", "9B"), {
    numberDistance: 1,
    modeSwap: false,
  });
  assertEquals(camelotDistance("8B", "7B"), {
    numberDistance: 1,
    modeSwap: false,
  });
});

test("camelotDistance: diagonal (adjacent + mode swap)", () => {
  assertEquals(camelotDistance("8B", "9A"), {
    numberDistance: 1,
    modeSwap: true,
  });
});

test("camelotDistance: wraps around the circle", () => {
  // 1 and 12 are adjacent on the wheel, not 11 apart.
  assertEquals(camelotDistance("1A", "12A"), {
    numberDistance: 1,
    modeSwap: false,
  });
  assertEquals(camelotDistance("1B", "12A"), {
    numberDistance: 1,
    modeSwap: true,
  });
  // 11 ↔ 2 wraps: shortest distance is 3.
  assertEquals(camelotDistance("11A", "2A"), {
    numberDistance: 3,
    modeSwap: false,
  });
});

test("camelotDistance: opposite side of the wheel", () => {
  // 1 ↔ 7 is the maximum (6 either direction).
  assertEquals(camelotDistance("1A", "7A"), {
    numberDistance: 6,
    modeSwap: false,
  });
  assertEquals(camelotDistance("1B", "7A"), {
    numberDistance: 6,
    modeSwap: true,
  });
});

test("camelotDistance: is symmetric", () => {
  // The metric must satisfy d(a, b) == d(b, a).
  const pairs: Array<
    [Parameters<typeof camelotDistance>[0], Parameters<typeof camelotDistance>[1]]
  > = [
    ["8B", "9A"],
    ["1A", "12B"],
    ["5A", "11B"],
    ["3B", "10A"],
  ];
  for (const [a, b] of pairs) {
    assertEquals(camelotDistance(a, b), camelotDistance(b, a));
  }
});

test("harmonicScore: canonical Camelot moves", async (t) => {
  await t.test("identical key → 1.0", () => {
    assertEquals(harmonicScore("8B", "8B"), 1.0);
    assertEquals(harmonicScore("1A", "1A"), 1.0);
  });

  await t.test("relative minor/major → 0.9", () => {
    assertEquals(harmonicScore("8B", "8A"), 0.9);
    assertEquals(harmonicScore("12A", "12B"), 0.9);
  });

  await t.test("adjacent on wheel (perfect 5th/4th) → 0.9", () => {
    assertEquals(harmonicScore("8B", "9B"), 0.9);
    assertEquals(harmonicScore("8B", "7B"), 0.9);
    assertEquals(harmonicScore("1A", "12A"), 0.9); // wraps
  });
});

test("harmonicScore: energy boost mixes (+2 and −5 ≡ +7)", async (t) => {
  // Mixed In Key's directional "Energy Boost" techniques. Both raise the
  // sounding pitch of the incoming track — a deliberate energy lift:
  //   +2  → whole tone up (the primary energy boost, e.g. 5A → 7A)
  //   −5  → semitone up   (the "Armin Van Buuren variation", ≡ +7)

  await t.test("add 2, same ring → 0.7", () => {
    assertEquals(harmonicScore("5A", "7A"), 0.7); // MIK's tutorial example
    assertEquals(harmonicScore("8A", "10A"), 0.7);
    assertEquals(harmonicScore("8B", "10B"), 0.7); // works on major ring too
  });

  await t.test("subtract 5, same ring → 0.7", () => {
    assertEquals(harmonicScore("8A", "3A"), 0.7);
    assertEquals(harmonicScore("12A", "7A"), 0.7); // Armin, Ultra 2017
    assertEquals(harmonicScore("8B", "3B"), 0.7); // works on major ring too
  });

  await t.test("wraps around the wheel", () => {
    // −5: 3 − 5 = −2 ≡ 10; equivalently 3 + 7 = 10.
    assertEquals(harmonicScore("3A", "10A"), 0.7);
    assertEquals(harmonicScore("1B", "8B"), 0.7);
    // +2: 11 + 2 = 13 ≡ 1; 12 + 2 = 14 ≡ 2.
    assertEquals(harmonicScore("11B", "1B"), 0.7);
    assertEquals(harmonicScore("12A", "2A"), 0.7);
  });

  await t.test("directional: reverses are pitch drops, not boosts", () => {
    // 3A → 8A drops a semitone — keeps its near-zero table score.
    assertEquals(harmonicScore("3A", "8A"), 0.05);
    assertEquals(harmonicScore("7A", "12A"), 0.05);
    // 7A → 5A drops a whole tone — keeps its workable-but-meh table score.
    assertEquals(harmonicScore("7A", "5A"), 0.45);
    assertEquals(harmonicScore("10B", "8B"), 0.45);
  });

  await t.test("same ring only: mode swap is not the documented move", () => {
    assertEquals(harmonicScore("8A", "3B"), 0.02);
    assertEquals(harmonicScore("8B", "3A"), 0.02);
    assertEquals(harmonicScore("5A", "7B"), 0.25);
    assertEquals(harmonicScore("5B", "7A"), 0.25);
  });

  await t.test("ranks between diagonal and canonical moves", () => {
    for (const boost of [harmonicScore("8A", "3A"), harmonicScore("5A", "7A")]) {
      const diagonal = harmonicScore("8B", "9A");
      const adjacent = harmonicScore("8A", "9A");
      assert(
        diagonal < boost && boost < adjacent,
        `expected diagonal (${diagonal}) < boost (${boost}) < adjacent (${adjacent})`,
      );
    }
  });
});

test("harmonicScore: non-canonical moves degrade", async (t) => {
  await t.test("diagonal (adjacent + mode swap) — workable", () => {
    const s = harmonicScore("8B", "9A");
    assert(s > 0.5 && s < 0.7, `expected 0.5–0.7, got ${s}`);
  });

  await t.test("2-step same mode, downward — workable but non-canonical", () => {
    // Counterclockwise (−2, a whole-tone drop): NOT the energy boost —
    // that's the clockwise +2 direction, covered in the boost tests.
    const s = harmonicScore("8B", "6B");
    assert(s > 0.3 && s < 0.6, `expected 0.3–0.6, got ${s}`);
  });

  await t.test("opposite side — effectively unmixable", () => {
    assertEquals(harmonicScore("1A", "7A"), 0.0);
    assertEquals(harmonicScore("1B", "7A"), 0.0);
  });
});

test("harmonicScore: monotonic falloff as distance grows", () => {
  // For same-mode pairs, score should weakly decrease as numberDistance
  // increases. We use weak (≤) rather than strict (<) because the table
  // is allowed to plateau at 0.0 for the largest distances.
  //
  // This probes clockwise steps +1..+6. The +2 energy-boost override
  // (0.7) sits on this path but preserves monotonicity (0.9 ≥ 0.7 ≥
  // 0.25). The −5/+7 boost is NOT on this path — it's distance 5 the
  // *other* way around; the d=5 probe here (+5, a semitone drop) keeps
  // its table score. See the energy boost tests above.
  const sameModeScores = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const target = k(`${((8 + d - 1) % 12) + 1}B`);
    return harmonicScore("8B", target);
  });
  for (let i = 1; i < sameModeScores.length; i++) {
    assert(
      sameModeScores[i]! <= sameModeScores[i - 1]!,
      `scores not monotonic: ${JSON.stringify(sameModeScores)}`,
    );
  }
});

test("harmonicScore: mode swap penalizes versus same-mode at same distance", () => {
  // Mode swap should reduce the score at every wheel distance except 0
  // (where the swap *is* the move — relative minor/major — and is still
  // very compatible).
  for (let d = 1; d <= 6; d++) {
    const n = ((8 + d - 1) % 12) + 1;
    const sameMode = harmonicScore("8B", k(`${n}B`));
    const swapMode = harmonicScore("8B", k(`${n}A`));
    assert(
      swapMode <= sameMode,
      `at distance ${d}: swap (${swapMode}) should be ≤ same (${sameMode})`,
    );
  }
});

test("harmonicScore: bounded in [0, 1]", () => {
  // Spot-check every position to confirm no value escapes the range.
  for (let n = 1; n <= 12; n++) {
    for (const m of ["A", "B"] as const) {
      const key = k(`${n}${m}`);
      const score = harmonicScore("8B", key);
      assert(score >= 0 && score <= 1, `score for 8B → ${key} out of range: ${score}`);
    }
  }
});

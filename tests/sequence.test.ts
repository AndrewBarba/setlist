import { assert, assertAlmostEquals, assertEquals, test } from "./_helpers.ts";
import { sequence } from "../lib/sequence.ts";
import { compatibility } from "../lib/compat.ts";
import type { Bpm, CamelotKey, Track } from "../lib/types.ts";

/** Test-only Track factory; cast helpers explained in compat.test.ts. */
function track(partial: { title?: string; key: string; bpm: number; extended?: boolean }): Track {
  return {
    title: partial.title ?? `${partial.key}@${partial.bpm}`,
    key: partial.key as CamelotKey,
    bpm: partial.bpm as Bpm,
    extended: partial.extended ?? false,
  };
}

test("sequence: empty input → empty sequence", () => {
  assertEquals(sequence([]), {
    tracks: [],
    transitions: [],
    totalScore: 0,
    dropped: [],
  });
});

test("sequence: single track → singleton with no transitions", () => {
  const t = track({ title: "Alone", key: "8B", bpm: 128 });
  const result = sequence([t]);
  assertEquals(result.tracks, [t]);
  assertEquals(result.transitions, []);
  assertEquals(result.totalScore, 0);
  assertEquals(result.dropped, []);
});

test("sequence: two tracks — picks the better ordering", () => {
  // a → b is a +5 BPM lift (good); b → a is -5 (bad). SA should pick a → b.
  const a = track({ title: "low", key: "8B", bpm: 120 });
  const b = track({ title: "high", key: "8B", bpm: 125 });
  const result = sequence([b, a], { seed: 1 });
  assertEquals(
    result.tracks.map((t) => t.title),
    ["low", "high"],
  );
});

test("sequence: preserves the input set (no dups, no losses)", () => {
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 122 }),
    track({ title: "b", key: "9B", bpm: 124 }),
    track({ title: "c", key: "10B", bpm: 126 }),
    track({ title: "d", key: "11B", bpm: 128 }),
    track({ title: "e", key: "12B", bpm: 130 }),
  ];
  const result = sequence(tracks, { seed: 7 });

  assertEquals(result.tracks.length, tracks.length);
  const inputTitles = new Set(tracks.map((t) => t.title));
  const outputTitles = new Set(result.tracks.map((t) => t.title));
  assertEquals(outputTitles, inputTitles);
});

test("sequence: transitions and totalScore are internally consistent", () => {
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 122 }),
    track({ title: "b", key: "9B", bpm: 124 }),
    track({ title: "c", key: "10B", bpm: 126 }),
    track({ title: "d", key: "11B", bpm: 128 }),
  ];
  const result = sequence(tracks, { seed: 1 });

  // transitions length
  assertEquals(result.transitions.length, result.tracks.length - 1);

  // Each transition matches the direct compatibility call.
  for (let i = 0; i < result.transitions.length; i++) {
    const expected = compatibility(result.tracks[i]!, result.tracks[i + 1]!);
    assertAlmostEquals(result.transitions[i]!, expected);
  }

  // totalScore is the sum.
  const sum = result.transitions.reduce((a, b) => a + b, 0);
  assertAlmostEquals(result.totalScore, sum);
});

test("sequence: deterministic with explicit seed", () => {
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 122 }),
    track({ title: "b", key: "9B", bpm: 124 }),
    track({ title: "c", key: "10B", bpm: 126 }),
    track({ title: "d", key: "11B", bpm: 128 }),
    track({ title: "e", key: "12B", bpm: 130 }),
    track({ title: "f", key: "1B", bpm: 132 }),
  ];

  const r1 = sequence(tracks, { seed: 42 });
  const r2 = sequence(tracks, { seed: 42 });

  assertEquals(
    r1.tracks.map((t) => t.title),
    r2.tracks.map((t) => t.title),
  );
  assertEquals(r1.totalScore, r2.totalScore);
});

test("sequence: ambiguous input → seeds explore different orderings", () => {
  // For inputs with a UNIQUE optimum, all seeds correctly converge to
  // the same answer — that's the algorithm working, not failing. To
  // observe seed-driven variety, we need genuine ambiguity: two groups
  // of within-group-identical tracks, so any ordering inside a group
  // is equally good. With strict best-tracking, the first optimum found
  // wins, and the seed-driven warm start determines that.
  const tracks: Track[] = [
    track({ title: "a1", key: "8B", bpm: 120 }),
    track({ title: "a2", key: "8B", bpm: 120 }),
    track({ title: "a3", key: "8B", bpm: 120 }),
    track({ title: "b1", key: "9B", bpm: 122 }),
    track({ title: "b2", key: "9B", bpm: 122 }),
    track({ title: "b3", key: "9B", bpm: 122 }),
  ];

  const orderings = new Set<string>();
  for (let seed = 0; seed < 20; seed++) {
    const r = sequence(tracks, { seed });
    orderings.add(r.tracks.map((t) => t.title).join(","));
  }
  assert(
    orderings.size >= 2,
    `expected ≥2 distinct orderings across 20 seeds, got ${orderings.size}`,
  );
});

test("sequence: beats the reverse-BPM ordering", () => {
  // A monotonically descending BPM ordering is the pathological worst
  // case for our trending-up tempo scoring. The sequencer must always
  // do strictly better.
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 130 }),
    track({ title: "b", key: "8B", bpm: 128 }),
    track({ title: "c", key: "8B", bpm: 126 }),
    track({ title: "d", key: "8B", bpm: 124 }),
    track({ title: "e", key: "8B", bpm: 122 }),
    track({ title: "f", key: "8B", bpm: 120 }),
  ];

  // Reverse-BPM score (input order is already descending).
  let descScore = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    descScore += compatibility(tracks[i]!, tracks[i + 1]!);
  }

  const result = sequence(tracks, { seed: 3 });
  assert(
    result.totalScore > descScore,
    `sequencer score ${result.totalScore} did not beat descending ${descScore}`,
  );
});

test("sequence: BPM generally trends up", () => {
  // For a set of monotone-BPM tracks with compatible keys, the result
  // should be (close to) BPM-sorted. We allow 1 inversion as slack —
  // SA is stochastic.
  const tracks: Track[] = [
    track({ title: "120", key: "8B", bpm: 120 }),
    track({ title: "122", key: "8B", bpm: 122 }),
    track({ title: "124", key: "8B", bpm: 124 }),
    track({ title: "126", key: "8B", bpm: 126 }),
    track({ title: "128", key: "8B", bpm: 128 }),
    track({ title: "130", key: "8B", bpm: 130 }),
  ];
  const result = sequence(tracks, { seed: 11 });
  const bpms = result.tracks.map((t) => t.bpm);

  let inversions = 0;
  for (let i = 0; i < bpms.length - 1; i++) {
    if (bpms[i]! > bpms[i + 1]!) inversions++;
  }
  assert(inversions <= 1, `expected BPMs to trend up (≤1 inversion), got ${inversions}: ${bpms}`);
});

test("sequence: extended bridges harmonic chasms", () => {
  // 1A and 7A are opposite-side (max harmonic distance). Without the
  // extended escape hatch, sequencing them together is bad. With an
  // extended bridge track between them, the total improves.
  const a = track({ title: "a", key: "1A", bpm: 124 });
  const b = track({ title: "b", key: "7A", bpm: 128 }); // far from a
  const bridge = track({
    title: "bridge",
    key: "7A",
    bpm: 126,
    extended: true,
  });

  const withBridge = sequence([a, bridge, b], { seed: 5 });
  const withoutBridge = sequence([a, b], { seed: 5 });

  // The bridge transitions should both be "passable" — i.e. the run
  // with the bridge should produce sensible per-pair scores. Specifically:
  //   - a → bridge: bridge.extended makes harmonic = 1.0 regardless of
  //     a.key vs bridge.key, so this should be high.
  //   - bridge → b: bridge.key matches b.key exactly, so harmonic = 1.0.
  assertEquals(withBridge.transitions.length, 2);
  for (const t of withBridge.transitions) {
    assert(t > 0.5, `bridge transition unexpectedly low: ${t}`);
  }

  // And the standalone 2-track case (a → b directly) scores at zero
  // for the harmonic dimension, dragging the geometric mean to zero.
  assertEquals(withoutBridge.transitions.length, 1);
  assertEquals(withoutBridge.transitions[0], 0);
});

test("sequence: bounded scores in [0, n-1]", () => {
  const tracks: Track[] = Array.from({ length: 10 }, (_, i) =>
    track({
      title: `t${i}`,
      key: ((i % 12) + 1 + "B") as CamelotKey,
      bpm: 120 + (i % 5) * 2,
    }),
  );
  const result = sequence(tracks, { seed: 99 });

  // Each transition in [0, 1], so totalScore in [0, n-1].
  for (const t of result.transitions) {
    assert(t >= 0 && t <= 1, `transition out of range: ${t}`);
  }
  assert(
    result.totalScore >= 0 && result.totalScore <= tracks.length - 1,
    `totalScore ${result.totalScore} out of [0, ${tracks.length - 1}]`,
  );
});

test("sequence: respects iterations=0 (returns greedy result)", () => {
  // With 0 iterations, SA never runs and we get the greedy warm-start
  // ordering. That's still a valid sequence; we just check it's well-formed.
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 120 }),
    track({ title: "b", key: "9B", bpm: 122 }),
    track({ title: "c", key: "10B", bpm: 124 }),
  ];
  const result = sequence(tracks, { seed: 1, iterations: 0 });
  assertEquals(result.tracks.length, 3);
  assertEquals(result.transitions.length, 2);
});

test("sequence: ignoreBpm sorts by key only", () => {
  // A harmonic chain 8B → 9B → 10B → 11B whose BPMs are deliberately
  // hostile to it (big drops and jumps). With BPM in play, the chain is
  // torn apart; with ignoreBpm, the wheel walk should win and every
  // transition should score as a pure harmonic move (≥ 0.9).
  const tracks: Track[] = [
    track({ title: "c", key: "10B", bpm: 175 }),
    track({ title: "a", key: "8B", bpm: 128 }),
    track({ title: "d", key: "11B", bpm: 90 }),
    track({ title: "b", key: "9B", bpm: 70 }),
  ];
  const result = sequence(tracks, { seed: 1, ignoreBpm: true });

  for (const t of result.transitions) {
    assert(t >= 0.9, `expected pure harmonic transitions ≥ 0.9, got ${t}`);
  }
  const keys = result.tracks.map((t) => t.key).join(",");
  assert(
    keys === "8B,9B,10B,11B" || keys === "11B,10B,9B,8B",
    `expected a wheel walk, got ${keys}`,
  );
});

test("sequence: ignoreBpm transition scores are harmonic-only", () => {
  // Identical keys, terrible BPM transition — with ignoreBpm the
  // reported transition must be 1.0 (BPM must not leak into output).
  const a = track({ title: "a", key: "8B", bpm: 128 });
  const b = track({ title: "b", key: "8B", bpm: 80 });
  const result = sequence([a, b], { seed: 1, ignoreBpm: true });
  assertEquals(result.transitions, [1.0]);
  assertEquals(result.totalScore, 1.0);
});

test("sequence: ignoreBpm still respects dropBelow (harmonic outlier)", () => {
  // Cluster around 8B, plus a 2A outlier. 2A is opposite-side (0.0)
  // against 8B/8A, and distance-5-with-mode-swap (0.02) against 9B in
  // both directions — the mode swap rules out an energy-boost rescue
  // (2B → 9B would be the +7 boost at 0.7 and would NOT be droppable).
  // BPMs are all identical so only harmonics can trigger the drop.
  const cluster: Track[] = [
    track({ title: "c1", key: "8B", bpm: 124 }),
    track({ title: "c2", key: "8A", bpm: 124 }),
    track({ title: "c3", key: "9B", bpm: 124 }),
  ];
  const outlier = track({ title: "outlier", key: "2A", bpm: 124 });

  const result = sequence([...cluster, outlier], {
    seed: 3,
    ignoreBpm: true,
    dropBelow: 0.3,
  });
  assertEquals(result.dropped.length, 1);
  assertEquals(result.dropped[0]!.title, "outlier");
});

test("sequence: dropped is empty when no filtering requested", () => {
  const tracks: Track[] = [
    track({ title: "a", key: "8B", bpm: 120 }),
    track({ title: "b", key: "9B", bpm: 122 }),
  ];
  assertEquals(sequence(tracks, { seed: 1 }).dropped, []);
});

test("sequence: dropBelow removes outlier that forces bad transition", () => {
  // A 122–135 BPM cluster plus one outlier at 80 BPM. Any placement of
  // the outlier forces a huge tempo drop somewhere. With dropBelow=0.3,
  // it should be excised.
  const cluster: Track[] = [
    track({ title: "c1", key: "8B", bpm: 122 }),
    track({ title: "c2", key: "9B", bpm: 125 }),
    track({ title: "c3", key: "10B", bpm: 128 }),
    track({ title: "c4", key: "11B", bpm: 132 }),
    track({ title: "c5", key: "12B", bpm: 135 }),
  ];
  const outlier = track({ title: "outlier", key: "8B", bpm: 80 });

  const result = sequence([...cluster, outlier], {
    seed: 7,
    dropBelow: 0.3,
  });

  // Outlier should be dropped; cluster should be sequenced.
  assertEquals(result.dropped.length, 1);
  assertEquals(result.dropped[0]!.title, "outlier");
  assertEquals(result.tracks.length, cluster.length);
});

test("sequence: dropBelow disabled (undefined) keeps every track", () => {
  const cluster: Track[] = [
    track({ title: "c1", key: "8B", bpm: 122 }),
    track({ title: "c2", key: "9B", bpm: 125 }),
  ];
  const outlier = track({ title: "outlier", key: "8B", bpm: 80 });

  const result = sequence([...cluster, outlier], { seed: 7 });
  assertEquals(result.dropped, []);
  assertEquals(result.tracks.length, 3);
});

test("sequence: dropBelow=0 only removes literal zero-score transitions", () => {
  // Cluster of compatible tracks plus an outlier whose BPM has no clean
  // half/double fold match against the cluster (60 BPM would fold to 120
  // and *not* be an outlier; 90 BPM has no fold and stays bad).
  const cluster: Track[] = [
    track({ title: "c1", key: "8B", bpm: 122 }),
    track({ title: "c2", key: "9B", bpm: 125 }),
    track({ title: "c3", key: "10B", bpm: 128 }),
  ];
  const outlier = track({ title: "outlier", key: "8B", bpm: 90 });

  const result = sequence([...cluster, outlier], {
    seed: 1,
    dropBelow: 0,
  });
  // The outlier creates a tempo-zero transition; should be dropped.
  assertEquals(result.dropped.length, 1);
  assertEquals(result.dropped[0]!.title, "outlier");
});

test("sequence: dropBelow preserves all properties on remaining tracks", () => {
  const tracks: Track[] = [
    track({ title: "c1", key: "8B", bpm: 122 }),
    track({ title: "c2", key: "9B", bpm: 125 }),
    track({ title: "c3", key: "10B", bpm: 128 }),
    track({ title: "outlier", key: "8B", bpm: 80 }),
  ];
  const result = sequence(tracks, { seed: 1, dropBelow: 0.3 });

  // No track should appear in both `tracks` and `dropped`.
  const sequencedTitles = new Set(result.tracks.map((t) => t.title));
  for (const d of result.dropped) {
    assert(!sequencedTitles.has(d.title), `dropped track ${d.title} also appears in sequence`);
  }

  // Every input track should appear in exactly one of the two lists.
  const allOutputTitles = new Set([
    ...result.tracks.map((t) => t.title),
    ...result.dropped.map((t) => t.title),
  ]);
  for (const t of tracks) {
    assert(allOutputTitles.has(t.title), `input track ${t.title} lost from output`);
  }
});

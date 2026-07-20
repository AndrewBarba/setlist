import { assert, assertAlmostEquals, assertEquals, test } from "./_helpers.ts";
import { applyMove, moveDelta, proposeMove } from "../lib/moves.ts";
import type { Move } from "../lib/moves.ts";
import { compatibility } from "../lib/compat.ts";
import { createRng } from "../lib/rng.ts";
import type { Bpm, CamelotKey, Track } from "../lib/types.ts";

/** Test-only Track factory; cast helpers explained in compat.test.ts. */
function track(key: string, bpm: number, extended = false): Track {
  return {
    title: `${key}@${bpm}${extended ? "x" : ""}`,
    key: key as CamelotKey,
    bpm: bpm as Bpm,
    extended,
  };
}

/** Reference implementation: full O(n) rescan. */
function totalCompat(tracks: readonly Track[]): number {
  let total = 0;
  for (let i = 0; i < tracks.length - 1; i++) {
    total += compatibility(tracks[i]!, tracks[i + 1]!);
  }
  return total;
}

/** Generate a random track list of length n from a seeded rng. */
function randomTracks(n: number, rng: () => number): Track[] {
  const out: Track[] = [];
  for (let i = 0; i < n; i++) {
    const num = 1 + Math.floor(rng() * 12);
    const mode = rng() < 0.5 ? "A" : "B";
    const bpm = 80 + Math.floor(rng() * 100);
    out.push(track(`${num}${mode}`, bpm, rng() < 0.3));
  }
  return out;
}

test("moves: moveDelta matches brute-force recompute (property)", () => {
  // The incremental delta is the correctness linchpin of the SA loop —
  // a silent error here degrades optimization without failing any
  // output invariant (final scores are recomputed at materialization).
  // Fuzz it against the O(n) reference across sizes and move kinds.
  const rng = createRng(1234);
  const sizes = [2, 3, 4, 5, 8, 13, 41];
  for (const n of sizes) {
    const tracks = randomTracks(n, rng);
    for (let trial = 0; trial < 500; trial++) {
      const move = proposeMove(n, rng);
      const before = totalCompat(tracks);
      const delta = moveDelta(tracks, move, compatibility);

      const applied = tracks.slice();
      applyMove(applied, move);
      const after = totalCompat(applied);

      assertAlmostEquals(
        delta,
        after - before,
        1e-9,
        `n=${n} trial=${trial} move=${JSON.stringify(move)}: ` +
          `incremental ${delta} vs recomputed ${after - before}`,
      );
    }
  }
});

test("moves: applyMove preserves the permutation invariant (property)", () => {
  const rng = createRng(99);
  for (const n of [2, 3, 7, 20]) {
    const tracks = randomTracks(n, rng);
    const arr = tracks.slice();
    for (let trial = 0; trial < 300; trial++) {
      applyMove(arr, proposeMove(n, rng));
    }
    assertEquals(arr.length, n);
    // Same multiset of track references.
    const expected = new Set(tracks);
    for (const t of arr) {
      assert(expected.has(t), `track ${t.title} not from the input set`);
    }
    assertEquals(new Set(arr).size, n);
  }
});

test("moves: proposeMove only produces in-bounds, non-degenerate moves", () => {
  const rng = createRng(7);
  for (const n of [2, 3, 4, 10]) {
    for (let trial = 0; trial < 2000; trial++) {
      const m = proposeMove(n, rng);
      switch (m.kind) {
        case "swap":
          assert(m.i >= 0 && m.j < n && m.i < m.j, `bad swap ${JSON.stringify(m)} for n=${n}`);
          break;
        case "reverse":
          assert(
            m.lo >= 0 && m.hi < n && m.lo < m.hi,
            `bad reverse ${JSON.stringify(m)} for n=${n}`,
          );
          break;
        case "block":
          assert(
            m.start >= 0 &&
              m.len >= 1 &&
              m.start + m.len <= n &&
              m.insertAt >= 0 &&
              m.insertAt <= n - m.len,
            `bad block ${JSON.stringify(m)} for n=${n}`,
          );
          break;
      }
    }
  }
});

test("moves: handcrafted delta cases", async (t) => {
  const a = track("8B", 120);
  const b = track("9B", 124);
  const c = track("10B", 126);
  const d = track("11B", 128);
  const arr = [a, b, c, d];

  const check = (move: Move) => {
    const before = totalCompat(arr);
    const applied = arr.slice();
    applyMove(applied, move);
    assertAlmostEquals(moveDelta(arr, move, compatibility), totalCompat(applied) - before, 1e-12);
  };

  await t.test("adjacent swap (inner edge flips direction)", () => {
    check({ kind: "swap", i: 1, j: 2 });
  });

  await t.test("swap of both endpoints", () => {
    check({ kind: "swap", i: 0, j: 3 });
  });

  await t.test("full-array reversal", () => {
    check({ kind: "reverse", lo: 0, hi: 3 });
  });

  await t.test("reverse interior segment", () => {
    check({ kind: "reverse", lo: 1, hi: 2 });
  });

  await t.test("block relocated to its own position is a no-op", () => {
    const move: Move = { kind: "block", start: 1, len: 2, insertAt: 1 };
    assertAlmostEquals(moveDelta(arr, move, compatibility), 0, 1e-12);
    const applied = arr.slice();
    applyMove(applied, move);
    assertEquals(applied, arr);
  });

  await t.test("single-track relocate to front and back", () => {
    check({ kind: "block", start: 2, len: 1, insertAt: 0 });
    check({ kind: "block", start: 0, len: 1, insertAt: 3 });
  });

  await t.test("block relocate across the array", () => {
    check({ kind: "block", start: 0, len: 2, insertAt: 2 });
    check({ kind: "block", start: 2, len: 2, insertAt: 0 });
  });
});

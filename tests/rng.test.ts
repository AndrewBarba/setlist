import { assert, assertEquals, test } from "./_helpers.ts";
import { createRng } from "../lib/rng.ts";

test("createRng: same seed produces identical sequence", () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i++) {
    assertEquals(a(), b(), `divergence at index ${i}`);
  }
});

test("createRng: different seeds produce different sequences", () => {
  const a = createRng(1);
  const b = createRng(2);
  // With extremely high probability the first few outputs differ.
  let anyDifferent = false;
  for (let i = 0; i < 10; i++) {
    if (a() !== b()) {
      anyDifferent = true;
      break;
    }
  }
  assert(anyDifferent, "two different seeds produced identical first 10 outputs");
});

test("createRng: output is in [0, 1)", () => {
  const rng = createRng(12345);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert(v >= 0 && v < 1, `value ${v} out of [0, 1)`);
  }
});

test("createRng: rough uniformity across 10 buckets", () => {
  const rng = createRng(0xdeadbeef);
  const buckets = new Array(10).fill(0);
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const v = rng();
    buckets[Math.floor(v * 10)] += 1;
  }
  const expected = N / 10;
  for (let i = 0; i < 10; i++) {
    // Allow ±20% deviation per bucket — generous for 10k samples but
    // catches catastrophic non-uniformity.
    const ratio = buckets[i] / expected;
    assert(
      ratio > 0.8 && ratio < 1.2,
      `bucket ${i} has ${buckets[i]} samples (ratio ${ratio.toFixed(2)})`,
    );
  }
});

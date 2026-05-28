import { assert, assertEquals, assertFalse, assertThrows, test } from "./_helpers.ts";
import { isBpm, normalizeBpm } from "../lib/bpm.ts";

test("normalizeBpm: numeric input", async (t) => {
  await t.test("accepts integers", () => {
    assertEquals(normalizeBpm(128), 128);
    assertEquals(normalizeBpm(60), 60);
    assertEquals(normalizeBpm(174), 174);
  });

  await t.test("accepts floats", () => {
    assertEquals(normalizeBpm(128.5), 128.5);
    assertEquals(normalizeBpm(140.25), 140.25);
  });

  await t.test("accepts boundary values", () => {
    assertEquals(normalizeBpm(40), 40);
    assertEquals(normalizeBpm(250), 250);
  });

  await t.test("rejects below minimum", () => {
    assertThrows(() => normalizeBpm(39.99), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm(0), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm(-128), Error, "Invalid BPM");
  });

  await t.test("rejects above maximum", () => {
    assertThrows(() => normalizeBpm(250.01), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm(500), Error, "Invalid BPM");
  });

  await t.test("rejects NaN and Infinity", () => {
    assertThrows(() => normalizeBpm(NaN), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm(Infinity), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm(-Infinity), Error, "Invalid BPM");
  });
});

test("normalizeBpm: string input", async (t) => {
  await t.test("accepts plain integer strings", () => {
    assertEquals(normalizeBpm("128"), 128);
    assertEquals(normalizeBpm("60"), 60);
  });

  await t.test("accepts decimal strings", () => {
    assertEquals(normalizeBpm("128.5"), 128.5);
    assertEquals(normalizeBpm("128.50"), 128.5);
    assertEquals(normalizeBpm("174.99"), 174.99);
  });

  await t.test("accepts unit suffix", () => {
    assertEquals(normalizeBpm("128 BPM"), 128);
    assertEquals(normalizeBpm("128bpm"), 128);
    assertEquals(normalizeBpm("128 bpm"), 128);
    assertEquals(normalizeBpm("128.5 BPM"), 128.5);
    assertEquals(normalizeBpm("174 Bpm"), 174);
  });

  await t.test("trims surrounding whitespace", () => {
    assertEquals(normalizeBpm("  128  "), 128);
    assertEquals(normalizeBpm("\t128\n"), 128);
    assertEquals(normalizeBpm("  128 BPM  "), 128);
  });

  await t.test("rejects empty and whitespace-only", () => {
    assertThrows(() => normalizeBpm(""), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("   "), Error, "Invalid BPM");
  });

  await t.test("rejects non-numeric strings", () => {
    assertThrows(() => normalizeBpm("abc"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("fast"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("128 fast"), Error, "Invalid BPM");
  });

  await t.test("rejects signed values", () => {
    assertThrows(() => normalizeBpm("+128"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("-128"), Error, "Invalid BPM");
  });

  await t.test("rejects scientific notation", () => {
    assertThrows(() => normalizeBpm("1.28e2"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("1e2"), Error, "Invalid BPM");
  });

  await t.test("rejects comma decimal separator", () => {
    // Locale-dependent and ambiguous (thousands vs decimal); we want one
    // canonical input format.
    assertThrows(() => normalizeBpm("128,5"), Error, "Invalid BPM");
  });

  await t.test("rejects bare decimal point", () => {
    assertThrows(() => normalizeBpm(".5"), Error, "Invalid BPM");
  });

  await t.test("rejects out-of-range string values", () => {
    assertThrows(() => normalizeBpm("39"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("500"), Error, "Invalid BPM");
    assertThrows(() => normalizeBpm("0"), Error, "Invalid BPM");
  });

  await t.test("error message includes the input", () => {
    try {
      normalizeBpm("nope");
      throw new Error("should have thrown");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      assert(err.message.includes('"nope"'), "error should include input");
    }
  });
});

test("isBpm: type guard", async (t) => {
  await t.test("accepts in-range finite numbers", () => {
    assert(isBpm(128));
    assert(isBpm(40));
    assert(isBpm(250));
    assert(isBpm(174.5));
  });

  await t.test("rejects out-of-range numbers", () => {
    assertFalse(isBpm(39));
    assertFalse(isBpm(251));
    assertFalse(isBpm(0));
    assertFalse(isBpm(-1));
  });

  await t.test("rejects non-finite numbers", () => {
    assertFalse(isBpm(NaN));
    assertFalse(isBpm(Infinity));
    assertFalse(isBpm(-Infinity));
  });

  await t.test("narrows number to Bpm", () => {
    const raw: number = 128;
    if (isBpm(raw)) {
      // Compile-time check: raw is now Bpm and usable as such.
      const narrowed: number = raw;
      assertEquals(narrowed, 128);
    } else {
      throw new Error("expected 128 to be a valid BPM");
    }
  });
});

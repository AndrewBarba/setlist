import { assertEquals, assertThrows, test } from "./_helpers.ts";
import { normalizeKey } from "../lib/key.ts";
import type { CamelotKey } from "../lib/types.ts";

test("normalizeKey: Camelot passthrough", async (t) => {
  await t.test("returns already-canonical input unchanged", () => {
    assertEquals(normalizeKey("8A"), "8A");
    assertEquals(normalizeKey("12B"), "12B");
    assertEquals(normalizeKey("1A"), "1A");
  });

  await t.test("uppercases the mode letter", () => {
    assertEquals(normalizeKey("8a"), "8A");
    assertEquals(normalizeKey("12b"), "12B");
  });

  await t.test("trims surrounding whitespace", () => {
    assertEquals(normalizeKey("  8A  "), "8A");
    assertEquals(normalizeKey("\t12b\n"), "12B");
  });
});

test("normalizeKey: classical major keys (full wheel)", async (t) => {
  // Each entry: [primary spelling, enharmonic spelling, expected Camelot].
  // Enharmonic is null for naturals (C, D, E, F, G, A, B have no common
  // alternative spelling in this context).
  const cases: ReadonlyArray<readonly [string, string | null, CamelotKey]> = [
    ["C", null, "8B"],
    ["C#", "Db", "3B"],
    ["D", null, "10B"],
    ["D#", "Eb", "5B"],
    ["E", null, "12B"],
    ["F", null, "7B"],
    ["F#", "Gb", "2B"],
    ["G", null, "9B"],
    ["G#", "Ab", "4B"],
    ["A", null, "11B"],
    ["A#", "Bb", "6B"],
    ["B", null, "1B"],
  ];

  for (const [primary, enharmonic, camelot] of cases) {
    await t.test(`${primary} major → ${camelot}`, () => {
      assertEquals(normalizeKey(primary), camelot);
      assertEquals(normalizeKey(`${primary} major`), camelot);
      assertEquals(normalizeKey(`${primary} maj`), camelot);
      assertEquals(normalizeKey(`${primary}M`), camelot);
    });

    if (enharmonic) {
      await t.test(`${enharmonic} major → ${camelot} (enharmonic)`, () => {
        assertEquals(normalizeKey(enharmonic), camelot);
        assertEquals(normalizeKey(`${enharmonic} major`), camelot);
      });
    }
  }
});

test("normalizeKey: classical minor keys (full wheel)", async (t) => {
  const cases: ReadonlyArray<readonly [string, string | null, CamelotKey]> = [
    ["C", null, "5A"],
    ["C#", "Db", "12A"],
    ["D", null, "7A"],
    ["D#", "Eb", "2A"],
    ["E", null, "9A"],
    ["F", null, "4A"],
    ["F#", "Gb", "11A"],
    ["G", null, "6A"],
    ["G#", "Ab", "1A"],
    ["A", null, "8A"],
    ["A#", "Bb", "3A"],
    ["B", null, "10A"],
  ];

  for (const [primary, enharmonic, camelot] of cases) {
    await t.test(`${primary} minor → ${camelot}`, () => {
      assertEquals(normalizeKey(`${primary}m`), camelot);
      assertEquals(normalizeKey(`${primary} minor`), camelot);
      assertEquals(normalizeKey(`${primary} min`), camelot);
    });

    if (enharmonic) {
      await t.test(`${enharmonic} minor → ${camelot} (enharmonic)`, () => {
        assertEquals(normalizeKey(`${enharmonic}m`), camelot);
        assertEquals(normalizeKey(`${enharmonic} minor`), camelot);
      });
    }
  }
});

test("normalizeKey: relative major/minor share a Camelot number", () => {
  // C major and A minor are relatives → both at position 8.
  assertEquals(normalizeKey("C")[0], normalizeKey("Am")[0]);
  // G major and E minor → position 9.
  assertEquals(normalizeKey("G")[0], normalizeKey("Em")[0]);
  // D major and B minor → position 10.
  assertEquals(normalizeKey("D")[0], normalizeKey("Bm")[0]);
  // F# major and D# minor → position 2 (enharmonic Gb / Eb).
  assertEquals(normalizeKey("F#"), "2B");
  assertEquals(normalizeKey("D#m"), "2A");
  assertEquals(normalizeKey("Ebm"), "2A");
});

test("normalizeKey: notation edge cases", async (t) => {
  await t.test("disambiguates Bb / Bm / Bbm correctly", () => {
    assertEquals(normalizeKey("Bb"), "6B"); // B-flat major
    assertEquals(normalizeKey("Bm"), "10A"); // B minor
    assertEquals(normalizeKey("Bbm"), "3A"); // B-flat minor
  });

  await t.test("uppercase M means major (chord shorthand)", () => {
    assertEquals(normalizeKey("CM"), "8B");
    assertEquals(normalizeKey("AM"), "11B");
  });

  await t.test("lowercase m means minor", () => {
    assertEquals(normalizeKey("Cm"), "5A");
    assertEquals(normalizeKey("Am"), "8A");
  });

  await t.test("accepts unicode accidentals", () => {
    assertEquals(normalizeKey("C♯"), "3B");
    assertEquals(normalizeKey("D♭"), "3B");
    assertEquals(normalizeKey("F♯m"), "11A");
  });

  await t.test("accepts lowercase roots", () => {
    assertEquals(normalizeKey("c"), "8B");
    assertEquals(normalizeKey("dm"), "7A");
    assertEquals(normalizeKey("f#"), "2B");
  });

  await t.test("rejects ambiguous uppercase-B-as-flat", () => {
    // In music notation, 'B' is a note name; only lowercase 'b' means flat.
    // So `dB` is not a valid spelling of D-flat and must be rejected.
    assertThrows(() => normalizeKey("dB"), Error, "Unrecognized key");
  });
});

test("normalizeKey: invalid input throws", async (t) => {
  await t.test("empty string", () => {
    assertThrows(() => normalizeKey(""), Error, "Unrecognized key");
  });

  await t.test("out-of-range Camelot number", () => {
    assertThrows(() => normalizeKey("13A"), Error, "Unrecognized key");
    assertThrows(() => normalizeKey("0B"), Error, "Unrecognized key");
  });

  await t.test("invalid Camelot mode letter", () => {
    assertThrows(() => normalizeKey("8C"), Error, "Unrecognized key");
  });

  await t.test("non-existent root", () => {
    assertThrows(() => normalizeKey("H"), Error, "Unrecognized key");
    assertThrows(() => normalizeKey("Hm"), Error, "Unrecognized key");
  });

  await t.test("garbage", () => {
    assertThrows(() => normalizeKey("random"), Error, "Unrecognized key");
    assertThrows(() => normalizeKey("C minor major"), Error, "Unrecognized key");
  });

  await t.test("error message includes the input", () => {
    try {
      normalizeKey("nope");
      throw new Error("should have thrown");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      assertEquals(err.message.includes('"nope"'), true);
    }
  });
});

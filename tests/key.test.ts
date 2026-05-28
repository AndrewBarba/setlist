import { assert, assertEquals, assertFalse, test } from "./_helpers.ts";
import { detectKeyFormat, isCamelotKey, isClassicalKey } from "../lib/key.ts";

test("isCamelotKey", async (t) => {
  await t.test("accepts every position on the wheel (1A–12B)", () => {
    for (let n = 1; n <= 12; n++) {
      for (const mode of ["A", "B"] as const) {
        const key = `${n}${mode}`;
        assert(isCamelotKey(key), `${key} should be a Camelot key`);
      }
    }
  });

  await t.test("is case-insensitive", () => {
    assert(isCamelotKey("8a"));
    assert(isCamelotKey("12b"));
  });

  await t.test("tolerates surrounding whitespace", () => {
    assert(isCamelotKey("  8A  "));
    assert(isCamelotKey("\t1B\n"));
  });

  await t.test("rejects out-of-range numbers", () => {
    assertFalse(isCamelotKey("0A"));
    assertFalse(isCamelotKey("13A"));
    assertFalse(isCamelotKey("99B"));
  });

  await t.test("rejects invalid mode letters", () => {
    assertFalse(isCamelotKey("8C"));
    assertFalse(isCamelotKey("8Z"));
    assertFalse(isCamelotKey("8"));
  });

  await t.test("rejects classical notation", () => {
    assertFalse(isCamelotKey("Am"));
    assertFalse(isCamelotKey("C#"));
    assertFalse(isCamelotKey("Bb minor"));
  });

  await t.test("rejects empty and garbage input", () => {
    assertFalse(isCamelotKey(""));
    assertFalse(isCamelotKey("   "));
    assertFalse(isCamelotKey("random"));
    assertFalse(isCamelotKey("8A8A"));
  });
});

test("isClassicalKey", async (t) => {
  await t.test("accepts bare roots (implicit major)", () => {
    for (const root of ["A", "B", "C", "D", "E", "F", "G"]) {
      assert(isClassicalKey(root), `${root} should be classical`);
    }
  });

  await t.test("accepts lowercase roots", () => {
    assert(isClassicalKey("a"));
    assert(isClassicalKey("g"));
  });

  await t.test("accepts sharps and flats (ASCII + unicode)", () => {
    assert(isClassicalKey("C#"));
    assert(isClassicalKey("Db"));
    assert(isClassicalKey("F♯"));
    assert(isClassicalKey("G♭"));
  });

  await t.test("accepts minor markers", () => {
    assert(isClassicalKey("Am"));
    assert(isClassicalKey("F#m"));
    assert(isClassicalKey("Bbm"));
    assert(isClassicalKey("A minor"));
    assert(isClassicalKey("C# min"));
  });

  await t.test("accepts major markers", () => {
    assert(isClassicalKey("C major"));
    assert(isClassicalKey("F maj"));
    assert(isClassicalKey("Gb major"));
  });

  await t.test("disambiguates flat accidental from minor suffix", () => {
    // Bb = B-flat major; Bbm = B-flat minor; Bm = B minor.
    assert(isClassicalKey("Bb"));
    assert(isClassicalKey("Bm"));
    assert(isClassicalKey("Bbm"));
  });

  await t.test("tolerates surrounding whitespace", () => {
    assert(isClassicalKey("  Am  "));
    assert(isClassicalKey("\tC# minor\n"));
  });

  await t.test("rejects non-existent roots", () => {
    assertFalse(isClassicalKey("H"));
    assertFalse(isClassicalKey("I"));
  });

  await t.test("rejects Camelot notation", () => {
    assertFalse(isClassicalKey("8A"));
    assertFalse(isClassicalKey("12B"));
  });

  await t.test("rejects empty and garbage input", () => {
    assertFalse(isClassicalKey(""));
    assertFalse(isClassicalKey("   "));
    assertFalse(isClassicalKey("random"));
    assertFalse(isClassicalKey("C major minor"));
  });
});

test("detectKeyFormat", async (t) => {
  await t.test("returns 'camelot' for Camelot notation", () => {
    assertEquals(detectKeyFormat("1A"), "camelot");
    assertEquals(detectKeyFormat("8B"), "camelot");
    assertEquals(detectKeyFormat("12A"), "camelot");
    assertEquals(detectKeyFormat(" 8a "), "camelot");
  });

  await t.test("returns 'classical' for standard notation", () => {
    assertEquals(detectKeyFormat("C"), "classical");
    assertEquals(detectKeyFormat("Am"), "classical");
    assertEquals(detectKeyFormat("F#m"), "classical");
    assertEquals(detectKeyFormat("Bb"), "classical");
    assertEquals(detectKeyFormat("A minor"), "classical");
    assertEquals(detectKeyFormat("Gb major"), "classical");
  });

  await t.test("returns null for unrecognized input", () => {
    assertEquals(detectKeyFormat(""), null);
    assertEquals(detectKeyFormat("   "), null);
    assertEquals(detectKeyFormat("13A"), null);
    assertEquals(detectKeyFormat("0B"), null);
    assertEquals(detectKeyFormat("8C"), null);
    assertEquals(detectKeyFormat("H"), null);
    assertEquals(detectKeyFormat("random"), null);
    assertEquals(detectKeyFormat("8"), null);
  });

  await t.test("checks Camelot before classical (no overlap in practice)", () => {
    // Single letters like 'A' or 'B' are classical, never Camelot, because
    // Camelot requires a leading 1–12.
    assertEquals(detectKeyFormat("A"), "classical");
    assertEquals(detectKeyFormat("B"), "classical");
    // And anything starting with a digit can only be Camelot.
    assertEquals(detectKeyFormat("1A"), "camelot");
  });

  await t.test("narrows to CamelotKey via isCamelotKey type guard", () => {
    const raw: string = "8A";
    if (isCamelotKey(raw)) {
      // Compile-time check: `raw` is now CamelotKey, assignable as such.
      const narrowed: `${number}${"A" | "B"}` = raw;
      assertEquals(narrowed, "8A");
    } else {
      throw new Error("expected 8A to be a Camelot key");
    }
  });
});

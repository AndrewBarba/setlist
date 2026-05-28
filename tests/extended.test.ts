import { assert, assertFalse, test } from "./_helpers.ts";
import { isExtendedTitle } from "../lib/extended.ts";

test("isExtendedTitle: 'extended' marker", async (t) => {
  await t.test("Extended Mix", () => {
    assert(isExtendedTitle("Strobe (Extended Mix)"));
    assert(isExtendedTitle("Strobe - Extended Mix"));
    assert(isExtendedTitle("Strobe [Extended Mix]"));
  });

  await t.test("Extended Version / Edit / Cut", () => {
    assert(isExtendedTitle("Opus (Extended Version)"));
    assert(isExtendedTitle("Opus (Extended Edit)"));
  });

  await t.test("bare '(Extended)'", () => {
    assert(isExtendedTitle("Opus (Extended)"));
    assert(isExtendedTitle("Opus [Extended]"));
  });

  await t.test("case-insensitive", () => {
    assert(isExtendedTitle("Opus (EXTENDED MIX)"));
    assert(isExtendedTitle("Opus (extended)"));
    assert(isExtendedTitle("Opus (eXtEnDeD)"));
  });
});

test("isExtendedTitle: 'club mix' marker", async (t) => {
  await t.test("Club Mix", () => {
    assert(isExtendedTitle("Strobe (Club Mix)"));
    assert(isExtendedTitle("Strobe - Club Mix"));
  });

  await t.test("Club Edit", () => {
    assert(isExtendedTitle("Strobe (Club Edit)"));
  });

  await t.test("case-insensitive", () => {
    assert(isExtendedTitle("Strobe (CLUB MIX)"));
    assert(isExtendedTitle("Strobe (club mix)"));
  });
});

test("isExtendedTitle: 'long ...' marker", async (t) => {
  await t.test("Long Mix / Edit / Version", () => {
    assert(isExtendedTitle("Strobe (Long Mix)"));
    assert(isExtendedTitle("Strobe (Long Edit)"));
    assert(isExtendedTitle("Strobe (Long Version)"));
  });
});

test("isExtendedTitle: 12-inch markers", async (t) => {
  await t.test('12" notation', () => {
    assert(isExtendedTitle('Strobe (12" Mix)'));
    assert(isExtendedTitle('Strobe (12 " Mix)'));
  });

  await t.test("'12 inch' notation", () => {
    assert(isExtendedTitle("Strobe (12 Inch Mix)"));
    assert(isExtendedTitle("Strobe (12-inch Mix)"));
    assert(isExtendedTitle("Strobe (12inch Mix)"));
  });
});

test("isExtendedTitle: negative cases", async (t) => {
  await t.test("Radio Edit is not extended", () => {
    assertFalse(isExtendedTitle("Strobe (Radio Edit)"));
    assertFalse(isExtendedTitle("Strobe - Radio Mix"));
  });

  await t.test("Original Mix is not (treated as) extended", () => {
    assertFalse(isExtendedTitle("Strobe (Original Mix)"));
  });

  await t.test("Remix without other markers is not extended", () => {
    assertFalse(isExtendedTitle("Strobe (John Smith Remix)"));
  });

  await t.test("Plain title is not extended", () => {
    assertFalse(isExtendedTitle("Strobe"));
    assertFalse(isExtendedTitle("Opus"));
  });

  await t.test("Empty input is not extended", () => {
    assertFalse(isExtendedTitle(""));
  });
});

test("isExtendedTitle: word-boundary discipline", async (t) => {
  await t.test("does not match substrings inside other words", () => {
    // 'extended' is a real word; other roots like 'extending' must not match.
    assertFalse(isExtendedTitle("Strobe (Extending Mix)"));
    // 'club' must be a whole word — 'clubhouse' should not match.
    assertFalse(isExtendedTitle("Clubhouse Anthem"));
    // 'long' must be followed by mix/edit/version — bare 'long' should not.
    assertFalse(isExtendedTitle("Long Goodbye"));
    assertFalse(isExtendedTitle("Long Ride"));
  });

  await t.test("'12' alone does not trigger", () => {
    assertFalse(isExtendedTitle("12 Years"));
    assertFalse(isExtendedTitle("Track 12"));
  });
});

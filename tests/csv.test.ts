import { assert, assertEquals, assertThrows, test } from "./_helpers.ts";
import { parseSetlist } from "../lib/csv.ts";
import type { Bpm } from "../lib/types.ts";

/**
 * Test helper: brand a literal number as `Bpm` without runtime validation.
 * Tests own their inputs, so the cast is safe; the production constructor
 * (`normalizeBpm`) is what consumers must use for untrusted input.
 */
const b = (n: number): Bpm => n as Bpm;

test("parseSetlist: minimal required columns", () => {
  const csv = ["title,key,bpm", "Strobe,8B,128", "Opus,Am,126"].join("\n");

  assertEquals(parseSetlist(csv), [
    { title: "Strobe", key: "8B", bpm: b(128), extended: false },
    { title: "Opus", key: "8A", bpm: b(126), extended: false },
  ]);
});

test("parseSetlist: full column set", () => {
  const csv = ["title,artist,key,bpm", "Strobe,Deadmau5,8B,128", "Opus,Eric Prydz,Am,126.5"].join(
    "\n",
  );

  assertEquals(parseSetlist(csv), [
    {
      title: "Strobe",
      artist: "Deadmau5",
      key: "8B",
      bpm: b(128),
      extended: false,
    },
    {
      title: "Opus",
      artist: "Eric Prydz",
      key: "8A",
      bpm: b(126.5),
      extended: false,
    },
  ]);
});

test("parseSetlist: column order is flexible", () => {
  const csv = ["bpm,key,title,artist", "128,8B,Strobe,Deadmau5"].join("\n");

  assertEquals(parseSetlist(csv), [
    {
      title: "Strobe",
      artist: "Deadmau5",
      key: "8B",
      bpm: b(128),
      extended: false,
    },
  ]);
});

test("parseSetlist: header matching is case-insensitive", () => {
  const csv = ["Title,ARTIST,Key,BPM", "Strobe,Deadmau5,8B,128"].join("\n");

  assertEquals(parseSetlist(csv)[0], {
    title: "Strobe",
    artist: "Deadmau5",
    key: "8B",
    bpm: b(128),
    extended: false,
  });
});

test("parseSetlist: omits artist when column absent or empty", async (t) => {
  await t.test("column absent → no artist key", () => {
    const csv = "title,key,bpm\nStrobe,8B,128";
    const [track] = parseSetlist(csv);
    assert(track);
    assertEquals("artist" in track, false);
  });

  await t.test("column present but empty → no artist key", () => {
    const csv = "title,artist,key,bpm\nStrobe,,8B,128";
    const [track] = parseSetlist(csv);
    assert(track);
    assertEquals("artist" in track, false);
  });

  await t.test("column with whitespace-only → no artist key", () => {
    const csv = "title,artist,key,bpm\nStrobe,   ,8B,128";
    const [track] = parseSetlist(csv);
    assert(track);
    assertEquals("artist" in track, false);
  });
});

test("parseSetlist: extended is derived from title", async (t) => {
  await t.test("title containing 'Extended Mix' → extended true", () => {
    const csv = ["title,key,bpm", "Strobe (Extended Mix),8B,128"].join("\n");
    assertEquals(parseSetlist(csv)[0]!.extended, true);
  });

  await t.test("title containing 'Club Mix' → extended true", () => {
    const csv = ["title,key,bpm", "Strobe (Club Mix),8B,128"].join("\n");
    assertEquals(parseSetlist(csv)[0]!.extended, true);
  });

  await t.test("title with no marker → extended false", () => {
    const csv = [
      "title,key,bpm",
      "Strobe,8B,128",
      "Strobe (Original Mix),8B,128",
      "Strobe (Radio Edit),8B,128",
    ].join("\n");
    const flags = parseSetlist(csv).map((t) => t.extended);
    assertEquals(flags, [false, false, false]);
  });

  await t.test("mixed: some extended, some not", () => {
    // The third row uses `12"`; inside an unquoted CSV field a bare `"`
    // would be a parse error, so we wrap it in quotes and escape via `""`.
    const csv = [
      "title,key,bpm",
      "Strobe (Extended Mix),8B,128",
      "Strobe (Radio Edit),8B,128",
      '"Opus (12"" Mix)",8B,128',
      "Opus (Original Mix),8B,128",
    ].join("\n");
    const flags = parseSetlist(csv).map((t) => t.extended);
    assertEquals(flags, [true, false, true, false]);
  });
});

test("parseSetlist: classical keys are normalized to Camelot", () => {
  const csv = [
    "title,key,bpm",
    "C natural,C,128",
    "A minor,Am,128",
    "F sharp minor,F#m,128",
    "B flat major,Bb,128",
  ].join("\n");

  assertEquals(
    parseSetlist(csv).map((t) => t.key),
    ["8B", "8A", "11A", "6B"],
  );
});

test("parseSetlist: BPM accepts string variants", () => {
  const csv = ["title,key,bpm", "A,8B,128", "B,8B,128.5", "C,8B,128 BPM", "D,8B,128bpm"].join("\n");

  assertEquals(
    parseSetlist(csv).map((t) => t.bpm),
    [b(128), b(128.5), b(128), b(128)],
  );
});

test("parseSetlist: CSV quoting", async (t) => {
  await t.test("quoted field with comma", () => {
    const csv = ["title,artist,key,bpm", '"Strobe, Original Mix","Deadmau5",8B,128'].join("\n");
    assertEquals(parseSetlist(csv)[0], {
      title: "Strobe, Original Mix",
      artist: "Deadmau5",
      key: "8B",
      bpm: b(128),
      extended: false,
    });
  });

  await t.test("escaped double quotes inside quoted field", () => {
    const csv = ["title,key,bpm", '"He said ""yes""",8B,128'].join("\n");
    assertEquals(parseSetlist(csv)[0]!.title, 'He said "yes"');
  });
});

test("parseSetlist: tolerant whitespace and blank rows", async (t) => {
  await t.test("trims surrounding whitespace in fields", () => {
    const csv = ["title,artist,key,bpm", "  Strobe  ,  Deadmau5  ,  8B  ,  128  "].join("\n");
    assertEquals(parseSetlist(csv)[0], {
      title: "Strobe",
      artist: "Deadmau5",
      key: "8B",
      bpm: b(128),
      extended: false,
    });
  });

  await t.test("skips blank lines between rows", () => {
    const csv = ["title,key,bpm", "Strobe,8B,128", "", "   ", "Opus,Am,126", ""].join("\n");
    assertEquals(parseSetlist(csv).length, 2);
  });

  await t.test("handles CRLF line endings", () => {
    const csv = "title,key,bpm\r\nStrobe,8B,128\r\nOpus,Am,126\r\n";
    assertEquals(parseSetlist(csv).length, 2);
  });

  await t.test("strips UTF-8 BOM", () => {
    const csv = "\uFEFFtitle,key,bpm\nStrobe,8B,128";
    assertEquals(parseSetlist(csv).length, 1);
  });
});

test("parseSetlist: header-only input returns empty array", () => {
  assertEquals(parseSetlist("title,key,bpm"), []);
  assertEquals(parseSetlist("title,key,bpm\n"), []);
});

test("parseSetlist: missing required column", async (t) => {
  await t.test("missing title", () => {
    assertThrows(() => parseSetlist("key,bpm\n8B,128"), Error, 'Missing required column: "title"');
  });

  await t.test("missing key", () => {
    assertThrows(
      () => parseSetlist("title,bpm\nStrobe,128"),
      Error,
      'Missing required column: "key"',
    );
  });

  await t.test("missing bpm", () => {
    assertThrows(
      () => parseSetlist("title,key\nStrobe,8B"),
      Error,
      'Missing required column: "bpm"',
    );
  });
});

test("parseSetlist: duplicate header", () => {
  assertThrows(
    () => parseSetlist("title,title,key,bpm\nStrobe,Foo,8B,128"),
    Error,
    'Duplicate header: "title"',
  );
});

test("parseSetlist: empty input throws", () => {
  assertThrows(() => parseSetlist(""), Error, "CSV is empty");
});

test("parseSetlist: error messages include row number", async (t) => {
  await t.test("bad BPM on row 2", () => {
    const csv = ["title,key,bpm", "Strobe,8B,128", "Opus,Am,fast"].join("\n");
    assertThrows(() => parseSetlist(csv), Error, "Row 2: Invalid BPM");
  });

  await t.test("bad key on row 1", () => {
    const csv = ["title,key,bpm", "Strobe,??,128"].join("\n");
    assertThrows(() => parseSetlist(csv), Error, "Row 1: Unrecognized key");
  });

  await t.test("missing required field on row 3", () => {
    const csv = ["title,key,bpm", "Strobe,8B,128", "Opus,Am,126", ",8A,140"].join("\n");
    assertThrows(() => parseSetlist(csv), Error, 'Row 3: Missing required field "title"');
  });

  await t.test("row index counts data rows; blank rows are stripped", () => {
    // @std/csv drops blank lines during tokenization, so the third file
    // line below becomes the 2nd data row (1-based) in the error message.
    const csv = ["title,key,bpm", "Strobe,8B,128", "", "Opus,Am,oops"].join("\n");
    assertThrows(() => parseSetlist(csv), Error, "Row 2: Invalid BPM");
  });
});

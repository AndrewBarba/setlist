import { assert, assertEquals, test } from "./_helpers.ts";
import { formatCsv, formatJson, formatPretty } from "../bin/format.ts";
import type { Sequence } from "../lib/sequence.ts";
import type { Bpm, CamelotKey, Track } from "../lib/types.ts";

/** Test-only Track factory; cast helpers explained in compat.test.ts. */
function track(partial: {
  title?: string;
  artist?: string;
  key: string;
  bpm: number;
  extended?: boolean;
}): Track {
  const t: Track = {
    title: partial.title ?? "track",
    key: partial.key as CamelotKey,
    bpm: partial.bpm as Bpm,
    extended: partial.extended ?? false,
  };
  if (partial.artist !== undefined) t.artist = partial.artist;
  return t;
}

/** Build a minimal Sequence for testing formatters. */
function seq(tracks: Track[], transitions: number[], dropped: Track[] = []): Sequence {
  const totalScore = transitions.reduce((a, b) => a + b, 0);
  return { tracks, transitions, totalScore, dropped };
}

test("formatPretty: empty sequence", () => {
  assertEquals(formatPretty(seq([], [])), "(empty setlist)");
});

test("formatPretty: header includes track count and score", () => {
  const s = seq(
    [track({ title: "A", key: "8B", bpm: 128 }), track({ title: "B", key: "9B", bpm: 130 })],
    [0.95],
  );
  const out = formatPretty(s);
  assert(out.startsWith("Setlist (2 tracks, score: 0.950)"));
});

test("formatPretty: singular 'track' for n=1", () => {
  const s = seq([track({ title: "A", key: "8B", bpm: 128 })], []);
  const out = formatPretty(s);
  assert(out.startsWith("Setlist (1 track, score: 0.000)"));
});

test("formatPretty: each track row has position, key, bpm, title", () => {
  const s = seq(
    [
      track({ title: "Strobe", key: "8B", bpm: 128 }),
      track({ title: "Opus", key: "9A", bpm: 130 }),
    ],
    [0.87],
  );
  const lines = formatPretty(s).split("\n");
  // 2 tracks + header line + separator line = 4 lines.
  assertEquals(lines.length, 4);
  // First track row.
  assert(lines[2]!.includes("Strobe"));
  assert(lines[2]!.includes("8B"));
  assert(lines[2]!.includes("128"));
  // Second track row.
  assert(lines[3]!.includes("Opus"));
  assert(lines[3]!.includes("9A"));
  assert(lines[3]!.includes("130"));
});

test("formatPretty: extended marker appears for extended tracks", () => {
  const s = seq(
    [
      track({ title: "Plain", key: "8B", bpm: 128, extended: false }),
      track({ title: "Long", key: "8B", bpm: 130, extended: true }),
    ],
    [0.9],
  );
  const lines = formatPretty(s).split("\n");
  assert(!lines[2]!.includes("[EXT]"), "plain track should not show [EXT]");
  assert(lines[3]!.includes("[EXT]"), "extended track should show [EXT]");
});

test("formatPretty: artist appears after title with em-dash", () => {
  const s = seq([track({ title: "Strobe", artist: "Deadmau5", key: "8B", bpm: 128 })], []);
  assert(formatPretty(s).includes("Strobe — Deadmau5"));
});

test("formatPretty: transitions are annotated on each row except the last", () => {
  const s = seq(
    [
      track({ title: "A", key: "8B", bpm: 128 }),
      track({ title: "B", key: "9B", bpm: 130 }),
      track({ title: "C", key: "10B", bpm: 132 }),
    ],
    [0.87, 0.92],
  );
  const lines = formatPretty(s).split("\n");
  // Header + sep + 3 tracks = 5 lines.
  assert(lines[2]!.includes("→[0.87]"));
  assert(lines[3]!.includes("→[0.92]"));
  assert(!lines[4]!.includes("→["), "last row should not have a transition annotation");
});

test("formatJson: is valid JSON and round-trips through parse", () => {
  const s = seq(
    [
      track({ title: "A", key: "8B", bpm: 128 }),
      track({ title: "B", artist: "Foo", key: "9B", bpm: 130, extended: true }),
    ],
    [0.87],
  );
  const out = formatJson(s);
  const parsed = JSON.parse(out);
  assertEquals(parsed.tracks.length, 2);
  assertEquals(parsed.transitions, [0.87]);
  assertEquals(parsed.totalScore, 0.87);
  // Field-level checks on first track.
  assertEquals(parsed.tracks[0].title, "A");
  assertEquals(parsed.tracks[0].key, "8B");
  assertEquals(parsed.tracks[0].bpm, 128);
  assertEquals(parsed.tracks[0].extended, false);
  // Artist included when present.
  assertEquals(parsed.tracks[1].artist, "Foo");
});

test("formatJson: is indented (multi-line)", () => {
  const s = seq([track({ title: "A", key: "8B", bpm: 128 })], []);
  const out = formatJson(s);
  assert(out.includes("\n"), "JSON should be indented across multiple lines");
});

test("formatCsv: header row is correct", () => {
  const s = seq([], []);
  const out = formatCsv(s);
  assertEquals(out.split("\n")[0], "position,title,artist,key,bpm,extended,score_to_next,status");
});

test("formatCsv: track rows include all fields", () => {
  const s = seq(
    [
      track({ title: "A", artist: "ArtistA", key: "8B", bpm: 128 }),
      track({ title: "B", key: "9A", bpm: 130, extended: true }),
    ],
    [0.87],
  );
  const lines = formatCsv(s).split("\n");
  assertEquals(lines.length, 3); // header + 2 tracks
  assertEquals(lines[1], "1,A,ArtistA,8B,128,false,0.8700,sequenced");
  assertEquals(lines[2], "2,B,,9A,130,true,,sequenced");
});

test("formatCsv: quotes fields containing commas or quotes", () => {
  const s = seq(
    [
      track({ title: "Strobe, Original Mix", artist: "Deadmau5", key: "8B", bpm: 128 }),
      track({ title: 'He said "yes"', key: "8B", bpm: 130 }),
    ],
    [1.0],
  );
  const lines = formatCsv(s).split("\n");
  assert(lines[1]!.includes('"Strobe, Original Mix"'));
  // RFC 4180: inner quotes doubled.
  assert(lines[2]!.includes('"He said ""yes"""'));
});

test("formatCsv: round-trips through the vendored CSV parser", async () => {
  // Sanity check: the CSV we emit should be parseable back. Catches
  // any quoting bugs in csvEscape. Uses the same parser the library
  // itself uses for input, so this is a real end-to-end round-trip.
  const { parse } = await import("../lib/csv-parse.ts");
  const s = seq(
    [
      track({ title: "Strobe, Extended Mix", artist: 'Quoted "Artist"', key: "8B", bpm: 128 }),
      track({ title: "Opus", key: "9A", bpm: 130, extended: true }),
    ],
    [0.87],
  );
  const csv = formatCsv(s);
  const rows = parse(csv);
  // Header + 2 data rows.
  assertEquals(rows.length, 3);
  // First data row matches what we emitted.
  assertEquals(rows[1], [
    "1",
    "Strobe, Extended Mix",
    'Quoted "Artist"',
    "8B",
    "128",
    "false",
    "0.8700",
    "sequenced",
  ]);
});

test("formatCsv: last track has empty score_to_next", () => {
  const s = seq(
    [track({ title: "A", key: "8B", bpm: 128 }), track({ title: "B", key: "9B", bpm: 130 })],
    [0.9],
  );
  const lines = formatCsv(s).split("\n");
  // Last sequenced row: score_to_next is empty (column 7 of 8); status is
  // `sequenced` (column 8). Specifically check the score field is empty.
  const cells = lines[2]!.split(",");
  assertEquals(cells.length, 8);
  assertEquals(cells[6], "", "score_to_next should be empty for last track");
  assertEquals(cells[7], "sequenced");
});

test("formatCsv: dropped tracks appear with status=dropped", () => {
  const s = seq(
    [track({ title: "Kept", key: "8B", bpm: 128 })],
    [],
    [track({ title: "Outlier", artist: "Foo", key: "12A", bpm: 100 })],
  );
  const lines = formatCsv(s).split("\n");
  // header + 1 sequenced + 1 dropped
  assertEquals(lines.length, 3);
  assertEquals(lines[1], "1,Kept,,8B,128,false,,sequenced");
  // Dropped: empty position, empty score, status=dropped.
  assertEquals(lines[2], ",Outlier,Foo,12A,100,false,,dropped");
});

test("formatPretty: dropped tracks appear in a 'Dropped' section", () => {
  const s = seq(
    [track({ title: "Kept", key: "8B", bpm: 128 })],
    [],
    [
      track({ title: "Outlier1", key: "12A", bpm: 100 }),
      track({ title: "Outlier2", artist: "Foo", key: "1A", bpm: 200 }),
    ],
  );
  const out = formatPretty(s);
  assert(out.includes("Dropped (2 tracks):"), "should announce dropped count");
  assert(out.includes("Outlier1"));
  assert(out.includes("Outlier2 — Foo"));
  assert(out.includes("(100 BPM, 12A)"));
});

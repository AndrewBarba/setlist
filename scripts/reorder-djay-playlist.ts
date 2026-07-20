#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseSetlist } from "../lib/csv.ts";
import { sequence } from "../lib/sequence.ts";

const APP_NAME = "djay Pro";
const DEFAULT_DB = join(
  homedir(),
  "Music/djay/djay Media Library.djayMediaLibrary/MediaLibrary.db",
);

const HELP = `Reorder a djay Pro playlist using setlist

USAGE:
  npm run djay:sync -- --name <PLAYLIST> <tracks.csv>
  node scripts/reorder-djay-playlist.ts --name <PLAYLIST> <tracks.csv>

OPTIONS:
  -n, --name <NAME>  djay Pro playlist name (required)
  -s, --seed <N>     Reproducible setlist seed
  -k, --ignore-bpm   Sequence by harmonic compatibility only
      --db <PATH>    MediaLibrary.db path (defaults to ~/Music/djay/...)
  -h, --help         Show this help
`;

interface PlaylistRow {
  rowid: number;
  uuid: string;
}

interface PlaylistItemRow {
  itemRowid: number;
  itemUuid: string;
  title: string;
}

interface ViewPageRow {
  pageKey: string;
  prevPageKey: string | null;
  count: number;
  dataHex: string;
}

interface ViewMapRow {
  rowid: number;
  pageKey: string;
}

function main(): void {
  const args = parseArgs({
    options: {
      name: { type: "string", short: "n" },
      seed: { type: "string", short: "s" },
      "ignore-bpm": { type: "boolean", short: "k" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (args.values.help) {
    process.stdout.write(HELP);
    return;
  }

  const name = args.values.name?.trim();
  if (!name) usage("--name is required");
  if (args.positionals.length !== 1) usage("exactly one CSV input file is required");

  const seed = parseSeed(args.values.seed);
  const inputPath = args.positionals[0]!;
  const db = args.values.db ?? DEFAULT_DB;
  if (!existsSync(db)) throw new Error(`djay database not found: ${db}`);
  const tracks = parseSetlist(readFileSync(inputPath, "utf8"));
  if (tracks.length === 0) throw new Error("CSV contains no tracks");

  process.stdout.write(`Sequencing ${tracks.length} tracks from ${basename(inputPath)}...\n`);
  const orderedTracks = sequence(tracks, {
    seed,
    ignoreBpm: args.values["ignore-bpm"] === true,
  }).tracks;
  assertUniqueTitles(orderedTracks.map((track) => track.title), "CSV");

  const wasRunning = isDjayRunning();
  if (wasRunning) {
    process.stdout.write(`Quitting ${APP_NAME}...\n`);
    quitDjay();
  }

  try {
    reorderPlaylist(db, name, orderedTracks.map((track) => track.title));
  } finally {
    if (wasRunning) {
      process.stdout.write(`Reopening ${APP_NAME}...\n`);
      execFileSync("open", ["-a", APP_NAME]);
    }
  }
}

function reorderPlaylist(db: string, name: string, targetTitles: readonly string[]): void {
  sqliteValue(db, "SELECT sqlite_version()");

  const playlists = sqliteJson<PlaylistRow>(db, `
    SELECT playlist.rowid, playlist.key AS uuid
    FROM secondaryIndex_mediaItemPlaylistIndex indexTable
    JOIN database2 playlist ON playlist.rowid = indexTable.rowid
    WHERE indexTable.name = ${sqlString(name)};
  `);
  if (playlists.length === 0) throw new Error(`djay playlist not found: ${name}`);
  if (playlists.length > 1) throw new Error(`multiple djay playlists are named: ${name}`);
  const playlist = playlists[0]!;

  const items = sqliteJson<PlaylistItemRow>(db, `
    SELECT playlistItem.rowid AS itemRowid,
           playlistItem.key AS itemUuid,
           search.c0title AS title
    FROM relationship_relationship playlistRelationship
    JOIN database2 playlistItem
      ON playlistItem.rowid = playlistRelationship.dst
      AND playlistItem.collection = 'mediaItemPlaylistItems'
    JOIN relationship_relationship mediaRelationship
      ON mediaRelationship.src = playlistItem.rowid
      AND mediaRelationship.name = 'mediaItemPlaylistItemMediaItem'
    JOIN fts_searchIndex_content search ON search.docid = mediaRelationship.dst
    WHERE playlistRelationship.src = ${playlist.rowid}
      AND playlistRelationship.name = 'mediaItemPlaylistItem';
  `);

  if (items.length !== targetTitles.length) {
    throw new Error(
      `CSV has ${targetTitles.length} tracks, but ${name} has ${items.length} playlist items`,
    );
  }
  assertUniqueTitles(items.map((item) => item.title), `djay playlist ${name}`);

  const byTitle = new Map(items.map((item) => [item.title, item]));
  const orderedItems = targetTitles.map((title) => {
    const item = byTitle.get(title);
    if (!item) throw new Error(`CSV track not found in djay playlist ${name}: ${title}`);
    return item;
  });

  const playlistHex = sqliteValue(db, `
    SELECT hex(data) FROM database2
    WHERE rowid = ${playlist.rowid} AND collection = 'mediaItemPlaylists';
  `);
  const playlistBlob = Buffer.from(playlistHex, "hex");
  const uuidOffsets = items
    .map((item) => findUniqueOffset(playlistBlob, item.itemUuid))
    .sort((a, b) => a - b);
  uuidOffsets.forEach((offset, index) => {
    playlistBlob.write(orderedItems[index]!.itemUuid, offset, 36, "ascii");
  });

  const pages = orderPages(sqliteJson<ViewPageRow>(db, `
    SELECT pageKey, prevPageKey, count, hex(data) AS dataHex
    FROM view_mediaItemPlaylistView_page
    WHERE "group" = ${sqlString(playlist.uuid)};
  `));
  if (pages.reduce((total, page) => total + page.count, 0) !== items.length) {
    throw new Error("djay ordered-view page count does not match playlist item count");
  }

  const pageData = new Map<string, Buffer>();
  const targetPageByRowid = new Map<number, string>();
  let itemIndex = 0;
  for (const page of pages) {
    const data = Buffer.alloc(page.count * 8);
    for (let i = 0; i < page.count; i++) {
      const item = orderedItems[itemIndex++]!;
      data.writeBigInt64LE(BigInt(item.itemRowid), i * 8);
      targetPageByRowid.set(item.itemRowid, page.pageKey);
    }
    pageData.set(page.pageKey, data);
  }

  const viewMap = sqliteJson<ViewMapRow>(db, `
    SELECT map.rowid, map.pageKey
    FROM view_mediaItemPlaylistView_map map
    JOIN relationship_relationship relationship ON relationship.dst = map.rowid
    WHERE relationship.src = ${playlist.rowid}
      AND relationship.name = 'mediaItemPlaylistItem';
  `);
  if (viewMap.length !== items.length) throw new Error("djay ordered-view map is incomplete");

  const playlistMatches = playlistHex.toLowerCase() === playlistBlob.toString("hex");
  const pagesMatch = pages.every(
    (page) => page.dataHex.toLowerCase() === pageData.get(page.pageKey)!.toString("hex"),
  );
  const mapMatches = viewMap.every(
    (entry) => entry.pageKey === targetPageByRowid.get(entry.rowid),
  );
  if (playlistMatches && pagesMatch && mapMatches) {
    process.stdout.write(`${name} already matches the generated order.\n`);
    return;
  }

  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const backupPath = join(dirname(db), `${basename(db)}.backup-${stamp}`);
  sqliteExec(db, `VACUUM INTO ${sqlString(backupPath)};`);
  if (sqliteValue(backupPath, "PRAGMA integrity_check;") !== "ok") {
    throw new Error(`backup integrity check failed: ${backupPath}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "setlist-djay-"));
  try {
    const playlistPath = join(tempDir, "playlist.bin");
    writeFileSync(playlistPath, playlistBlob);

    const statements = [
      "BEGIN IMMEDIATE;",
      `UPDATE database2 SET data = readfile(${sqlString(playlistPath)}) WHERE rowid = ${playlist.rowid};`,
    ];
    for (const [pageKey, data] of pageData) {
      const pagePath = join(tempDir, `${pageKey}.bin`);
      writeFileSync(pagePath, data);
      statements.push(
        `UPDATE view_mediaItemPlaylistView_page SET data = readfile(${sqlString(pagePath)}) WHERE pageKey = ${sqlString(pageKey)};`,
      );
    }
    for (const [rowid, pageKey] of targetPageByRowid) {
      statements.push(
        `UPDATE view_mediaItemPlaylistView_map SET pageKey = ${sqlString(pageKey)} WHERE rowid = ${rowid};`,
      );
    }
    statements.push("COMMIT;");
    sqliteExec(db, statements.join("\n"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  verifyOrder(db, playlist.rowid, playlistBlob, pageData, targetPageByRowid);
  if (sqliteValue(db, "PRAGMA integrity_check;") !== "ok") {
    throw new Error(`database integrity check failed; restore ${backupPath}`);
  }

  process.stdout.write(`Updated ${name} (${items.length} tracks).\n`);
  process.stdout.write(`Backup: ${backupPath}\n`);
}

function verifyOrder(
  db: string,
  playlistRowid: number,
  playlistBlob: Buffer,
  pageData: ReadonlyMap<string, Buffer>,
  targetPageByRowid: ReadonlyMap<number, string>,
): void {
  const actualPlaylistHex = sqliteValue(
    db,
    `SELECT hex(data) FROM database2 WHERE rowid = ${playlistRowid};`,
  );
  if (actualPlaylistHex.toLowerCase() !== playlistBlob.toString("hex")) {
    throw new Error("playlist object verification failed");
  }

  for (const [pageKey, expectedData] of pageData) {
    const actualHex = sqliteValue(
      db,
      `SELECT hex(data) FROM view_mediaItemPlaylistView_page WHERE pageKey = ${sqlString(pageKey)};`,
    );
    if (actualHex.toLowerCase() !== expectedData.toString("hex")) {
      throw new Error(`ordered-view page verification failed: ${pageKey}`);
    }
  }

  for (const [rowid, expectedPageKey] of targetPageByRowid) {
    const actualPageKey = sqliteValue(
      db,
      `SELECT pageKey FROM view_mediaItemPlaylistView_map WHERE rowid = ${rowid};`,
    );
    if (actualPageKey !== expectedPageKey) {
      throw new Error(`ordered-view map verification failed for row ${rowid}`);
    }
  }
}

function orderPages(pages: readonly ViewPageRow[]): ViewPageRow[] {
  if (pages.length === 0) throw new Error("djay playlist has no ordered-view pages");
  const firstPages = pages.filter((page) => page.prevPageKey === null);
  if (firstPages.length !== 1) throw new Error("invalid djay ordered-view page chain");

  const byPrevious = new Map<string, ViewPageRow>();
  for (const page of pages) {
    if (page.prevPageKey === null) continue;
    if (byPrevious.has(page.prevPageKey)) throw new Error("branched djay ordered-view page chain");
    byPrevious.set(page.prevPageKey, page);
  }

  const ordered: ViewPageRow[] = [];
  let page: ViewPageRow | undefined = firstPages[0];
  while (page) {
    ordered.push(page);
    page = byPrevious.get(page.pageKey);
  }
  if (ordered.length !== pages.length) throw new Error("disconnected djay ordered-view page chain");
  return ordered;
}

function findUniqueOffset(blob: Buffer, value: string): number {
  const needle = Buffer.from(value, "ascii");
  const offset = blob.indexOf(needle);
  if (offset < 0 || blob.indexOf(needle, offset + needle.length) >= 0) {
    throw new Error(`playlist item UUID must occur exactly once: ${value}`);
  }
  return offset;
}

function assertUniqueTitles(titles: readonly string[], source: string): void {
  const seen = new Set<string>();
  for (const title of titles) {
    if (seen.has(title)) throw new Error(`${source} contains duplicate title: ${title}`);
    seen.add(title);
  }
}

function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) usage(`invalid --seed ${JSON.stringify(value)}`);
  return Number(value);
}

function sqliteJson<T>(db: string, sql: string): T[] {
  const output = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }).trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function sqliteValue(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function sqliteExec(db: string, sql: string): void {
  execFileSync("sqlite3", ["-bail", db, sql], { stdio: "inherit" });
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isDjayRunning(): boolean {
  return spawnSync("pgrep", ["-x", APP_NAME]).status === 0;
}

function quitDjay(): void {
  execFileSync("osascript", ["-e", `tell application ${JSON.stringify(APP_NAME)} to quit`]);
  const deadline = Date.now() + 30_000;
  while (isDjayRunning()) {
    if (Date.now() >= deadline) throw new Error(`${APP_NAME} did not quit within 30 seconds`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

function usage(message: string): never {
  process.stderr.write(`reorder-djay-playlist: ${message}\n\n${HELP}`);
  process.exit(2);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reorder-djay-playlist: ${message}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_DB = join(
  homedir(),
  "Music/djay/djay Media Library.djayMediaLibrary/MediaLibrary.db",
);

const CAMELOT_KEYS = [
  "8B", "8A", "3B", "3A", "10B", "10A", "5B", "5A",
  "12B", "12A", "7B", "7A", "2B", "2A", "9B", "9A",
  "4B", "4A", "11B", "11A", "6B", "6A", "1B", "1A",
] as const;

const HELP = `Export a djay Pro playlist to CSV

USAGE:
  npm run djay:export -- --name <PLAYLIST> [--output <tracks.csv>]
  node scripts/export-djay-playlist.ts --name <PLAYLIST> [OPTIONS]

OPTIONS:
  -n, --name <NAME>    djay Pro playlist name (required)
  -o, --output <PATH>  Write CSV to a file (defaults to stdout)
      --db <PATH>      MediaLibrary.db path (defaults to ~/Music/djay/...)
  -h, --help           Show this help
`;

interface PlaylistRow {
  rowid: number;
  uuid: string;
}

interface ViewPageRow {
  pageKey: string;
  prevPageKey: string | null;
  count: number;
  dataHex: string;
}

interface MediaRow {
  itemRowid: number;
  title: string;
  albumDataHex: string | null;
  mediaDataHex: string;
  locationDataHex: string | null;
  bpm: number | null;
  keyIndex: number | null;
}

interface ArtistRow {
  itemRowid: number;
  artistDataHex: string;
}

interface ExportRow {
  title: string;
  artist: string;
  album: string;
  time: string;
  bpm: string;
  key: string;
  url: string;
}

function main(): void {
  const args = parseArgs({
    options: {
      name: { type: "string", short: "n" },
      output: { type: "string", short: "o" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (args.values.help) {
    process.stdout.write(HELP);
    return;
  }

  const name = args.values.name?.trim();
  if (!name) usage("--name is required");

  const db = args.values.db ?? DEFAULT_DB;
  if (!existsSync(db)) throw new Error(`djay database not found: ${db}`);

  const csv = exportPlaylist(db, name);
  const output = args.values.output;
  if (output) {
    writeFileSync(output, `${csv}\n`, "utf8");
    process.stderr.write(`Exported ${name} to ${output}\n`);
  } else {
    process.stdout.write(`${csv}\n`);
  }
}

function exportPlaylist(db: string, name: string): string {
  const playlists = sqliteJson<PlaylistRow>(db, `
    SELECT playlist.rowid, playlist.key AS uuid
    FROM secondaryIndex_mediaItemPlaylistIndex indexTable
    JOIN database2 playlist ON playlist.rowid = indexTable.rowid
    WHERE indexTable.name = ${sqlString(name)};
  `);
  if (playlists.length === 0) throw new Error(`djay playlist not found: ${name}`);
  if (playlists.length > 1) throw new Error(`multiple djay playlists are named: ${name}`);
  const playlist = playlists[0]!;

  const pages = orderPages(sqliteJson<ViewPageRow>(db, `
    SELECT pageKey, prevPageKey, count, hex(data) AS dataHex
    FROM view_mediaItemPlaylistView_page
    WHERE "group" = ${sqlString(playlist.uuid)};
  `));
  const orderedRowids = pages.flatMap(decodePageRowids);

  const mediaRows = sqliteJson<MediaRow>(db, `
    SELECT playlistItem.rowid AS itemRowid,
           search.c0title AS title,
           hex(album.data) AS albumDataHex,
           hex(mediaItem.data) AS mediaDataHex,
           hex(location.data) AS locationDataHex,
           COALESCE(mediaIndex.bpm, analyzedIndex.manualBPM, analyzedIndex.bpm) AS bpm,
           COALESCE(mediaIndex.musicalKeySignatureIndex, analyzedIndex.keySignatureIndex) AS keyIndex
    FROM relationship_relationship playlistRelationship
    JOIN database2 playlistItem
      ON playlistItem.rowid = playlistRelationship.dst
      AND playlistItem.collection = 'mediaItemPlaylistItems'
    JOIN relationship_relationship mediaRelationship
      ON mediaRelationship.src = playlistItem.rowid
      AND mediaRelationship.name = 'mediaItemPlaylistItemMediaItem'
    JOIN database2 mediaItem ON mediaItem.rowid = mediaRelationship.dst
    JOIN fts_searchIndex_content search ON search.docid = mediaItem.rowid
    LEFT JOIN secondaryIndex_mediaItemIndex mediaIndex ON mediaIndex.rowid = mediaItem.rowid
    LEFT JOIN database2 analyzed
      ON analyzed.collection = 'mediaItemAnalyzedData' AND analyzed.key = mediaItem.key
    LEFT JOIN secondaryIndex_mediaItemAnalyzedDataIndex analyzedIndex
      ON analyzedIndex.rowid = analyzed.rowid
    LEFT JOIN database2 location
      ON location.collection = 'globalMediaItemLocations' AND location.key = mediaItem.key
    LEFT JOIN relationship_relationship albumRelationship
      ON albumRelationship.src = mediaItem.rowid
      AND albumRelationship.name = 'mediaItemMediaAlbum'
    LEFT JOIN database2 album ON album.rowid = albumRelationship.dst
    WHERE playlistRelationship.src = ${playlist.rowid}
      AND playlistRelationship.name = 'mediaItemPlaylistItem';
  `);

  const artistRows = sqliteJson<ArtistRow>(db, `
    SELECT playlistItem.rowid AS itemRowid, hex(artist.data) AS artistDataHex
    FROM relationship_relationship playlistRelationship
    JOIN database2 playlistItem ON playlistItem.rowid = playlistRelationship.dst
    JOIN relationship_relationship mediaRelationship
      ON mediaRelationship.src = playlistItem.rowid
      AND mediaRelationship.name = 'mediaItemPlaylistItemMediaItem'
    JOIN relationship_relationship artistRelationship
      ON artistRelationship.src = mediaRelationship.dst
      AND artistRelationship.name = 'mediaItemMediaArtist'
    JOIN database2 artist ON artist.rowid = artistRelationship.dst
    WHERE playlistRelationship.src = ${playlist.rowid}
      AND playlistRelationship.name = 'mediaItemPlaylistItem'
    ORDER BY artistRelationship.rowid;
  `);

  if (mediaRows.length !== orderedRowids.length) {
    throw new Error("djay playlist metadata does not match its ordered-view item count");
  }
  const mediaByRowid = new Map(mediaRows.map((row) => [row.itemRowid, row]));
  const artistsByRowid = new Map<number, string[]>();
  for (const row of artistRows) {
    const artist = readStringField(row.artistDataHex, "name");
    if (!artist) continue;
    const artists = artistsByRowid.get(row.itemRowid) ?? [];
    artists.push(artist);
    artistsByRowid.set(row.itemRowid, artists);
  }

  const rows = orderedRowids.map((rowid): ExportRow => {
    const media = mediaByRowid.get(rowid);
    if (!media) throw new Error(`missing metadata for djay playlist item row ${rowid}`);
    return {
      title: media.title,
      artist: (artistsByRowid.get(rowid) ?? []).join(", "),
      album: media.albumDataHex ? readStringField(media.albumDataHex, "name") : "",
      time: formatDuration(readFloatField(media.mediaDataHex, "duration")),
      bpm: media.bpm === null ? "" : formatNumber(media.bpm),
      key: media.keyIndex === null ? "" : (CAMELOT_KEYS[media.keyIndex] ?? ""),
      url: media.locationDataHex ? readSourceUri(media.locationDataHex) : "",
    };
  });

  return [
    ["Title", "Artist", "Album", "Time", "BPM", "Key", "URL"],
    ...rows.map((row) => [
      row.title,
      row.artist,
      row.album,
      row.time,
      row.bpm,
      row.key,
      row.url,
    ]),
  ].map((fields) => fields.map(csvEscape).join(",")).join("\n");
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

function decodePageRowids(page: ViewPageRow): number[] {
  const data = Buffer.from(page.dataHex, "hex");
  if (data.length !== page.count * 8) {
    throw new Error(`invalid djay ordered-view page data: ${page.pageKey}`);
  }
  const rowids: number[] = [];
  for (let offset = 0; offset < data.length; offset += 8) {
    const rowid = data.readBigInt64LE(offset);
    if (rowid > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("djay row ID exceeds safe range");
    rowids.push(Number(rowid));
  }
  return rowids;
}

function readStringField(dataHex: string, field: string): string {
  const data = Buffer.from(dataHex, "hex");
  const fieldMarker = Buffer.concat([
    Buffer.from([0x00, 0x08]),
    Buffer.from(field, "utf8"),
    Buffer.from([0x00]),
  ]);
  const valueEnd = data.indexOf(fieldMarker);
  if (valueEnd < 0) return "";
  const valueMarker = data.lastIndexOf(Buffer.from([0x00, 0x08]), valueEnd - 1);
  if (valueMarker < 0) return "";
  return data.subarray(valueMarker + 2, valueEnd).toString("utf8");
}

function readFloatField(dataHex: string, field: string): number | null {
  const data = Buffer.from(dataHex, "hex");
  const fieldMarker = Buffer.concat([Buffer.from([0x08]), Buffer.from(field), Buffer.from([0x00])]);
  const fieldOffset = data.indexOf(fieldMarker);
  if (fieldOffset < 4) return null;
  const value = data.readFloatLE(fieldOffset - 4);
  return Number.isFinite(value) ? value : null;
}

function readSourceUri(dataHex: string): string {
  const text = Buffer.from(dataHex, "hex").toString("utf8");
  return text.match(/(?:beatport|beatsource):track:[^\x00]+/i)?.[0]
    ?? text.match(/(?:file|https?):[^\x00]+/i)?.[0]
    ?? "";
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(Number(value.toFixed(3)));
}

function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function sqliteJson<T>(db: string, sql: string): T[] {
  const output = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }).trim();
  return output ? (JSON.parse(output) as T[]) : [];
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function usage(message: string): never {
  process.stderr.write(`export-djay-playlist: ${message}\n\n${HELP}`);
  process.exit(2);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`export-djay-playlist: ${message}\n`);
  process.exitCode = 1;
}

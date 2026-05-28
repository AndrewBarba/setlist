import { parse as parseCsv } from "./csv-parse.ts";
import { normalizeKey } from "./key.ts";
import { normalizeBpm } from "./bpm.ts";
import { isExtendedTitle } from "./extended.ts";
import type { Track } from "./types.ts";

/**
 * Indexes of the columns we care about in a parsed header row.
 *
 * Required columns are `number`; optional columns are `number | null`
 * (null = column not present in the input). Resolving optional columns to
 * `null` here keeps the row-parsing step branch-free per row.
 */
interface ColumnMap {
  title: number;
  artist: number | null;
  key: number;
  bpm: number;
}

/**
 * Header names we recognize, normalized to lowercase for matching.
 *
 * Note: there is no `extended` column. In practice, dance-music CSVs rarely
 * include a length flag; the `extended` field on each Track is derived from
 * the title via {@link isExtendedTitle}.
 */
const KNOWN_HEADERS = ["title", "artist", "key", "bpm"] as const;
type KnownHeader = (typeof KNOWN_HEADERS)[number];

/**
 * Parse a setlist CSV string into a list of normalized tracks.
 *
 * Expectations:
 *   - The first row is a header row. Column names are matched
 *     case-insensitively; column order is irrelevant.
 *   - Required columns: `title`, `key`, `bpm`.
 *   - Optional column: `artist`. If absent, the field is omitted from the
 *     resulting Track.
 *   - The `extended` flag is derived from each track's title via
 *     {@link isExtendedTitle}, not from a CSV column.
 *   - A BOM at the start of the input is tolerated.
 *
 * Failure modes:
 *   - Empty input or no header row → throws.
 *   - Missing required header → throws.
 *   - Any per-row failure (bad BPM, bad key, missing required field) →
 *     throws with the offending 1-based data-row index.
 *   - Header-only input (no data rows) → returns `[]`.
 */
export function parseSetlist(csv: string): Track[] {
  const stripped = stripBom(csv);
  const rows = parseCsv(stripped);

  if (rows.length === 0) {
    throw new Error("CSV is empty");
  }

  const headerRow = rows[0]!;
  const cols = buildColumnMap(headerRow);

  const tracks: Track[] = [];
  // Skip the header row; report row numbers as 1-based data rows so error
  // messages line up with how a user counts tracks, not file lines.
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i]!;
    if (isBlankRow(raw)) continue;

    try {
      tracks.push(parseRow(raw, cols));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Row ${i}: ${message}`);
    }
  }

  return tracks;
}

/**
 * Strip an optional UTF-8 BOM (`\uFEFF`) from the start of the input.
 * Many spreadsheet exports include one; it would otherwise corrupt the
 * first header name.
 */
function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/**
 * Resolve column-name → column-index for each known header.
 *
 * Throws if any required column is missing or if a known header appears
 * more than once (which would silently shadow earlier data).
 */
function buildColumnMap(headerRow: readonly string[]): ColumnMap {
  const indices = new Map<KnownHeader, number>();

  for (let i = 0; i < headerRow.length; i++) {
    const normalized = headerRow[i]!.trim().toLowerCase();
    if (!isKnownHeader(normalized)) continue;
    if (indices.has(normalized)) {
      throw new Error(`Duplicate header: "${normalized}"`);
    }
    indices.set(normalized, i);
  }

  const required: KnownHeader[] = ["title", "key", "bpm"];
  for (const name of required) {
    if (!indices.has(name)) {
      throw new Error(`Missing required column: "${name}"`);
    }
  }

  return {
    title: indices.get("title")!,
    artist: indices.get("artist") ?? null,
    key: indices.get("key")!,
    bpm: indices.get("bpm")!,
  };
}

function isKnownHeader(value: string): value is KnownHeader {
  return (KNOWN_HEADERS as readonly string[]).includes(value);
}

/**
 * Treat a row as blank if every cell is empty or whitespace. Trailing blank
 * lines in CSVs are common and should not cause an error.
 */
function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim().length === 0);
}

/**
 * Build a Track from a raw row using the resolved column map.
 *
 * Per-field normalization is delegated to the specialized modules
 * (`normalizeKey`, `normalizeBpm`, `isExtendedTitle`); this function just
 * orchestrates field extraction, trimming, and required-field checks.
 */
function parseRow(row: readonly string[], cols: ColumnMap): Track {
  const title = required(row, cols.title, "title");
  const key = normalizeKey(required(row, cols.key, "key"));
  const bpm = normalizeBpm(required(row, cols.bpm, "bpm"));

  const artistRaw = cols.artist === null ? "" : (row[cols.artist] ?? "").trim();

  const track: Track = {
    title,
    key,
    bpm,
    extended: isExtendedTitle(title),
  };
  if (artistRaw.length > 0) track.artist = artistRaw;
  return track;
}

/**
 * Extract a required field, trimming whitespace and throwing if it's
 * missing or blank. The error message names the field so per-row context
 * (added by `parseSetlist`) reads cleanly.
 */
function required(row: readonly string[], index: number, name: string): string {
  const value = (row[index] ?? "").trim();
  if (value.length === 0) {
    throw new Error(`Missing required field "${name}"`);
  }
  return value;
}

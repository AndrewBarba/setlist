import type { Sequence } from "../lib/sequence.ts";
import type { Track } from "../lib/types.ts";

/**
 * Render a sequence as a plain-text table-ish layout intended for terminal
 * display.
 *
 * Has a header (`Setlist (N tracks, score: S)`), a separator, and a
 * per-track row with position, Camelot key, BPM, extended marker, and
 * title (with artist appended if present). Transitions appear as
 * `→[0.87]` annotations at the end of each row except the last.
 *
 * If the sequence has any `dropped` tracks (from the `--drop-below`
 * filter), they're appended in a "Dropped" section after a blank line.
 *
 * Designed for monospace fonts; uses Unicode box-drawing characters but
 * no ANSI color codes (keeps output pipeable and screenshot-friendly).
 */
export function formatPretty(seq: Sequence): string {
  if (seq.tracks.length === 0 && seq.dropped.length === 0) {
    return "(empty setlist)";
  }

  const lines: string[] = [];
  const n = seq.tracks.length;
  const header = `Setlist (${n} track${n === 1 ? "" : "s"}, score: ${seq.totalScore.toFixed(3)})`;
  lines.push(header);
  lines.push("─".repeat(Math.max(40, header.length)));

  for (let i = 0; i < n; i++) {
    const t = seq.tracks[i]!;
    const pos = String(i + 1).padStart(2);
    const key = t.key.padEnd(3);
    const bpm = String(t.bpm).padStart(5);
    const ext = t.extended ? "[EXT]" : "     ";
    const title = formatTrackLabel(t);
    const trans = i < seq.transitions.length ? `  →[${seq.transitions[i]!.toFixed(2)}]` : "";
    lines.push(`${pos}. ${key} ${bpm} BPM ${ext} ${title}${trans}`);
  }

  if (seq.dropped.length > 0) {
    lines.push("");
    const d = seq.dropped.length;
    lines.push(`Dropped (${d} track${d === 1 ? "" : "s"}):`);
    for (const t of seq.dropped) {
      lines.push(`  - ${formatTrackLabel(t)}  (${t.bpm} BPM, ${t.key})`);
    }
  }

  return lines.join("\n");
}

/**
 * Render the sequence as JSON. Indented for human readability; the full
 * `Sequence` shape is serialized — `tracks`, `transitions`, `totalScore`,
 * and `dropped` (always present, empty when no filtering occurred).
 */
export function formatJson(seq: Sequence): string {
  return JSON.stringify(seq, null, 2);
}

/**
 * Render the sequence as CSV.
 *
 * Columns: `position,title,artist,key,bpm,extended,score_to_next,status`.
 *
 *   - `position`       — 1-based index in the sequenced order. Empty for
 *     dropped tracks (which have no position in the playback order).
 *   - `score_to_next`  — compatibility score for the transition FROM this
 *     track TO the next, to 4 decimal places. Empty for the final
 *     sequenced track and for all dropped tracks.
 *   - `status`         — `sequenced` or `dropped`. Always present so the
 *     schema is stable whether or not filtering was used.
 *
 * Dropped tracks (if any) appear after all sequenced tracks. Strings
 * containing commas, quotes, or newlines are quoted per RFC 4180.
 */
export function formatCsv(seq: Sequence): string {
  const lines: string[] = [];
  lines.push("position,title,artist,key,bpm,extended,score_to_next,status");

  for (let i = 0; i < seq.tracks.length; i++) {
    const t = seq.tracks[i]!;
    const score = i < seq.transitions.length ? seq.transitions[i]!.toFixed(4) : "";
    lines.push(csvRow(String(i + 1), t, score, "sequenced"));
  }

  for (const t of seq.dropped) {
    lines.push(csvRow("", t, "", "dropped"));
  }

  return lines.join("\n");
}

/**
 * Build a single CSV data row. Pulled into a helper so sequenced and
 * dropped rows share the same column ordering and escaping rules.
 */
function csvRow(
  position: string,
  track: Track,
  score: string,
  status: "sequenced" | "dropped",
): string {
  return [
    position,
    csvEscape(track.title),
    csvEscape(track.artist ?? ""),
    track.key,
    String(track.bpm),
    String(track.extended),
    score,
    status,
  ].join(",");
}

/**
 * Format the display label for a track in the pretty output. Includes
 * artist with an em-dash separator when present.
 */
function formatTrackLabel(track: Track): string {
  return track.artist ? `${track.title} — ${track.artist}` : track.title;
}

/**
 * RFC 4180 CSV escaping: wrap in quotes if the value contains a comma,
 * quote, CR, or LF; double any internal quotes.
 */
function csvEscape(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

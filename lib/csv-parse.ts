/**
 * Minimal RFC 4180 CSV parser, vendored so this library has zero runtime
 * dependencies and runs unchanged in Deno and Node.
 *
 * Returns a 2D array of cells (`string[][]`) — one entry per row, each row
 * being its raw cell values.
 *
 * Recognized syntax:
 *   - `,` as the field separator.
 *   - `\n`, `\r\n`, and bare `\r` as row separators.
 *   - Fields starting with `"` are RFC 4180 quoted: commas and newlines
 *     inside the quotes are content; a literal `"` is encoded as `""`.
 *
 * Behavior choices:
 *   - A bare `"` in an unquoted field is a syntax error (matches the
 *     strictness of `@std/csv`, the parser this replaces). Unbalanced
 *     quotes at end of input are treated leniently — we just close out.
 *   - Fully empty rows (a single empty cell, produced by `\n\n` or a
 *     trailing newline) are dropped. Rows with any non-empty cell are
 *     preserved; whitespace-only multi-cell rows are not the parser's
 *     concern and get filtered by the higher-level CSV layer.
 *
 * This is intentionally smaller than a full-featured CSV library — it
 * does exactly what `parseSetlist` needs and nothing more.
 */
export function parse(input: string): string[][] {
  if (input.length === 0) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const c = input[i]!;

    if (inQuotes) {
      if (c === '"') {
        // Either an RFC 4180 escape (`""` → `"`) or the closing quote.
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }

    // Not inside quotes — handle separators, row endings, and field content.
    if (c === '"') {
      if (field.length > 0) {
        // RFC 4180: a `"` in an unquoted field is malformed. Surface this
        // so callers see real parsing errors rather than silently mangled
        // output.
        throw new SyntaxError(`bare " in unquoted field at offset ${i}`);
      }
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r") {
      // CR or CRLF terminates a row.
      row.push(field);
      pushRow(rows, row);
      row = [];
      field = "";
      i += input[i + 1] === "\n" ? 2 : 1;
    } else if (c === "\n") {
      row.push(field);
      pushRow(rows, row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
      i++;
    }
  }

  // Flush any in-progress field/row at end of input. A trailing newline
  // results in an empty pending row which `pushRow` will drop.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    pushRow(rows, row);
  }

  return rows;
}

/**
 * Append a row unless it represents a fully-empty line. A row produced by
 * a blank input line is exactly `[""]`; multi-cell rows even if every cell
 * is empty (e.g. `,,,` → `["", "", "", ""]`) are preserved and filtered
 * upstream where the higher-level definition of "blank" lives.
 */
function pushRow(rows: string[][], row: string[]): void {
  if (row.length === 1 && row[0] === "") return;
  rows.push(row);
}

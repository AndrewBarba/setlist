#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseSetlist } from "../lib/csv.ts";
import { sequence } from "../lib/sequence.ts";
import { formatCsv, formatJson, formatPretty } from "./format.ts";

const HELP = `setlist — sequence a DJ setlist for harmonic + tempo compatibility

USAGE:
  cat tracks.csv | setlist [OPTIONS]
  setlist [OPTIONS] < tracks.csv

OPTIONS:
  -f, --format <FMT>      Output format: pretty (default), json, or csv
  -s, --seed <N>          PRNG seed for reproducible output
  -i, --iterations <N>    Simulated-annealing iterations (default: scales with N)
  -d, --drop-below <X>    Drop tracks that force transitions below this
                          threshold (0–1). Dropped tracks are reported.
  -h, --help              Show this help and exit

EXAMPLES:
  cat tracks.csv | setlist
  cat tracks.csv | setlist --format json > sequenced.json
  cat tracks.csv | setlist --seed 42 --drop-below 0.3

INPUT:
  CSV on stdin. Required columns: title, key, bpm. Optional: artist.
  Keys may be Camelot (8B) or classical (Am, F# minor, Bb major).
`;

const VALID_FORMATS = new Set(["pretty", "json", "csv"] as const);
type OutputFormat = typeof VALID_FORMATS extends Set<infer T> ? T : never;

/**
 * CLI entry point.
 *
 * Returns the exit code instead of calling `process.exit` directly, so the
 * function is testable in isolation and there's a single explicit point
 * of exit at the bottom of the file.
 *
 * Uses Node-style APIs (`process.*`, `node:util`, `node:url`) throughout.
 * Deno's Node-compat layer accepts these unchanged, so the same source
 * runs in both runtimes.
 */
async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        format: { type: "string", short: "f", default: "pretty" },
        seed: { type: "string", short: "s" },
        iterations: { type: "string", short: "i" },
        "drop-below": { type: "string", short: "d" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    // `parseArgs` throws on unknown flags or malformed input. Surface the
    // message verbatim — it's already user-readable.
    return usage((err as Error).message);
  }

  const values = parsed.values;

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const format = String(values.format);
  if (!isValidFormat(format)) {
    return usage(`invalid --format ${JSON.stringify(format)}; must be one of pretty, json, csv`);
  }

  const seed = parseOptionalInt(values.seed, "seed");
  if (seed instanceof Error) return usage(seed.message);

  const iterations = parseOptionalInt(values.iterations, "iterations");
  if (iterations instanceof Error) return usage(iterations.message);
  if (iterations !== undefined && iterations < 0) {
    return usage("--iterations must be ≥ 0");
  }

  const dropBelow = parseOptionalFloat(values["drop-below"], "drop-below");
  if (dropBelow instanceof Error) return usage(dropBelow.message);
  if (dropBelow !== undefined && (dropBelow < 0 || dropBelow > 1)) {
    return usage("--drop-below must be between 0 and 1");
  }

  // If no input is piped, hanging on stdin would be a terrible UX —
  // surface a hint and exit. The user almost certainly meant `--help`.
  if (process.stdin.isTTY) {
    return usage("no input on stdin; pipe a CSV or see --help");
  }

  const csv = await readAllStdin();
  if (csv.trim().length === 0) {
    return die("empty input on stdin");
  }

  let tracks;
  try {
    tracks = parseSetlist(csv);
  } catch (err) {
    return die(`parse error: ${(err as Error).message}`);
  }

  const result = sequence(tracks, { seed, iterations, dropBelow });
  const output = formatFor(format)(result);
  console.log(output);
  return 0;
}

/**
 * Dispatch to the formatter for a given format name. Pulled into a tiny
 * helper so the main flow stays linear.
 */
function formatFor(format: OutputFormat) {
  switch (format) {
    case "pretty":
      return formatPretty;
    case "json":
      return formatJson;
    case "csv":
      return formatCsv;
  }
}

function isValidFormat(value: string): value is OutputFormat {
  return (VALID_FORMATS as Set<string>).has(value);
}

/**
 * Parse an optional integer-valued flag.
 *
 * Returns `undefined` if the flag was not provided, the parsed integer if
 * valid, or an `Error` if the user passed something we can't interpret.
 */
function parseOptionalInt(raw: string | undefined, name: string): number | undefined | Error {
  if (raw === undefined) return undefined;
  const text = String(raw);
  if (!/^-?\d+$/.test(text)) {
    return new Error(`invalid --${name} ${JSON.stringify(text)} (expected integer)`);
  }
  return Number(text);
}

/**
 * Parse an optional float-valued flag. Accepts integers and decimals,
 * optionally signed. Rejects empty strings and non-numeric input.
 */
function parseOptionalFloat(raw: string | undefined, name: string): number | undefined | Error {
  if (raw === undefined) return undefined;
  const text = String(raw);
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    return new Error(`invalid --${name} ${JSON.stringify(text)} (expected number)`);
  }
  return Number(text);
}

/**
 * Read stdin to completion as a UTF-8 string. Uses Node's async iterator
 * on `process.stdin`, which Deno's Node-compat layer also implements.
 */
async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as string);
  }
  return chunks.join("");
}

/**
 * Emit a usage error to stderr and return the usage exit code (2).
 *
 * Usage errors are distinct from runtime errors (which return 1) so that
 * shell scripts can react differently to "you called me wrong" versus
 * "you called me right but the input was bad."
 */
function usage(message: string): number {
  console.error(`setlist: ${message}`);
  console.error("Try 'setlist --help' for usage.");
  return 2;
}

/**
 * Emit a runtime error to stderr and return the general error exit code (1).
 */
function die(message: string): number {
  console.error(`setlist: ${message}`);
  return 1;
}

/**
 * Determine whether this module is being executed directly (as opposed to
 * imported).
 *
 * Strategy:
 *   - **Deno**: `import.meta.main` is explicitly set by the runtime; trust
 *     it directly. This also avoids needing `--allow-read` (which would be
 *     required for the `realpathSync` fallback to succeed under Deno's
 *     permission model).
 *   - **Node**: `import.meta.main` is not implemented, so we compare the
 *     resolved real paths of `process.argv[1]` (the entry script — may be
 *     a symlink in npm's bin/ layout) and the URL of this module. Resolving
 *     symlinks on both sides is what makes this work when npm installs
 *     the package's `bin` as a symlink under `node_modules/.bin/`.
 */
function isMainModule(): boolean {
  // Deno path: `import.meta.main` is a boolean on Deno's ImportMeta.
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;

  // Node path: realpath comparison.
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryReal = realpathSync(entry);
    const metaReal = realpathSync(fileURLToPath(import.meta.url));
    return entryReal === metaReal;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(await main(process.argv.slice(2)));
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Export, sequence, and sync a djay Pro playlist

USAGE:
  npm run djay -- --name <PLAYLIST>

OPTIONS:
  -n, --name <NAME>  djay Pro playlist name (required)
  -s, --seed <N>     Reproducible setlist seed
  -k, --ignore-bpm   Sequence by harmonic compatibility only
      --db <PATH>    MediaLibrary.db path (defaults to ~/Music/djay/...)
  -h, --help         Show this help
`;

function main(): void {
  const args = parseArgs({
    options: {
      name: { type: "string", short: "n" },
      seed: { type: "string", short: "s" },
      "ignore-bpm": { type: "boolean", short: "k" },
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

  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const tempDir = mkdtempSync(join(tmpdir(), "setlist-djay-organize-"));
  const csvPath = join(tempDir, "playlist.csv");
  const sharedArgs = ["--name", name];
  if (args.values.db) sharedArgs.push("--db", args.values.db);

  try {
    execFileSync(
      process.execPath,
      [join(scriptsDir, "export-djay-playlist.ts"), ...sharedArgs, "--output", csvPath],
      { stdio: "pipe" },
    );

    const syncArgs = [join(scriptsDir, "reorder-djay-playlist.ts"), ...sharedArgs];
    if (args.values.seed) syncArgs.push("--seed", args.values.seed);
    if (args.values["ignore-bpm"]) syncArgs.push("--ignore-bpm");
    syncArgs.push(csvPath);
    execFileSync(process.execPath, syncArgs, { stdio: "inherit" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function usage(message: string): never {
  process.stderr.write(`organize-djay-playlist: ${message}\n\n${HELP}`);
  process.exit(2);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`organize-djay-playlist: ${message}\n`);
  process.exitCode = 1;
}

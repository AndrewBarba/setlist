import type { CamelotKey, CamelotNumber, KeyFormat } from "./types.ts";

/**
 * Matches a Camelot key: a number 1–12 followed by `A` (minor) or `B` (major).
 * Case-insensitive; the input is expected to be trimmed before testing.
 *
 * Examples: `1A`, `8B`, `12a`.
 */
const CAMELOT_PATTERN = /^(1[0-2]|[1-9])([AB])$/i;

/**
 * Matches a classical key in standard music notation.
 *
 * Breakdown of capture groups:
 *   1. Root note (A–G), case-insensitive — both `C` and `c` accepted.
 *   2. Optional accidental: ASCII `#` / `b` (lowercase only) or unicode
 *      `♯` / `♭`. Uppercase `B` is deliberately NOT a flat — it's a note
 *      name, so e.g. `dB` is rejected as ambiguous.
 *   3. Optional mode suffix: `m`, `M`, `maj`, `min`, `major`, `minor`,
 *      and common case variants (`Maj`, `MAJ`, `Major`, `MAJOR`, etc.).
 *      Absence of a mode implies major.
 *
 * Examples: `C`, `Cm`, `C#`, `Db`, `F# minor`, `Bb major`, `A minor`, `CM`.
 *
 * Note: the lowercase `b` accidental and the lowercase `m` minor marker are
 * disambiguated by position — accidentals come immediately after the root,
 * while the mode comes after any optional whitespace.
 *
 * The `/i` flag is intentionally NOT used here: case matters for the
 * accidental (b vs B) and for distinguishing the `m` minor marker from the
 * `M` major shorthand.
 */
const CLASSICAL_PATTERN =
  /^([A-Ga-g])([#b♯♭])?\s*([Mm]aj(?:or)?|MAJ(?:OR)?|[Mm]in(?:or)?|MIN(?:OR)?|m|M)?$/;

/**
 * Type guard: does the input look like a canonical Camelot key?
 *
 * Performs a syntactic check only — accepts any string of the shape
 * `<1-12><A|B>`. Whitespace is tolerated; case is ignored.
 */
export function isCamelotKey(input: string): input is CamelotKey {
  return CAMELOT_PATTERN.test(input.trim());
}

/**
 * Does the input look like a classical (standard notation) key?
 *
 * Accepts a root note, an optional accidental, and an optional mode suffix.
 * This is a syntactic check, not a normalization — `parseClassicalKey` will
 * do the actual decomposition later in the pipeline.
 */
export function isClassicalKey(input: string): boolean {
  return CLASSICAL_PATTERN.test(input.trim());
}

/**
 * Detect which notation a raw key string is written in.
 *
 * Returns `"camelot"` for Camelot wheel notation, `"classical"` for standard
 * music notation, or `null` if the input matches neither.
 *
 * Camelot is checked first because it's a strict, unambiguous format; the
 * classical regex is more permissive and would otherwise need to know not to
 * match things like `8A` (it doesn't, but the ordering documents intent).
 */
export function detectKeyFormat(input: string): KeyFormat | null {
  const trimmed = input.trim();
  if (CAMELOT_PATTERN.test(trimmed)) return "camelot";
  if (CLASSICAL_PATTERN.test(trimmed)) return "classical";
  return null;
}

/**
 * Pitch class (0–11) of each natural root, with C = 0.
 *
 *   C=0  D=2  E=4  F=5  G=7  A=9  B=11
 */
const ROOT_PITCH_CLASS: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * Camelot key for each major pitch class, indexed by pitch class (0–11).
 *
 * Derived from the Camelot wheel: 8B = C major, then each step of +7
 * semitones (perfect fifth) moves +1 around the wheel. Enharmonic spellings
 * collapse to the same pitch class, so e.g. C# major and Db major both → 3B.
 */
const MAJOR_BY_PITCH_CLASS: readonly CamelotKey[] = [
  "8B", // 0  C
  "3B", // 1  C# / Db
  "10B", // 2  D
  "5B", // 3  D# / Eb
  "12B", // 4  E
  "7B", // 5  F
  "2B", // 6  F# / Gb
  "9B", // 7  G
  "4B", // 8  G# / Ab
  "11B", // 9  A
  "6B", // 10 A# / Bb
  "1B", // 11 B
];

/**
 * Camelot key for each minor pitch class, indexed by pitch class (0–11).
 *
 * Relative minor of a major key sits at the same Camelot number on the
 * inner (A) ring — e.g. A minor (relative of C major) → 8A.
 */
const MINOR_BY_PITCH_CLASS: readonly CamelotKey[] = [
  "5A", // 0  C
  "12A", // 1  C# / Db
  "7A", // 2  D
  "2A", // 3  D# / Eb
  "9A", // 4  E
  "4A", // 5  F
  "11A", // 6  F# / Gb
  "6A", // 7  G
  "1A", // 8  G# / Ab
  "8A", // 9  A
  "3A", // 10 A# / Bb
  "10A", // 11 B
];

/**
 * Decompose a classical key string into pitch class + mode.
 *
 * Returns `null` if the input doesn't match the classical pattern. Caller
 * is expected to have already classified the input via `detectKeyFormat`.
 */
function parseClassicalKey(
  trimmed: string,
): { pitchClass: number; mode: "major" | "minor" } | null {
  const match = CLASSICAL_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, rootRaw, accidental, modeRaw] = match;
  const rootPc = ROOT_PITCH_CLASS[rootRaw!.toUpperCase()];
  if (rootPc === undefined) return null;

  // Apply accidental: # raises a semitone, b lowers it. Wrap with mod 12.
  let pitchClass = rootPc;
  if (accidental === "#" || accidental === "♯") {
    pitchClass = (pitchClass + 1) % 12;
  } else if (accidental === "b" || accidental === "♭") {
    pitchClass = (pitchClass + 11) % 12;
  }

  return { pitchClass, mode: parseMode(modeRaw) };
}

/**
 * Resolve a mode suffix to `"major"` or `"minor"`.
 *
 * Conventions handled:
 *   - missing suffix         → major (e.g. `C` = C major)
 *   - lowercase `m`          → minor (e.g. `Cm` = C minor)
 *   - uppercase `M`          → major (chord-shorthand convention)
 *   - `min` / `minor`        → minor (case-insensitive)
 *   - `maj` / `major`        → major (case-insensitive)
 */
function parseMode(raw: string | undefined): "major" | "minor" {
  if (!raw) return "major";
  if (raw === "m") return "minor";
  if (raw === "M") return "major";
  return raw.toLowerCase().startsWith("min") ? "minor" : "major";
}

/**
 * Canonicalize an already-Camelot string (uppercase mode, trim whitespace).
 *
 * Returns `null` if the input doesn't match the Camelot pattern.
 */
function canonicalizeCamelot(trimmed: string): CamelotKey | null {
  const match = CAMELOT_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, numberRaw, modeRaw] = match;
  const number = Number(numberRaw) as CamelotNumber;
  const mode = modeRaw!.toUpperCase() as "A" | "B";
  return `${number}${mode}` as CamelotKey;
}

/**
 * Normalize any supported key string to its canonical Camelot form.
 *
 * Accepts:
 *   - Camelot notation (`8A`, `12b`, `  8a  `) — casing/whitespace are
 *     canonicalized.
 *   - Classical notation (`Am`, `C# minor`, `Bb major`, `Db`, `F#m`) —
 *     converted via pitch-class lookup. Enharmonic spellings collapse
 *     correctly (e.g. `C#` and `Db` both → `3B`).
 *
 * Throws `Error` with the offending input if it matches neither format.
 */
export function normalizeKey(input: string): CamelotKey {
  const trimmed = input.trim();

  const camelot = canonicalizeCamelot(trimmed);
  if (camelot) return camelot;

  const parsed = parseClassicalKey(trimmed);
  if (parsed) {
    const table = parsed.mode === "major" ? MAJOR_BY_PITCH_CLASS : MINOR_BY_PITCH_CLASS;
    // pitchClass is constrained to 0–11 by parseClassicalKey, so the lookup
    // is always defined; the non-null assertion is safe.
    return table[parsed.pitchClass]!;
  }

  throw new Error(`Unrecognized key: ${JSON.stringify(input)}`);
}

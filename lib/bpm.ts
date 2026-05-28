import type { Bpm } from "./types.ts";

/**
 * Lower bound for accepted BPM values. Anything slower than this is almost
 * certainly a parsing error (or half-time annotation that hasn't been
 * un-folded yet — that's a normalization concern for a later layer).
 */
const MIN_BPM = 40;

/**
 * Upper bound for accepted BPM values. Speedcore tops out around 250–300;
 * anything past this range is almost certainly a parsing error rather than a
 * real tempo.
 */
const MAX_BPM = 250;

/**
 * Matches a BPM string: digits, an optional decimal part, optional
 * whitespace, and an optional `bpm` / `BPM` suffix.
 *
 *   `128`, `128.5`, `128 BPM`, `128bpm`, `128.50 bpm`
 *
 * Deliberately rejected:
 *   - leading sign (`+128`, `-128`)
 *   - scientific notation (`1.28e2`)
 *   - comma decimals (`128,5`) — locale-dependent, ambiguous
 *   - bare decimal point (`.5`)
 */
const BPM_PATTERN = /^(\d+(?:\.\d+)?)\s*(?:bpm)?$/i;

/**
 * Type guard: is a number a validated BPM value?
 *
 * Accepts finite numbers within {@link MIN_BPM}–{@link MAX_BPM}. Rejects
 * `NaN`, `Infinity`, and out-of-range values. Useful for narrowing a `number`
 * that may already have been parsed elsewhere.
 */
export function isBpm(value: number): value is Bpm {
  return Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM;
}

/**
 * Parse a raw BPM string into a numeric value. Returns `null` on syntactic
 * mismatch (so the caller can attach context to the error).
 *
 * Note: range validation is intentionally NOT done here — that's
 * {@link isBpm}'s job. This function only handles the string → number step.
 */
function parseBpmString(input: string): number | null {
  const match = BPM_PATTERN.exec(input.trim());
  if (!match) return null;
  // Group 1 is the numeric portion; guaranteed present when the pattern matches.
  return Number(match[1]);
}

/**
 * Normalize any supported BPM input to a canonical {@link Bpm}.
 *
 * Accepts:
 *   - Number inputs (must be finite and in {@link MIN_BPM}–{@link MAX_BPM}).
 *   - String inputs in the form `128`, `128.5`, `128 BPM`, `128bpm`, etc.
 *
 * Throws `Error` with the offending input if it cannot be parsed or is out
 * of the supported range.
 *
 * Half/double-time normalization (e.g. mapping a 70 BPM downtempo tag to its
 * 140 BPM equivalent) is intentionally NOT performed here — that's a
 * sequencing concern, not a parsing concern.
 */
export function normalizeBpm(input: string | number): Bpm {
  const value = typeof input === "number" ? input : parseBpmString(input);

  if (value === null || !isBpm(value)) {
    throw new Error(`Invalid BPM: ${JSON.stringify(input)}`);
  }

  return value;
}

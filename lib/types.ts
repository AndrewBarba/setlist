/**
 * Camelot wheel position (1–12). Each position represents a key signature; the
 * inner ring (A) is minor, the outer ring (B) is major.
 */
export type CamelotNumber =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12;

/**
 * Camelot mode: `A` = minor (inner ring), `B` = major (outer ring).
 */
export type CamelotMode = "A" | "B";

/**
 * Canonical Camelot key, e.g. `"8A"`, `"12B"`. All keys in normalized tracks
 * are expressed in this form.
 */
export type CamelotKey = `${CamelotNumber}${CamelotMode}`;

/**
 * Identifies which notation a raw key string is written in.
 *
 * - `camelot`   — already in Camelot form (e.g. `8A`, `12B`).
 * - `classical` — written in standard music notation (e.g. `Am`, `F# minor`,
 *   `Db major`).
 */
export type KeyFormat = "camelot" | "classical";

/**
 * Brand symbol for {@link Bpm}. Phantom-only; never present at runtime.
 */
declare const bpmBrand: unique symbol;

/**
 * A beats-per-minute value that has been parsed and validated.
 *
 * Branded `number`: structurally a number at runtime, but distinct from raw
 * `number` in the type system so that unvalidated inputs cannot be assigned
 * where a normalized BPM is expected. The only way to obtain a `Bpm` is
 * through {@link normalizeBpm} (or the {@link isBpm} type guard).
 */
export type Bpm = number & { readonly [bpmBrand]: never };

/**
 * A track after parsing + normalization. Keys are always Camelot and BPMs
 * are always validated `Bpm` values at this point.
 */
export interface Track {
  title: string;
  artist?: string;
  key: CamelotKey;
  bpm: Bpm;
  extended: boolean;
}

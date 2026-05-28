/**
 * Patterns that signal an "extended" (full-length, DJ-oriented) version of
 * a track based on conventions in dance music release titles.
 *
 * Each pattern is case-insensitive and uses word boundaries where possible
 * to avoid spurious matches inside unrelated words.
 *
 * Coverage:
 *   - `extended`   — Extended Mix / Extended Version / Extended Edit / bare
 *                    "(Extended)". The most common modern marker.
 *   - `club mix`   — Club Mix / Club Edit. Dancefloor-oriented full cut.
 *   - `long ...`   — Long Mix / Long Version / Long Edit. Less common today.
 *   - `12"` / `12 inch` — Vinyl-era marker for the extended pressing.
 *
 * Deliberately NOT included:
 *   - `original mix` — ambiguous; could be radio length or full length.
 *   - `dub mix`      — usually long but not guaranteed.
 *   - `remix`        — orthogonal to length; remixes come in both flavors.
 *
 * Negative markers (e.g. `radio edit`) are not checked here. If a future
 * caller wants override behavior, that belongs in a separate layer.
 */
const EXTENDED_PATTERNS: readonly RegExp[] = [
  /\bextended\b/i,
  /\bclub\s+(?:mix|edit)\b/i,
  /\blong\s+(?:mix|edit|version)\b/i,
  // `12"` (possibly `12 "`), or `12 inch` / `12-inch` / `12inch`.
  /\b12\s*"/,
  /\b12[\s-]*inch\b/i,
];

/**
 * Best-guess detection of whether a track title refers to an extended
 * (full-length, DJ-oriented) version.
 *
 * Returns `true` if any known extended marker appears in the title;
 * `false` otherwise. This is heuristic, not authoritative — it's intended
 * for use as a default when the source CSV doesn't include explicit
 * length/version metadata.
 */
export function isExtendedTitle(title: string): boolean {
  return EXTENDED_PATTERNS.some((pattern) => pattern.test(title));
}

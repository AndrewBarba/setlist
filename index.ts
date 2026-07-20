export type { Bpm, CamelotKey, CamelotMode, CamelotNumber, KeyFormat, Track } from "./lib/types.ts";

export { detectKeyFormat, isCamelotKey, isClassicalKey, normalizeKey } from "./lib/key.ts";

export { isBpm, normalizeBpm } from "./lib/bpm.ts";

export { isExtendedTitle } from "./lib/extended.ts";

export { parseSetlist } from "./lib/csv.ts";

export type { CamelotDistance } from "./lib/harmonic.ts";
export { camelotDistance, harmonicScore } from "./lib/harmonic.ts";

export type { BpmDelta } from "./lib/tempo.ts";
export { bpmDelta, bpmScore } from "./lib/tempo.ts";

export type { ScoreFn } from "./lib/compat.ts";
export { compatibility, harmonicCompatibility } from "./lib/compat.ts";

export type { Sequence, SequenceOptions } from "./lib/sequence.ts";
export { sequence } from "./lib/sequence.ts";

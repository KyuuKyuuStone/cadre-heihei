/** Immutable Session-generation filenames used by recorded-session fixtures. */
/** One canonical recorded-session fixture filename. */
export interface SessionFixtureFile {
    /** Parent is `0`; positive values are child/ordinal slots. */
    readonly index: number;
    /** Physical Session format generation; zero is encoded by omission. */
    readonly version: number;
    /** Canonical filename. */
    readonly name: string;
}
/** One canonical persistence filename in a Session's own storage directory. */
export interface PersistedSessionFile {
    /** Physical Session format generation; zero is encoded by omission. */
    readonly version: number;
    /** Physical compression selected by the backend. */
    readonly compression: 'raw' | 'zstd';
    /** Canonical basename. */
    readonly name: string;
}
/**
 * Return the canonical fixture filename for one parent/ordinal and generation.
 *
 * @param index - Parent `0` or a positive child/ordinal slot.
 * @param version - Physical format generation; `0` is omitted.
 * @returns The lowercase canonical JSONL filename.
 */
export declare function sessionFixtureName(index: number, version: number): string;
/**
 * Name the native-writer oracle for a retained historical replay role.
 * This expected output never participates in replay generation selection.
 * @param index - Parent `0` or a positive child/ordinal slot.
 * @returns The expected-output JSONL basename.
 */
export declare function writerSnapshotName(index: number): string;
/**
 * Parse one canonical recorded-session fixture filename.
 *
 * @param name - Basename from a scenario directory.
 * @returns Parsed role and generation, or `undefined` for an unrelated file.
 */
export declare function parseSessionFixtureName(name: string): SessionFixtureFile | undefined;
/**
 * Select the highest generation for every parent/ordinal fixture role.
 * Older generations remain in the directory but do not count as extra Sessions.
 *
 * @param names - File basenames in one scenario directory.
 * @returns Parent first, followed by contiguous child/ordinal roles.
 */
export declare function sessionFixtureFiles(names: readonly string[]): SessionFixtureFile[];
/**
 * Validate and order a scenario directory's selected Session fixture filenames.
 *
 * @param names - File basenames in one scenario directory.
 * @returns Highest-generation parent and child/ordinal filenames.
 */
export declare function sessionFixtureNames(names: readonly string[]): string[];
/**
 * Read the declared physical generation from one Session JSONL header.
 *
 * @param content - Complete UTF-8 JSONL content.
 * @param label - Diagnostic filename or path.
 * @returns The declared non-negative format generation.
 */
export declare function sessionHeaderVersion(content: string, label: string): number;
/**
 * Require one fixture's canonical filename generation to equal its header.
 *
 * @param name - Canonical fixture basename.
 * @param content - Complete UTF-8 JSONL content.
 * @returns The validated format generation.
 */
export declare function assertSessionFixtureVersion(name: string, content: string): number;
/**
 * Return the canonical persistence basename for one generation and compression.
 *
 * @param version - Physical format generation; `0` is omitted.
 * @param compression - Backend compression mode.
 * @returns The canonical persistence basename.
 */
export declare function persistedSessionFilename(version: number, compression?: 'raw' | 'zstd'): string;
/**
 * Parse a canonical persistence basename from a Session's own directory.
 *
 * @param name - Candidate basename.
 * @returns Its generation and compression, or `undefined` for noise and noncanonical names.
 */
export declare function parsePersistedSessionFilename(name: string): PersistedSessionFile | undefined;
/**
 * Select one highest-generation persistence path per physical Session directory.
 *
 * @param paths - Relative or absolute paths beneath a sessions root.
 * @param compression - Compression selected by the snapshot composition.
 * @returns Stable path order with older generations and filesystem noise omitted.
 */
export declare function latestPersistedSessionPaths(paths: readonly string[], compression?: 'raw' | 'zstd'): string[];
/**
 * Require one persistence basename's generation to equal its Session header.
 *
 * @param name - Canonical persistence basename.
 * @param content - Complete uncompressed UTF-8 JSONL content.
 * @returns The validated generation.
 */
export declare function assertPersistedSessionVersion(name: string, content: string): number;
//# sourceMappingURL=session-files.d.ts.map
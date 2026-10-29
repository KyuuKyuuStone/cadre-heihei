/** Build stamp shared by the cadre CJS build script, its gate and the packaging preflight. */

/** One emitted CJS bundle. */
export interface CadreBuildOutput {
  /** Desktop-relative POSIX path. */
  readonly path: string
  /** SHA-256 of the emitted file. */
  readonly sha256: string
  /** Emitted size in bytes. */
  readonly bytes: number
}

/** Stamp written after a successful build of both CJS bundles. */
export interface CadreBuildStamp {
  /** Layout version; a mismatch means the gate cannot trust the file. */
  readonly version: number
  /** ISO timestamp of the build. */
  readonly builtAt: string
  /** esbuild version used for both outputs. */
  readonly esbuildVersion: string
  /** Aggregate hash over every bundled source path and file hash. */
  readonly sourceHash: string
  /** Number of bundled source files. */
  readonly sourceFiles: number
  /** Per-file SHA-256 keyed by desktop-relative POSIX path. */
  readonly sources: Readonly<Record<string, string>>
  /** Emitted bundles with their hashes. */
  readonly outputs: readonly CadreBuildOutput[]
}

/** Result of reading a stamp: the validated value, or a human-readable problem. */
export type CadreStampRead =
  | { readonly stamp: CadreBuildStamp }
  | { readonly problem: string }

export const CADRE_BUILD_STAMP_VERSION: number
export const CADRE_SOURCE_DIR: string
export const CADRE_STAMP_PATH: string
export const CADRE_OUTPUTS: readonly string[]

/**
 * List every bundled source file as a desktop-relative POSIX path.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns sorted relative paths.
 */
export function listCadreSources(desktopRoot: string): string[]

/**
 * SHA-256 of one file.
 * @param path - absolute path.
 * @returns lowercase hex digest.
 */
export function hashFile(path: string): string

/**
 * Hash every bundled source file, returning both per-file and aggregate digests.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns per-file hashes keyed by relative path, aggregate hash and count.
 */
export function computeCadreSourceHashes(desktopRoot: string): {
  sources: Record<string, string>
  sourceHash: string
  count: number
}

/**
 * Read and shape-check the stamp written by the build.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns the validated stamp, or a problem string suitable for a failure message.
 */
export function readCadreStamp(desktopRoot: string): CadreStampRead

/**
 * Validate one parsed stamp object.
 * @param value - parsed JSON value.
 * @returns `{ stamp }` when the layout is usable, otherwise `{ problem }`.
 */
export function validateCadreStamp(value: unknown): CadreStampRead

/**
 * Size of one built artifact in bytes.
 * @param path - absolute path.
 * @returns byte length.
 */
export function fileBytes(path: string): number

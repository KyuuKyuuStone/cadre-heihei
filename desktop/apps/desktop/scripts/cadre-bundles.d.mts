/** Packaging guards for the two gitignored cadre CJS bundles. */

/** Absolute desktop-relative output paths. */
export interface CadreBundlePaths {
  readonly main: string
  readonly host: string
}

export const CADRE_BUNDLE_PATHS: readonly string[]
export const CADRE_ASAR_ENTRIES: readonly string[]

/**
 * Resolve the two bundled CJS outputs.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns absolute output paths.
 */
export function cadreBundlePaths(desktopRoot: string): CadreBundlePaths

/**
 * Ensure both CJS bundles exist, rebuilding them when either is missing.
 * @param desktopRoot - absolute `desktop/` directory.
 * @param options - optional rebuild seam used by tests.
 * @returns whether a rebuild was needed.
 */
export function ensureCadreBundles(
  desktopRoot: string,
  options?: { readonly build?: (desktopRoot: string) => void },
): { readonly rebuilt: boolean }

/**
 * Read every file path from an asar archive header.
 * @param asarPath - absolute `app.asar`.
 * @returns POSIX-style file paths inside the archive.
 */
export function readAsarFilePaths(asarPath: string): string[]

/**
 * Fail when the built `app.asar` lacks either cadre CJS bundle.
 * @param asarPath - absolute `app.asar` written by electron-builder.
 * @returns nothing; throws when an entry is missing.
 */
export function assertCadreAsarEntries(asarPath: string): void

/**
 * Resolve the `app.asar` path electron-builder writes for one target.
 * @param target - packaging target.
 * @param artifactsRoot - directory electron-builder writes to.
 * @returns absolute `app.asar`.
 */
export function cadreAsarPath(
  target: { readonly platform: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' },
  artifactsRoot: string,
): string

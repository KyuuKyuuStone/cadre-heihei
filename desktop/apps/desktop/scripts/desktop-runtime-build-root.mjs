/** Resolve and create the fixed per-account scratch root for per-run Desktop runtime preparation. */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const RUNTIME_BUILD_ROOT_ENV = 'DSH_DESKTOP_RUNTIME_BUILD_ROOT'

/**
 * Resolve the parent directory that holds one runtime preparation scratch tree per packaging run:
 * the `DSH_DESKTOP_RUNTIME_BUILD_ROOT` override, or a fixed per-account directory that, like the
 * pnpm store, sits outside both the repository and the system temporary directory so operating-system
 * temporary-directory cleanup cannot delete an active run and the location is stable across machines.
 * @param {NodeJS.ProcessEnv} environment Packaging configuration.
 * @returns {string} Absolute directory; per-run trees are created inside it and deleted when their run ends.
 * @throws The override is set but not an absolute directory path, or contains NUL, CR or LF.
 */
export function resolveDesktopRuntimeBuildRoot(environment = process.env) {
  const configured = environment[RUNTIME_BUILD_ROOT_ENV]
  if (configured === undefined) return join(homedir(), '.dsh-desktop-build', 'runtime')
  if (!isAbsolute(configured) || /[\0\r\n]/u.test(configured)) {
    throw new Error(`${RUNTIME_BUILD_ROOT_ENV} must be an absolute directory path`)
  }
  return resolve(configured)
}

/**
 * Create a fresh per-run scratch tree inside the resolved root. The random `mkdtemp` suffix isolates
 * concurrent packaging runs; callers delete the returned directory when their run ends.
 * @param {NodeJS.ProcessEnv} environment Packaging configuration passed to the resolver.
 * @returns {string} Absolute path of the created scratch tree.
 */
export function createDesktopRuntimeBuildRoot(environment = process.env) {
  const parent = resolveDesktopRuntimeBuildRoot(environment)
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, 'dsh-desktop-runtime-'))
}

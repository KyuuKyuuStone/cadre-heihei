/**
 * Packaging guards for the two gitignored cadre CJS bundles.
 *
 * A clean `pnpm install` builds neither `apps/desktop/lib/cadre-collab.cjs` nor
 * `packages/cadre/host-collab/lib/cadre-ledger.cjs`, and the unsigned target
 * command does not run `release.mjs`. Without these guards a package can be
 * produced without the ledger bridge and the installed app cannot read tasks.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Desktop-relative paths the package must contain after the build step. */
export const CADRE_BUNDLE_PATHS = [
  'apps/desktop/lib/cadre-collab.cjs',
  'packages/cadre/host-collab/lib/cadre-ledger.cjs',
]

/** Entries `app.asar` must contain; the second one lives in the bundled dsh. */
export const CADRE_ASAR_ENTRIES = [
  'lib/cadre-collab.cjs',
  'dsh/node_modules/@deepseek-ai/dsh-host-collab/lib/cadre-ledger.cjs',
]

function absolute(desktopRoot, relativePath) {
  return join(desktopRoot, ...relativePath.split('/'))
}

/**
 * Resolve the two bundled CJS outputs.
 * @param {string} desktopRoot - absolute `desktop/` directory.
 * @returns {{ main: string, host: string }} absolute output paths.
 */
export function cadreBundlePaths(desktopRoot) {
  return {
    main: absolute(desktopRoot, CADRE_BUNDLE_PATHS[0]),
    host: absolute(desktopRoot, CADRE_BUNDLE_PATHS[1]),
  }
}

function missingBundles(desktopRoot) {
  const paths = cadreBundlePaths(desktopRoot)
  return Object.values(paths).filter(path => !existsSync(path))
}

/**
 * Ensure both CJS bundles exist, rebuilding them when either is missing.
 *
 * This runs after the repository build (so tsdown cannot overwrite the outputs)
 * and before `prepare:packages` copies the host package into the dsh payload.
 * A failed or ineffective build is fatal: publishing without the ledger bridge
 * is exactly the 0.9.3 defect.
 * @param {string} desktopRoot - absolute `desktop/` directory.
 * @param {{ build?: (desktopRoot: string) => void }} [options] - Test seam for the rebuild command.
 * @returns {{ rebuilt: boolean }} whether a build was needed.
 */
export function ensureCadreBundles(desktopRoot, options = {}) {
  const missing = missingBundles(desktopRoot)
  if (missing.length === 0) return { rebuilt: false }

  console.log(`[cadre-bundles] missing ${missing.join(', ')}; rebuilding before packaging`)
  if (options.build === undefined) {
    const result = spawnSync(process.execPath, [join(desktopRoot, 'scripts', 'build-cadre-collab.mjs')], {
      cwd: desktopRoot,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      throw new Error(`[cadre-bundles] build-cadre-collab.mjs failed with ${String(result.status ?? result.signal)}`)
    }
  } else {
    options.build(desktopRoot)
  }

  const stillMissing = missingBundles(desktopRoot)
  if (stillMissing.length > 0) {
    throw new Error(`[cadre-bundles] packaging stopped: missing ${stillMissing.join(', ')} after the build; `
      + 'run `node desktop/scripts/build-cadre-collab.mjs` and retry')
  }
  return { rebuilt: true }
}

/**
 * Read every file path from an asar archive header.
 * @param {string} asarPath - absolute `app.asar`.
 * @returns {string[]} POSIX-style file paths inside the archive.
 */
export function readAsarFilePaths(asarPath) {
  const buffer = readFileSync(asarPath)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  const paths = []
  const walk = (node, prefix) => {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (meta.files !== undefined) walk(meta, path)
      else paths.push(path)
    }
  }
  walk(header, '')
  return paths
}

/**
 * Fail when the built `app.asar` lacks either cadre CJS bundle.
 * @param {string} asarPath - absolute `app.asar` written by electron-builder.
 * @returns {void}
 */
export function assertCadreAsarEntries(asarPath) {
  if (!existsSync(asarPath)) {
    throw new Error(`[cadre-bundles] packaging stopped: ${asarPath} is missing`)
  }
  const entries = new Set(readAsarFilePaths(asarPath))
  const missing = CADRE_ASAR_ENTRIES.filter(entry => !entries.has(entry))
  if (missing.length > 0) {
    throw new Error(`[cadre-bundles] packaging stopped: app.asar is missing ${missing.join(', ')}; `
      + 'the installed app would lose the task ledger')
  }
  console.log(`[cadre-bundles] app.asar contains ${CADRE_ASAR_ENTRIES.join(' + ')}`)
}

/**
 * Resolve the `app.asar` path electron-builder writes for one target.
 * @param {{ platform: 'darwin' | 'win32', arch: 'arm64' | 'x64' }} target - packaging target.
 * @param {string} artifactsRoot - directory electron-builder writes to.
 * @returns {string} absolute `app.asar`.
 */
export function cadreAsarPath(target, artifactsRoot) {
  const application = target.platform === 'win32'
    ? join(artifactsRoot, 'win-unpacked')
    : join(artifactsRoot, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Cadre Heihei.app', 'Contents')
  return join(application, target.platform === 'win32' ? 'resources' : 'Resources', 'app.asar')
}

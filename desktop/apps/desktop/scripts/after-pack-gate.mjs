/**
 * Single afterPack gate for desktop packaging.
 *
 * The config factory previously declared two `afterPack` hooks in one object
 * literal; JavaScript keeps the last property, so the packaged-secrets scan
 * silently never ran and only the runtime verification survived. The factory
 * now builds this one gate: secret-like content fails the run first, the
 * packaged runtime tree is verified only on a clean scan, and any failure
 * aborts packaging. `assertObjectKeyDeclaredOnce` pins that regression shut.
 */

import { join } from 'node:path'
import { scanAsar, scanDir } from './check-no-secrets.mjs'

/**
 * Count the object-literal-level declarations of one key in a source text.
 * Matching is line-anchored, so prose or comments that merely mention the key
 * do not count; a nested object with deeper indentation would still count,
 * which is the failure shape this guard exists to catch.
 * @param {string} source - full source text of the factory module.
 * @param {string} key - object key to count, for example `afterPack`.
 * @returns {number} declaration count at line-anchor level.
 */
export function countObjectKeyDeclarations(source, key) {
  return [...source.matchAll(new RegExp(`^\\s*${key}\\s*:`, 'gm'))].length
}

/**
 * Fail unless `key` is declared exactly once: a duplicated hook key in the
 * builder config is not a syntax error, electron-builder silently keeps only
 * the last hook and drops the earlier one.
 * @param {string} source - full source text of the factory module.
 * @param {string} key - object key that must be declared exactly once.
 * @param {string} label - module label named in the failure message.
 * @returns {void} throws when the declaration count differs from one.
 */
export function assertObjectKeyDeclaredOnce(source, key, label) {
  const count = countObjectKeyDeclarations(source, key)
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one ${key} declaration, found ${String(count)}; a duplicate key silently keeps only the last hook.`)
  }
}

/**
 * Build the single afterPack hook electron-builder awaits after packing.
 *
 * Stage order is the contract: (1) reject secret-like content — a hit aborts
 * packaging before any later stage can consume the tree; (2) verify the
 * packaged runtime tree; (3) verify the unsigned-Windows asar unpack. The
 * scan uses `packager.getResourcesDir`, which equals `appOutDir/resources` on
 * Windows/Linux and the `.app` Contents/Resources on macOS, so the scan sees
 * the directory `app.asar` actually ships in on every platform.
 * @param {object} deps - collaborators the config factory binds from its scope.
 * @param {() => void | Promise<void>} [deps.writeMacOSAppUpdate] - macOS-only
 *   updater-config writer; receives `(resourcesDir, context)`. Omitted on
 *   other platforms or when no update feed is configured.
 * @param {(runtimeRoot: string, expectedRuntimeVersion: string, options: {platform: string, arch: string}) => Promise<void>} deps.verifyDesktopRuntime -
 *   packaged runtime tree verification; rejects on any inconsistency.
 * @param {((runtimeRoot: string, resourcesDir: string, windowsCode: unknown) => Promise<void>) | undefined} [deps.verifyWindowsAsarUnpack] -
 *   unsigned-Windows asar-unpack verification; omitted elsewhere.
 * @param {string} deps.runtimeRoot - prepared dsh tree root the runtime
 *   verification checks.
 * @param {string} deps.expectedRuntimeVersion - version the packaged runtime
 *   must declare (product version, or the qualification rewrite).
 * @param {string} deps.platform - resolved target platform.
 * @param {string} deps.arch - resolved target architecture.
 * @param {() => unknown} [deps.getWindowsCode] - reads the asar-unpack
 *   evidence captured during `beforePack` at hook-call time.
 * @param {{error: (...values: unknown[]) => void, info: (...values: unknown[]) => void}} [deps.log] -
 *   output sink; defaults to the console adapters.
 * @returns {(context: {appOutDir: string, packager: {getResourcesDir: (appOutDir: string) => string}}) => Promise<void>} the hook.
 */
export function createAfterPackGate(deps) {
  const log = deps.log ?? { error: console.error, info: console.log }
  return async context => {
    // 1) Secrets first: user API keys / credentials must never ship. Throws on any hit.
    const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
    const hits = [...scanDir(resourcesDir), ...scanAsar(join(resourcesDir, 'app.asar'))]
    if (hits.length > 0) {
      for (const hit of hits) log.error(`[check-no-secrets] ${hit.file}:${hit.line} rule=${hit.rule} value=${hit.value}`)
      throw new Error(`check-no-secrets: ${hits.length} secret-like hit(s) in ${context.appOutDir}; packaging aborted.`)
    }
    log.info('[check-no-secrets] PASS (afterPack scan of resources + app.asar).')

    // 2) The bundled runtime declares whichever version prepared it: the product version for an ordinary
    //    release, and a rewritten one for installed-update qualification.
    if (deps.writeMacOSAppUpdate !== undefined) {
      await deps.writeMacOSAppUpdate(resourcesDir, context)
    }
    await deps.verifyDesktopRuntime(deps.runtimeRoot, deps.expectedRuntimeVersion, { platform: deps.platform, arch: deps.arch })
    // Unsigned Windows builds skip electron-builder's afterSign hook.
    if (deps.verifyWindowsAsarUnpack !== undefined) {
      await deps.verifyWindowsAsarUnpack(deps.runtimeRoot, resourcesDir, deps.getWindowsCode?.())
    }
  }
}

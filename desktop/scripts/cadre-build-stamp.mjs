/**
 * Shared build-stamp helpers for the two `cadre-collab` CJS bundles.
 *
 * The bundles are gitignored esbuild outputs; without a stamp, a source edit
 * that never rebuilt them is invisible to every gate. The stamp records the
 * hash of every bundled source file plus the hash of each emitted bundle, so
 * `check-cadre-build.ts` and the packaging preflight can fail closed instead of
 * trusting mtimes.
 *
 * Only files under `cadre-collab/**` that esbuild can reach are hashed; tests
 * are excluded because changing a test never changes the runtime bundle.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Bump when the stamp layout or hash input changes. */
export const CADRE_BUILD_STAMP_VERSION = 1

/** Desktop-relative source root bundled into both CJS outputs. */
export const CADRE_SOURCE_DIR = 'cadre-collab'

/** Desktop-relative stamp location (inside the gitignored `lib/`). */
export const CADRE_STAMP_PATH = 'apps/desktop/lib/cadre-build.json'

/** Desktop-relative CJS outputs produced by `build-cadre-collab.mjs`. */
export const CADRE_OUTPUTS = [
  'apps/desktop/lib/cadre-collab.cjs',
  'packages/cadre/host-collab/lib/cadre-ledger.cjs',
]

const BUNDLED_FILE = /\.ts$/
const TEST_FILE = /\.(test|spec)\.ts$/

/**
 * List every bundled source file as a desktop-relative POSIX path.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns sorted relative paths.
 */
export function listCadreSources(desktopRoot) {
  const found = []
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const full = join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full)
        continue
      }
      if (!BUNDLED_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue
      found.push(relative(desktopRoot, full).split(sep).join('/'))
    }
  }
  walk(join(desktopRoot, CADRE_SOURCE_DIR))
  return found.sort()
}

/**
 * SHA-256 of one file.
 * @param path - absolute path.
 * @returns lowercase hex digest.
 */
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Hash every bundled source file, returning both per-file and aggregate digests.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns per-file hashes keyed by relative path, aggregate hash and count.
 */
export function computeCadreSourceHashes(desktopRoot) {
  const files = listCadreSources(desktopRoot)
  const sources = {}
  const aggregate = createHash('sha256')
  for (const file of files) {
    const digest = hashFile(join(desktopRoot, ...file.split('/')))
    sources[file] = digest
    aggregate.update(file).update('\0').update(digest).update('\n')
  }
  return { sources, sourceHash: aggregate.digest('hex'), count: files.length }
}

/**
 * Read and shape-check the stamp written by the build.
 *
 * A stamp that is missing, unparsable, or structurally wrong is unusable: the
 * gate cannot trust a partial object and must ask for a rebuild instead of
 * failing later with a TypeError. Validation is deliberately explicit so the
 * message names the offending field.
 * @param desktopRoot - absolute `desktop/` directory.
 * @returns the validated stamp, or a problem string suitable for a failure message.
 */
export function readCadreStamp(desktopRoot) {
  const path = join(desktopRoot, ...CADRE_STAMP_PATH.split('/'))
  if (!existsSync(path)) return { problem: `缺少构建产物 stamp（${CADRE_STAMP_PATH}）` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { problem: `stamp 不是合法 JSON（${CADRE_STAMP_PATH}）：${error instanceof Error ? error.message : String(error)}` }
  }
  return validateCadreStamp(parsed)
}

/** A SHA-256 digest as produced by {@link hashFile}. */
const SHA256 = /^[0-9a-f]{64}$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one parsed stamp object.
 * @param value - parsed JSON value.
 * @returns `{ stamp }` when the layout is usable, otherwise `{ problem }`.
 */
export function validateCadreStamp(value) {
  if (!isRecord(value)) return { problem: `stamp 顶层不是对象（收到 ${Array.isArray(value) ? 'array' : typeof value}）` }
  if (value.version !== CADRE_BUILD_STAMP_VERSION) {
    return { problem: `stamp.version=${String(value.version)}，期望 ${String(CADRE_BUILD_STAMP_VERSION)}` }
  }
  if (typeof value.builtAt !== 'string' || Number.isNaN(Date.parse(value.builtAt))) {
    return { problem: 'stamp.builtAt 缺失或不是 ISO 时间' }
  }
  if (typeof value.esbuildVersion !== 'string' || value.esbuildVersion === '') {
    return { problem: 'stamp.esbuildVersion 缺失或不是字符串' }
  }
  if (typeof value.sourceHash !== 'string' || !SHA256.test(value.sourceHash)) {
    return { problem: 'stamp.sourceHash 缺失或不是 sha256 字符串' }
  }
  if (!Number.isInteger(value.sourceFiles) || value.sourceFiles < 0) {
    return { problem: 'stamp.sourceFiles 缺失或不是非负整数' }
  }
  if (!isRecord(value.sources)) return { problem: 'stamp.sources 缺失或不是对象' }
  for (const [file, digest] of Object.entries(value.sources)) {
    if (!file.startsWith(`${CADRE_SOURCE_DIR}/`)) {
      return { problem: `stamp.sources 的键不属于 ${CADRE_SOURCE_DIR}/：${file}` }
    }
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      return { problem: `stamp.sources["${file}"] 不是 sha256 字符串` }
    }
  }
  if (Object.keys(value.sources).length !== value.sourceFiles) {
    return { problem: `stamp.sources 条目数 ${String(Object.keys(value.sources).length)} ≠ sourceFiles ${String(value.sourceFiles)}` }
  }
  if (!Array.isArray(value.outputs)) return { problem: 'stamp.outputs 缺失或不是数组' }
  const seen = new Set()
  for (const [index, output] of value.outputs.entries()) {
    if (!isRecord(output)) return { problem: `stamp.outputs[${String(index)}] 不是对象` }
    if (typeof output.path !== 'string' || !CADRE_OUTPUTS.includes(output.path)) {
      return { problem: `stamp.outputs[${String(index)}].path 不合法：${String(output.path)}` }
    }
    if (seen.has(output.path)) return { problem: `stamp.outputs 重复记录 ${output.path}` }
    if (typeof output.sha256 !== 'string' || !SHA256.test(output.sha256)) {
      return { problem: `stamp.outputs[${String(index)}].sha256 不是 sha256 字符串` }
    }
    if (!Number.isInteger(output.bytes) || output.bytes < 0) {
      return { problem: `stamp.outputs[${String(index)}].bytes 不是非负整数` }
    }
    seen.add(output.path)
  }
  const missing = CADRE_OUTPUTS.filter(expected => !seen.has(expected))
  if (missing.length > 0) return { problem: `stamp.outputs 缺少 ${missing.join(', ')}` }
  return { stamp: value }
}

/**
 * Size of one built artifact in bytes.
 * @param path - absolute path.
 * @returns byte length.
 */
export function fileBytes(path) {
  return statSync(path).size
}

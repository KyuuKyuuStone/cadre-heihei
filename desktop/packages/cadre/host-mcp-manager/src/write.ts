/**
 * Catalog writes: validate one manifest, then replace its directory atomically.
 *
 * Staging and rollback copies live under the hidden `.backups` root, which the
 * catalog scan skips, so a concurrent step never reads a half-written entry and a
 * removed server never revives. A failed write restores the previous generation
 * before the failure surfaces.
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseManifest, SERVER_ID_PATTERN } from './catalog.ts'
import { McpError } from './errors.ts'
import type { McpServerManifest } from './types.ts'

/** Backup root under the catalog root; dot-directories are never scanned. */
export const BACKUP_DIR = '.backups'

const MANIFEST_KEYS = new Set([
  'id', 'name', 'description', 'descriptionI18n', 'transport', 'command', 'args', 'env', 'url',
  'headers', 'toolCallTimeoutMs', 'reconnect', 'tags', 'author', 'homepage', 'license',
])

function invalid(message: string, remediation: string): never {
  throw new McpError('MCP_INVALID', 400, message, remediation)
}

function unavailable(serverId: string): never {
  throw new McpError('MCP_SERVER_UNAVAILABLE', 503, `未知 MCP 服务器：${serverId}`, '刷新目录后重试')
}

function writeFailed(detail: string): never {
  throw new McpError('MCP_CATALOG_UNAVAILABLE', 503, `目录写入失败：${detail}`, '检查 ~/.dsh/cadre-mcp 的权限')
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid(`${what} 必须是对象`, `把 ${what} 写成 JSON 对象`)
  }
  return raw as Record<string, unknown>
}

/**
 * Reject fields the manifest whitelist does not carry, so an unsupported key can
 * never be silently dropped by the parser.
 * @param source - untrusted manifest object.
 */
function assertWhitelisted(source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (!MANIFEST_KEYS.has(key)) {
      invalid(`manifest 不允许字段 ${key}`, '只提交契约白名单里的字段')
    }
  }
}

/** @param id - candidate id. @returns the id after the `mcp-client` name grammar. */
export function assertServerId(id: unknown): string {
  if (typeof id !== 'string' || id === '') invalid('id 必填', '填 1-32 位字母、数字、下划线或连字符')
  if (!SERVER_ID_PATTERN.test(id)) {
    invalid(`id ${id} 不符合 ${SERVER_ID_PATTERN.source}`, 'id 只能是 1-32 位字母、数字、下划线或连字符')
  }
  return id
}

/**
 * Validate one manifest arriving from a client.
 * @param raw - untrusted `manifest` value.
 * @returns the validated manifest, with `id` fixed by the caller's directory.
 */
export function parseIncomingManifest(raw: unknown): McpServerManifest {
  const source = asRecord(raw, 'manifest')
  assertWhitelisted(source)
  const id = assertServerId(source.id)
  return parseManifest(source, id)
}

/** @param root - catalog root. @param id - server id. @returns its directory. */
export function serverDir(root: string, id: string): string {
  return join(root, id)
}

/** @param root - catalog root. @returns the hidden backup root path, created on demand. */
function backupRoot(root: string): string {
  return join(root, BACKUP_DIR)
}

/**
 * Replace one manifest directory through staging, a backup rename, and a final
 * rename, rolling back to the previous generation when any step fails.
 * @param root - catalog root.
 * @param manifest - validated manifest to persist.
 */
export function writeManifest(root: string, manifest: McpServerManifest): void {
  const target = serverDir(root, manifest.id)
  const backups = backupRoot(root)
  const staging = join(backups, `.${manifest.id}.tmp-${randomUUID()}`)
  const backup = join(backups, `${manifest.id}.old-${randomUUID()}`)
  try {
    mkdirSync(backups, { recursive: true })
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (existsSync(target)) renameSync(target, backup)
    renameSync(staging, target)
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    try {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    } catch {
      // Best-effort: a staging remnant stays under `.backups` and is never scanned.
    }
    try {
      if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
    } catch {
      // Best-effort: the backup keeps the previous generation readable for recovery.
    }
    writeFailed(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Create or overwrite one catalog entry.
 * @param root - catalog root.
 * @param raw - untrusted `manifest` value.
 * @param overwrite - whether an existing directory may be replaced.
 * @returns the written id and how it landed.
 */
export function addManifest(
  root: string,
  raw: unknown,
  overwrite: boolean,
): { readonly id: string; readonly created: boolean; readonly overwritten: boolean } {
  const manifest = parseIncomingManifest(raw)
  const existing = existsSync(serverDir(root, manifest.id))
  if (existing && !overwrite) {
    throw new McpError('MCP_NAME_CONFLICT', 409, `id 已存在：${manifest.id}`, '改 id 或带 overwrite+confirm')
  }
  writeManifest(root, manifest)
  return { id: manifest.id, created: !existing, overwritten: existing }
}

/**
 * Merge a patch into one stored manifest and replace it.
 *
 * The merged object is re-parsed as a whole, so a patch can never introduce a
 * value the manifest parser would refuse on disk.
 * @param root - catalog root.
 * @param serverId - entry to update.
 * @param rawPatch - untrusted `patch` value.
 * @returns the updated id.
 */
export function editManifest(root: string, serverId: string, rawPatch: unknown): { readonly id: string } {
  const id = assertServerId(serverId)
  const path = join(serverDir(root, id), 'manifest.json')
  if (!existsSync(path)) unavailable(id)
  const patch = asRecord(rawPatch, 'patch')
  assertWhitelisted(patch)
  if (patch.id !== undefined && patch.id !== id) {
    invalid('id 不可改', 'id 决定模型面工具前缀，请新建条目而不是改名')
  }
  let stored: Record<string, unknown>
  try {
    stored = asRecord(JSON.parse(readFileSync(path, 'utf8')), 'manifest')
  } catch (error) {
    if (error instanceof McpError) throw error
    writeFailed(`读取 ${id} 的 manifest 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const merged = { ...stored, ...patch, id }
  assertWhitelisted(merged)
  writeManifest(root, parseManifest(merged, id))
  return { id }
}

/**
 * Move one catalog entry under `.backups`, so it disappears from the scan but
 * stays recoverable; referenced selections become orphans and stay untouched.
 * @param root - catalog root.
 * @param serverId - entry to remove.
 * @returns after the directory moved.
 */
export function removeManifest(root: string, serverId: string): void {
  const id = assertServerId(serverId)
  const target = serverDir(root, id)
  if (!existsSync(target)) unavailable(id)
  const backups = backupRoot(root)
  const backup = join(backups, `${id}.old-${randomUUID()}`)
  try {
    mkdirSync(backups, { recursive: true })
    renameSync(target, backup)
  } catch (error) {
    writeFailed(error instanceof Error ? error.message : String(error))
  }
}

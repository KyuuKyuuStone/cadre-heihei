/**
 * The machine-local MCP catalog: one directory per server under the catalog root,
 * each carrying a `manifest.json`. A broken manifest becomes a health row instead
 * of hiding its neighbours.
 * @module
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpError } from './errors.ts'
import type {
  CatalogScan, ConfigValue, McpHealthRow, McpReconnect, McpServerManifest,
} from './types.ts'

/** `mcp-client`'s `serverName` grammar; the id must satisfy it to name tools. */
export const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const SECRET_NAME_PATTERN = /(token|key|secret|password|credential|authorization)/i
const DEFAULT_SUBDIR = ['cadre-mcp', 'servers'] as const

/**
 * Resolve the catalog root.
 * @param config - plugin config; `mcpDir` wins over the environment.
 * @returns the directory scanned once per step.
 */
export function resolveServersRoot(config: { readonly mcpDir?: string }): string {
  return config.mcpDir
    ?? process.env.CADRE_MCP_DIR?.trim()
    ?? join(homedir(), '.dsh', ...DEFAULT_SUBDIR)
}

/**
 * @param name - environment or header name.
 * @returns whether the name denotes a credential and must stay a reference.
 */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name)
}

function invalid(message: string, remediation: string): never {
  throw new McpError('MCP_INVALID', 400, message, remediation)
}

function assertConfigValues(kind: 'env' | 'headers', value: unknown): Readonly<Record<string, ConfigValue>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${kind} 必须是对象`, `把 ${kind} 写成 { "NAME": { "fromEnv": "NAME" } }`)
  }
  const entries: Record<string, ConfigValue> = {}
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      if (isSecretName(name)) {
        invalid(`${kind}.${name} 不允许写入明文密钥`, `${kind} 值只允许 fromEnv 引用；请改环境变量名`)
      }
      entries[name] = item
      continue
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const fromEnv = (item as { fromEnv?: unknown }).fromEnv
      if (typeof fromEnv === 'string' && fromEnv !== '') {
        entries[name] = { fromEnv }
        continue
      }
    }
    invalid(`${kind}.${name} 必须是 { "fromEnv": "NAME" } 引用`, '把值改成 { "fromEnv": "NAME" }')
  }
  return entries
}

function assertPositive(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    invalid(`${field} 必须是正数`, `把 ${field} 写成毫秒正整数`)
  }
  return value
}

function parseReconnect(value: unknown): McpReconnect | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) invalid('reconnect 必须是对象', '写成 { "enabled": true }')
  return { enabled: (value as { enabled?: unknown }).enabled !== false }
}

/**
 * Validate one manifest read from disk.
 * @param raw - parsed `manifest.json`.
 * @param fallbackId - directory name, used when the manifest omits `id`.
 * @returns the manifest the manager will mount from.
 */
export function parseManifest(raw: unknown, fallbackId: string): McpServerManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('manifest 必须是对象', '检查 manifest.json 是否为 JSON 对象')
  }
  const source = raw as Record<string, unknown>
  const id = typeof source.id === 'string' && source.id !== '' ? source.id : fallbackId
  if (!SERVER_ID_PATTERN.test(id)) {
    invalid(`id ${id} 不符合 ${SERVER_ID_PATTERN.source}`, 'id 只能是 1-32 位字母、数字、下划线或连字符')
  }
  const transport = source.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    invalid('transport 必须是 stdio 或 streamable-http', '把 transport 改成受支持的传输方式')
  }
  const name = typeof source.name === 'string' && source.name !== '' ? source.name : id
  const description = typeof source.description === 'string' ? source.description : ''
  const args = Array.isArray(source.args)
    ? source.args.filter((item): item is string => typeof item === 'string')
    : []
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((item): item is string => typeof item === 'string')
    : []
  const env = assertConfigValues('env', source.env)
  const headers = assertConfigValues('headers', source.headers)
  const toolCallTimeoutMs = assertPositive(source.toolCallTimeoutMs, 'toolCallTimeoutMs')
  const reconnect = parseReconnect(source.reconnect)

  if (transport === 'stdio') {
    if (typeof source.command !== 'string' || source.command === '') {
      invalid('stdio 服务器必须提供 command', '在 manifest 里填 command，例如 "npx"')
    }
  } else if (typeof source.url !== 'string' || source.url === '') {
    invalid('streamable-http 服务器必须提供 url', '在 manifest 里填 url')
  }

  return {
    id,
    name,
    description,
    transport: transport,
    ...(typeof source.command === 'string' ? { command: source.command } : {}),
    args,
    env,
    ...(typeof source.url === 'string' ? { url: source.url } : {}),
    headers,
    ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
    ...(reconnect === undefined ? {} : { reconnect }),
    tags,
    ...(typeof source.descriptionI18n === 'object' && source.descriptionI18n !== null
      ? { descriptionI18n: source.descriptionI18n as Record<string, string> }
      : {}),
    ...(typeof source.author === 'string' ? { author: source.author } : {}),
    ...(typeof source.homepage === 'string' ? { homepage: source.homepage } : {}),
    ...(typeof source.license === 'string' ? { license: source.license } : {}),
  }
}

/**
 * Scan the catalog root; a missing root is an empty catalog, not a failure.
 * @param root - directory holding one subdirectory per server.
 * @returns usable manifests plus one health row per rejected directory.
 */
export async function readCatalog(root: string): Promise<CatalogScan> {
  const servers = new Map<string, McpServerManifest>()
  const health: McpHealthRow[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers, health }
    throw new McpError('MCP_CATALOG_UNAVAILABLE', 503, `目录不可读：${root}`, '检查 ~/.dsh/cadre-mcp 的权限')
  }
  for (const entry of entries) {
    // `.backups` and other dot-directories hold removed servers and must not revive.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(root, entry.name, 'manifest.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      health.push({ id: entry.name, state: 'invalid', detail: error instanceof Error ? error.message : String(error) })
      continue
    }
    let manifest: McpServerManifest
    try {
      manifest = parseManifest(parsed, entry.name)
    } catch (error) {
      health.push({ id: entry.name, state: 'invalid', detail: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (servers.has(manifest.id)) {
      health.push({ id: entry.name, state: 'invalid', detail: `重复 id ${manifest.id}，保留首个` })
      continue
    }
    servers.set(manifest.id, manifest)
  }
  return { servers, health }
}

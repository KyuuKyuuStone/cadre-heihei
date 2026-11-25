/**
 * The `session_mcp` ledger table: what each session selected, tolerantly read and
 * strictly written.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { McpError } from './errors.ts'
import type { EnvReference, McpSelection, McpSelectionEntry, McpServerOverrides } from './types.ts'

/** Additive DDL; the manager creates the table on first write, never migrates. */
export const SESSION_MCP_DDL = `CREATE TABLE IF NOT EXISTS session_mcp (
  session_id TEXT PRIMARY KEY,
  mcp_json TEXT NOT NULL DEFAULT '{"servers":[]}',
  updated_at TEXT NOT NULL
)`

/** Nothing selected. */
export const EMPTY_SELECTION: McpSelection = { servers: [] }

const OVERRIDE_KEYS = new Set(['toolCallTimeoutMs', 'env'])

/**
 * Open the Cadre ledger read-only, matching the other Cadre host plugins.
 * @param path - ledger database path.
 * @returns a handle whose statements read committed state.
 */
export function openLedger(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

function parseOverrides(raw: unknown): McpServerOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const overrides: { toolCallTimeoutMs?: number; env?: Record<string, EnvReference> } = {}
  const timeout = source.toolCallTimeoutMs
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) overrides.toolCallTimeoutMs = timeout
  if (typeof source.env === 'object' && source.env !== null && !Array.isArray(source.env)) {
    const env: Record<string, EnvReference> = {}
    for (const [name, item] of Object.entries(source.env as Record<string, unknown>)) {
      const fromEnv = (item as { fromEnv?: unknown } | null)?.fromEnv
      if (typeof fromEnv === 'string' && fromEnv !== '') env[name] = { fromEnv }
    }
    if (Object.keys(env).length > 0) overrides.env = env
  }
  return overrides
}

/**
 * Parse a stored `mcp_json` value; damage degrades to "nothing selected" so a bad
 * row cannot block a step.
 * @param raw - parsed JSON, or anything else when the column is damaged.
 * @returns the entries that survive validation.
 */
export function parseSelection(raw: unknown): McpSelection {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SELECTION
  const servers = (raw as { servers?: unknown }).servers
  if (!Array.isArray(servers)) return EMPTY_SELECTION
  const entries: McpSelectionEntry[] = []
  for (const item of servers) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const overrides = parseOverrides(entry.overrides)
    entries.push({
      id: entry.id,
      enabled: entry.enabled !== false,
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    })
  }
  return { servers: entries }
}

/**
 * Read one session's selection; a missing table or row means nothing selected.
 * @param db - read-only ledger handle.
 * @param sessionId - session whose row to read.
 * @returns the stored selection, or the empty selection.
 */
export function readSelection(db: DatabaseSync, sessionId: string): McpSelection {
  try {
    const row = db.prepare('SELECT mcp_json FROM session_mcp WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { mcp_json?: unknown } | undefined
    if (row === undefined) return EMPTY_SELECTION
    const json = row.mcp_json
    if (typeof json !== 'string') return EMPTY_SELECTION
    return parseSelection(JSON.parse(json))
  } catch {
    return EMPTY_SELECTION
  }
}

function bad(message: string, remediation: string): never {
  throw new McpError('MCP_INVALID', 400, message, remediation)
}

/**
 * Validate a `servers` payload arriving from the sidebar.
 * @param input - untrusted `servers` value.
 * @param isKnown - whether the catalog still holds that id.
 * @returns the deduplicated selection to persist.
 */
export function validateSelection(input: unknown, isKnown: (id: string) => boolean): McpSelection {
  if (!Array.isArray(input)) bad('servers 必须是数组', '把 servers 写成 [{ "id": "...", "enabled": true }]')
  const seen = new Set<string>()
  const entries: McpSelectionEntry[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) bad('servers 的每一项必须是对象', '检查提交的每一项')
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id === '') bad('servers.id 必填', '为每一项填 id')
    const id = entry.id
    if (seen.has(id)) continue
    seen.add(id)
    if (!isKnown(id)) {
      throw new McpError('MCP_INVALID', 400, `未知 MCP 服务器：${id}`, '刷新目录后重新勾选')
    }
    let overrides: McpServerOverrides = {}
    if (entry.overrides !== undefined) {
      if (typeof entry.overrides !== 'object' || entry.overrides === null || Array.isArray(entry.overrides)) {
        bad('overrides 必须是对象', '只在 overrides 里写 toolCallTimeoutMs 或 env 引用')
      }
      for (const key of Object.keys(entry.overrides)) {
        if (!OVERRIDE_KEYS.has(key)) {
          bad(`会话覆盖不允许改 ${key}`, '会话只能覆盖 toolCallTimeoutMs 与 env 引用，端点由目录固定')
        }
      }
      const source = entry.overrides as Record<string, unknown>
      const timeout = source.toolCallTimeoutMs
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
        bad('overrides.toolCallTimeoutMs 必须是正数', '写成毫秒正整数')
      }
      const env: Record<string, EnvReference> = {}
      if (source.env !== undefined) {
        if (typeof source.env !== 'object' || source.env === null || Array.isArray(source.env)) {
          bad('overrides.env 必须是对象', '写成 { "NAME": { "fromEnv": "NAME" } }')
        }
        for (const [name, value] of Object.entries(source.env as Record<string, unknown>)) {
          const fromEnv = (value as { fromEnv?: unknown } | null)?.fromEnv
          if (typeof fromEnv !== 'string' || fromEnv === '') {
            bad(`overrides.env.${name} 只允许 fromEnv 引用`, 'env 值只允许 fromEnv 引用；请改环境变量名')
          }
          env[name] = { fromEnv }
        }
      }
      overrides = {
        ...(typeof timeout === 'number' ? { toolCallTimeoutMs: timeout } : {}),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      }
    }
    entries.push({
      id,
      enabled: entry.enabled !== false,
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    })
  }
  return { servers: entries }
}

/**
 * Persist a session's selection, creating `session_mcp` on first write.
 * @param ledgerPath - ledger database path.
 * @param sessionId - session whose row to replace.
 * @param selection - already validated selection.
 */
export function writeSelection(ledgerPath: string, sessionId: string, selection: McpSelection): void {
  const writer = new DatabaseSync(ledgerPath)
  try {
    writer.exec(SESSION_MCP_DDL)
    writer.prepare(`INSERT INTO session_mcp (session_id, mcp_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET mcp_json = excluded.mcp_json, updated_at = excluded.updated_at`)
      .run(sessionId, JSON.stringify(selection), new Date().toISOString())
  } finally {
    writer.close()
  }
}

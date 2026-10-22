/**
 * Local provider catalogue (milestone ④): SQLite tables beside the cadre ledger.
 *
 * Only the credential *reference* is stored here; key values live in the
 * official credentials-local document. Forward-only migration: the module only
 * adds tables/indexes and never rewrites the ledger tables.
 */
import { DatabaseSync } from 'node:sqlite'

export const PROVIDER_KINDS = ['openai-compatible', 'deepseek', 'ark', 'anthropic'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export interface ProviderModel {
  readonly id: string
  readonly contextWindow?: number
  readonly maxTokens?: number
}

export interface ProviderRecord {
  readonly providerId: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl?: string
  readonly apiKeyRef: string
  readonly defaultModel: string
  readonly models: readonly ProviderModel[]
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SaveProviderInput {
  readonly providerId: string
  readonly name: string
  readonly kind: string
  readonly baseUrl?: string
  readonly defaultModel: string
  readonly models: readonly ProviderModel[]
  readonly enabled?: boolean
  readonly isDefault?: boolean
  /** Write-only: never persisted here. */
  readonly apiKey?: string
}

export interface ProviderFailure {
  readonly ok: false
  readonly code: 'INVALID_ARGUMENT' | 'MISSING_CREDENTIAL' | 'INVALID_CREDENTIAL' | 'MODEL_NOT_FOUND'
  readonly message: string
  readonly field?: string
}

export type ProviderResult<T> = ({ ok: true } & T) | ProviderFailure

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/+-]{1,200}$/
const MAX_MODELS = 128

/** Stable credential reference for a local provider id. */
export function providerKeyRef(providerId: string): string {
  return `CADRE_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`
}

function fail(code: ProviderFailure['code'], message: string, field?: string): ProviderFailure {
  return { ok: false, code, message, ...(field === undefined ? {} : { field }) }
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
  } catch {
    return false
  }
}

/** Validate a provider form before touching storage or credentials. */
export function validateProviderInput(input: SaveProviderInput): ProviderFailure | undefined {
  if (!ID_PATTERN.test(input.providerId)) {
    return fail('INVALID_ARGUMENT', 'providerId 仅允许小写字母、数字与连字符', 'providerId')
  }
  if (input.name.trim() === '' || input.name.length > 120) {
    return fail('INVALID_ARGUMENT', 'name 必须为 1-120 字符', 'name')
  }
  if (!PROVIDER_KINDS.includes(input.kind as ProviderKind)) {
    return fail('INVALID_ARGUMENT', `kind 必须是 ${PROVIDER_KINDS.join('/')}`, 'kind')
  }
  if (input.baseUrl !== undefined && input.baseUrl !== '' && !validBaseUrl(input.baseUrl)) {
    return fail('INVALID_ARGUMENT', 'baseUrl 必须是 http(s) 绝对地址', 'baseUrl')
  }
  if (input.kind !== 'deepseek' && (input.baseUrl === undefined || input.baseUrl === '')) {
    return fail('INVALID_ARGUMENT', `${input.kind} 需要 baseUrl`, 'baseUrl')
  }
  if (!Array.isArray(input.models) || input.models.length === 0 || input.models.length > MAX_MODELS) {
    return fail('INVALID_ARGUMENT', `models 必须为 1-${MAX_MODELS} 项`, 'models')
  }
  const ids = new Set<string>()
  for (const model of input.models) {
    if (model === null || typeof model !== 'object' || !MODEL_ID_PATTERN.test(model.id)) {
      return fail('INVALID_ARGUMENT', 'model.id 非法', 'models')
    }
    if (ids.has(model.id)) return fail('INVALID_ARGUMENT', `model.id 重复：${model.id}`, 'models')
    ids.add(model.id)
    for (const key of ['contextWindow', 'maxTokens'] as const) {
      const value = model[key]
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        return fail('INVALID_ARGUMENT', `model.${key} 必须是正整数`, 'models')
      }
    }
  }
  if (!ids.has(input.defaultModel)) {
    return fail('MODEL_NOT_FOUND', `defaultModel 不在 models 中：${input.defaultModel}`, 'defaultModel')
  }
  return undefined
}

interface Row {
  provider_id: string
  name: string
  kind: string
  base_url: string | null
  api_key_ref: string
  default_model: string
  models_json: string
  enabled: number
  is_default: number
  created_at: string
  updated_at: string
}

function toRecord(row: Row): ProviderRecord {
  let models: ProviderModel[] = []
  try {
    const parsed: unknown = JSON.parse(row.models_json)
    if (Array.isArray(parsed)) models = parsed as ProviderModel[]
  } catch {
    models = []
  }
  return {
    providerId: row.provider_id,
    name: row.name,
    kind: row.kind as ProviderKind,
    ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    apiKeyRef: row.api_key_ref,
    defaultModel: row.default_model,
    models,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** SQLite-backed provider store and session binding map. */
export class ProviderStore {
  private readonly db: DatabaseSync

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** Forward-only: additive tables only. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        provider_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT,
        api_key_ref TEXT NOT NULL,
        default_model TEXT NOT NULL,
        models_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS providers_one_default
        ON providers(is_default) WHERE is_default = 1;
      CREATE TABLE IF NOT EXISTS session_providers (
        session_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(provider_id) ON DELETE RESTRICT,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_providers_provider
        ON session_providers(provider_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  list(): readonly ProviderRecord[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY is_default DESC, provider_id').all() as unknown as Row[]
    return rows.map(toRecord)
  }

  get(providerId: string): ProviderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE provider_id = ?').get(providerId) as unknown as Row | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  save(input: SaveProviderInput, now: string): ProviderResult<{ provider: ProviderRecord }> {
    const invalid = validateProviderInput(input)
    if (invalid !== undefined) return invalid
    const enabled = input.enabled !== false
    const isDefault = input.isDefault === true
    const existing = this.get(input.providerId)
    const createdAt = existing?.createdAt ?? now
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (isDefault) this.db.prepare('UPDATE providers SET is_default = 0 WHERE is_default = 1').run()
      this.db.prepare(`
        INSERT INTO providers (provider_id, name, kind, base_url, api_key_ref, default_model,
          models_json, enabled, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          name = excluded.name, kind = excluded.kind, base_url = excluded.base_url,
          api_key_ref = excluded.api_key_ref, default_model = excluded.default_model,
          models_json = excluded.models_json, enabled = excluded.enabled,
          is_default = excluded.is_default, updated_at = excluded.updated_at
      `).run(
        input.providerId, input.name.trim(), input.kind, input.baseUrl?.trim() || null,
        providerKeyRef(input.providerId), input.defaultModel, JSON.stringify(input.models),
        enabled ? 1 : 0, isDefault ? 1 : 0, createdAt, now,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const provider = this.get(input.providerId)
    if (provider === undefined) return fail('INVALID_ARGUMENT', '保存后读取失败', 'providerId')
    return { ok: true, provider }
  }

  /** @returns failure when session bindings reference the provider. */
  delete(providerId: string): ProviderResult<{ deleted: true }> {
    if (this.get(providerId) === undefined) {
      return fail('INVALID_ARGUMENT', 'provider 不存在', 'providerId')
    }
    const refs = this.db.prepare('SELECT COUNT(*) AS n FROM session_providers WHERE provider_id = ?')
      .get(providerId) as unknown as { n: number }
    if (refs.n > 0) {
      return fail('INVALID_ARGUMENT', `仍有 ${refs.n} 个会话引用该 provider，请先改绑`, 'providerId')
    }
    this.db.prepare('DELETE FROM providers WHERE provider_id = ?').run(providerId)
    return { ok: true, deleted: true }
  }

  bindSession(sessionId: string, providerId: string, model: string, now: string): ProviderResult<{ binding: { sessionId: string; providerId: string; model: string; updatedAt: string } }> {
    if (sessionId.trim() === '') return fail('INVALID_ARGUMENT', 'sessionId 无效', 'sessionId')
    const provider = this.get(providerId)
    if (provider === undefined) return fail('INVALID_ARGUMENT', 'provider 不存在', 'providerId')
    if (!provider.enabled) return fail('INVALID_ARGUMENT', 'provider 已停用', 'providerId')
    if (!provider.models.some(entry => entry.id === model)) {
      return fail('MODEL_NOT_FOUND', `模型不在 provider 目录中：${model}`, 'model')
    }
    this.db.prepare(`
      INSERT INTO session_providers (session_id, provider_id, model, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET provider_id = excluded.provider_id,
        model = excluded.model, updated_at = excluded.updated_at
    `).run(sessionId, providerId, model, now)
    return { ok: true, binding: { sessionId, providerId, model, updatedAt: now } }
  }

  sessionBinding(sessionId: string): { providerId: string; model: string } | undefined {
    const row = this.db.prepare('SELECT provider_id, model FROM session_providers WHERE session_id = ?')
      .get(sessionId) as unknown as { provider_id: string; model: string } | undefined
    return row === undefined ? undefined : { providerId: row.provider_id, model: row.model }
  }

  /** Default provider for unbound sessions: is_default, else first enabled. */
  defaultProvider(): { providerId: string; model: string; fallback: boolean } | undefined {
    const all = this.list()
    const chosen = all.find(p => p.isDefault && p.enabled) ?? all.find(p => p.enabled)
    if (chosen === undefined) return undefined
    return { providerId: chosen.providerId, model: chosen.defaultModel, fallback: !chosen.isDefault }
  }
}

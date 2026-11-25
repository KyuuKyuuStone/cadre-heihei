/**
 * MCP manager wire calls and the structured failure the conversation view
 * renders. The `catalog` route carries masked rows only — environment and
 * header *keys*, never values — so this module's display helper refuses
 * anything that is not an environment reference.
 */
import { zhTranslate, type SidebarKey } from './locales.ts'

/** Locale seat for transport failure copy; defaults to the zh dictionary. */
type McpTranslate = (key: SidebarKey, params?: Record<string, unknown>) => string

/** One environment reference: only the referenced name reaches the UI. */
export interface McpEnvReference {
  readonly fromEnv: string
}

/** Session-level override the host accepts: timeout and environment references only. */
export interface McpServerOverrides {
  readonly toolCallTimeoutMs?: number
  readonly env?: Readonly<Record<string, McpEnvReference>>
}

/** One catalog row plus this Session's enablement and override summary. */
export interface McpCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Manifest transport token (`stdio` or `streamable-http`); rendered verbatim. */
  readonly transport: string
  readonly tags?: readonly string[]
  /** Masked `env` names; values stay in the host. */
  readonly envKeys?: readonly string[]
  /** Masked `headers` names; values stay in the host. */
  readonly headerKeys?: readonly string[]
  readonly selected: boolean
  readonly enabled: boolean
  readonly overrides?: McpServerOverrides
}

/** A catalog row that could not be used, kept so the panel can report it. */
export interface McpHealthRow {
  readonly id: string
  readonly state: 'ok' | 'invalid'
  readonly detail?: string
}

/** The `catalog` result: usable rows plus the entries that failed validation. */
export interface McpCatalogResult {
  readonly servers: readonly McpCatalogEntry[]
  readonly health: readonly McpHealthRow[]
}

/** One row the `set` route persists for a Session. */
export interface McpSelectionEntry {
  readonly id: string
  readonly enabled: boolean
  readonly overrides?: McpServerOverrides
}

/** The persisted selection, echoed by `set`. */
export interface McpSelectionView {
  readonly servers: readonly McpSelectionEntry[]
}

interface McpResponse {
  readonly ok?: boolean
  readonly result?: unknown
  readonly code?: string
  readonly message?: string
  readonly remediation?: string
}

/** Transport failure carrying the host's stable code and corrective action. */
export class McpOperationError extends Error {
  constructor(readonly code: string, readonly detail: string, readonly remediation?: string) {
    super(`${code} · ${detail}`)
    this.name = 'McpOperationError'
  }
}

/**
 * Masked reference name of a secret value.
 * A literal value (a key that was not written as `fromEnv`) renders as hidden
 * instead of leaking into the panel.
 * @param reference - masked reference carried by the route, if any.
 * @returns the referenced environment name, or undefined when the value is not a reference.
 */
export function secretReferenceName(reference: McpEnvReference | undefined): string | undefined {
  const raw: unknown = reference?.fromEnv
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  return name === '' ? undefined : name
}

async function mcpCall(
  method: 'catalog' | 'set',
  body: Record<string, unknown>,
  t: McpTranslate = zhTranslate,
): Promise<unknown> {
  const response = await fetch(`/cadre/mcp/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json() as McpResponse
  if (!response.ok || result.ok !== true) {
    throw new McpOperationError(
      result.code ?? `HTTP_${String(response.status)}`,
      result.message ?? t('mcp.requestFailed'),
      result.remediation,
    )
  }
  return result.result
}

const arrayOf = <T>(value: unknown): readonly T[] => Array.isArray(value) ? value as readonly T[] : []

/**
 * Read the global catalog plus the target Session's selection summary.
 * @param projectId - project that proves access.
 * @param actorSessionId - Session issuing the read.
 * @param targetSessionId - Session whose selection is read; the panel edits its own.
 * @param locale - browser locale for host-localized descriptions.
 * @param t - transport failure copy.
 * @returns usable catalog rows and the entries that failed validation.
 */
export async function fetchMcpCatalog(
  projectId: string,
  actorSessionId: string,
  targetSessionId: string,
  locale: string | undefined,
  t: McpTranslate = zhTranslate,
): Promise<McpCatalogResult> {
  const result = await mcpCall('catalog', {
    projectId,
    actorSessionId,
    targetSessionId,
    ...(locale === undefined ? {} : { locale }),
  }, t)
  return {
    servers: arrayOf<McpCatalogEntry>((result as { readonly servers?: unknown } | null)?.servers),
    health: arrayOf<McpHealthRow>((result as { readonly health?: unknown } | null)?.health),
  }
}

/**
 * Persist a Session's server selection and whitelisted overrides.
 * @param projectId - project that proves access.
 * @param actorSessionId - Session issuing the write.
 * @param targetSessionId - Session whose selection is written; the panel edits its own.
 * @param servers - complete selection rows; the host validates ids and the override allowlist.
 * @param t - transport failure copy.
 * @returns the persisted selection the route echoes.
 */
export async function saveMcpSelection(
  projectId: string,
  actorSessionId: string,
  targetSessionId: string,
  servers: readonly McpSelectionEntry[],
  t: McpTranslate = zhTranslate,
): Promise<McpSelectionView> {
  const result = await mcpCall('set', { projectId, actorSessionId, targetSessionId, servers }, t)
  return { servers: arrayOf<McpSelectionEntry>((result as { readonly servers?: unknown } | null)?.servers) }
}
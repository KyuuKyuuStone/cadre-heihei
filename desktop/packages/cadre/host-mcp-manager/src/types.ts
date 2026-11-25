/**
 * Types for the Cadre MCP manager: catalog manifests, per-session selection, the
 * IPC payloads the sidebar exchanges, and the host surface the plugin needs.
 * @module
 */
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'

/** Transports `mcp-client` can carry. */
export type McpTransport = 'stdio' | 'streamable-http'

/** A secret read from the host environment when the server mounts. */
export interface EnvReference { readonly fromEnv: string }

/** An `env`/`headers` value: an environment reference or a non-sensitive literal. */
export type ConfigValue = EnvReference | string

/** Reconnect policy handed to `mcp-client`. */
export interface McpReconnect { readonly enabled: boolean }

/**
 * One `manifest.json` under the catalog root. `id` is also the `mcp-client`
 * `serverName`, so it fixes the model-facing `mcp__<id>__<tool>` prefix and must
 * not change after creation.
 */
export interface McpServerManifest {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly descriptionI18n?: Readonly<Record<string, string>>
  readonly transport: McpTransport
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, ConfigValue>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, ConfigValue>>
  readonly toolCallTimeoutMs?: number
  readonly reconnect?: McpReconnect
  readonly tags?: readonly string[]
  readonly author?: string
  readonly homepage?: string
  readonly license?: string
}

/**
 * Session overrides. The allowlist is a security invariant: a session may
 * retime a server or repoint an environment reference, never redirect its
 * command, arguments, URL, or headers.
 */
export interface McpServerOverrides {
  readonly toolCallTimeoutMs?: number
  readonly env?: Readonly<Record<string, EnvReference>>
}

/** One selected server for a session. */
export interface McpSelectionEntry {
  readonly id: string
  readonly enabled: boolean
  readonly overrides?: McpServerOverrides
}

/** The `session_mcp.mcp_json` value. */
export interface McpSelection { readonly servers: readonly McpSelectionEntry[] }

/** Whether a catalog directory contributed a usable manifest. */
export type McpHealthState = 'ok' | 'invalid'

/** A catalog entry that could not be used, kept so the UI can report it. */
export interface McpHealthRow {
  readonly id: string
  readonly state: McpHealthState
  readonly detail?: string
}

/** Catalog view of one server; secret values are reduced to environment names. */
export interface McpCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly transport: McpTransport
  readonly tags: readonly string[]
  readonly envKeys: readonly string[]
  readonly headerKeys: readonly string[]
  readonly selected: boolean
  readonly enabled: boolean
  readonly overrides: McpServerOverrides
}

/** `catalog` result: usable servers plus the rows that failed validation. */
export interface McpCatalogResult {
  readonly servers: readonly McpCatalogEntry[]
  readonly health: readonly McpHealthRow[]
}

/** The selection a session persists, as the sidebar reads it back. */
export interface McpSelectionView { readonly servers: readonly McpSelectionEntry[] }

/** Structured failure codes the routes return beside the message and remediation. */
export type McpErrorCode =
  | 'MCP_INVALID'
  | 'MCP_PROJECT_REQUIRED'
  | 'MCP_FORBIDDEN'
  | 'MCP_CONFIRM_REQUIRED'
  | 'MCP_NAME_CONFLICT'
  | 'MCP_CATALOG_UNAVAILABLE'
  | 'MCP_SERVER_UNAVAILABLE'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_INVALID_RESULT'
  | 'MCP_TEST_UNSUPPORTED'

/** Inputs of the three P1 routes. */
export interface McpCatalogInput {
  readonly projectId: string
  readonly actorSessionId: string
  readonly targetSessionId?: string
  readonly locale?: string
}

/** `get` input. */
export interface McpGetInput {
  readonly projectId: string
  readonly actorSessionId: string
  readonly targetSessionId: string
}

/** `set` input; `servers` stays `unknown` because it crosses the wire. */
export interface McpSetInput {
  readonly projectId: string
  readonly actorSessionId: string
  readonly targetSessionId: string
  readonly servers: unknown
}

/** The catalog/get/set surface the routes and the sidebar share. */
export interface McpApi {
  catalog(input: McpCatalogInput): Promise<McpCatalogResult>
  get(input: McpGetInput): Promise<McpSelectionView>
  set(input: McpSetInput): Promise<McpSelectionView>
}

/** Catalog scan result: manifests keyed by id plus the rows that failed. */
export interface CatalogScan {
  readonly servers: ReadonlyMap<string, McpServerManifest>
  readonly health: readonly McpHealthRow[]
}

/** A server resolved for mounting: its client config plus an identity hash. */
export interface ResolvedServer {
  readonly id: string
  readonly hash: string
  readonly config: McpClientConfig
}

/** Minimum agent context the manager mounts child fibers into. */
export interface MountTarget {
  plugin(plugin: unknown, config: unknown): { dispose(): unknown } | undefined
}

/** The agent fields the manager reads during `agent/pre-step`. */
export interface AgentSurface {
  readonly id: string
  readonly ctx: MountTarget
}

/** `agent/pre-step` payload fields the manager reads. */
export interface PreStepPayload { readonly agent: AgentSurface }

/** Host context surface; every member is optional so tests can hand-build one. */
export interface HostContext {
  get?(name: string): unknown
  provide?(name: string, value: unknown): unknown
  inject?(names: readonly string[], callback: (scope: unknown) => void): unknown
  on?(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => unknown) => unknown): unknown
  effect?(setup: () => () => void, label?: string): unknown
}

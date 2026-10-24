/**
 * Provider runtime bridge: official Host RPC for credentials and llm-pi-ai settings.
 *
 * The renderer never receives key values. `credentials/set` writes the official
 * credentials-local document; only `apiKeyEnv` references enter the settings
 * layer, so provider patches never contain plaintext.
 */
import { randomUUID } from 'node:crypto'
import type { ProviderRecord } from './providers-db.ts'

interface RpcEnvelope {
  readonly type?: unknown
  readonly rpcId?: unknown
  readonly result?: { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
}

/** Minimal authenticated Host RPC client with a bounded timeout. */
export async function hostRpc(
  hostUrl: string,
  cookie: string,
  namespace: string,
  method: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  const rpcId = randomUUID()
  const rpcMethod = `${namespace}/${method}`
  const response = await fetch(new URL(`/api/${rpcMethod}`, new URL(hostUrl).origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: rpcMethod, payload: { args } }),
  })
  if (!response.ok) throw new Error(`host rpc ${rpcMethod}: http ${response.status}`)
  const envelope = (await response.json()) as RpcEnvelope
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || typeof envelope.result !== 'object' || envelope.result === null || envelope.result.ok !== true) {
    const detail = envelope.result?.error === undefined ? '' : `: ${JSON.stringify(envelope.result.error).slice(0, 300)}`
    throw new Error(`host rpc ${rpcMethod}: rejected${detail}`)
  }
  return envelope.result.value
}

/** Official session model selection, including reasoning effort (single source of truth). */
export async function selectSessionModel(
  hostUrl: string, cookie: string,
  request: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
): Promise<void> {
  await hostRpc(hostUrl, cookie, 'session', 'selectModel', { request })
}

/** Official model catalog (per-provider groups with reasoning efforts). */
export async function fetchModelCatalog(hostUrl: string, cookie: string): Promise<readonly unknown[]> {
  const value = await hostRpc(hostUrl, cookie, 'session', 'modelCatalog', {})
  return Array.isArray(value) ? value : []
}

/** Store a key through the official credentials provider (never in our DB/logs). */
export async function setProviderCredential(hostUrl: string, cookie: string, ref: string, value: string): Promise<void> {
  await hostRpc(hostUrl, cookie, 'credentials', 'set', { ref, value })
}

/** @returns whether the reference resolves to a configured (file or env) key. */
export async function providerKeyConfigured(hostUrl: string, cookie: string, ref: string): Promise<boolean> {
  const result = await hostRpc(hostUrl, cookie, 'credentials', 'describe', { refs: [ref] })
  if (typeof result !== 'object' || result === null) return false
  const info = (result as Record<string, { configured?: unknown }>)[ref]
  return info?.configured === true
}

/** Remove a provider's secret when its record is deleted; best effort. */
export async function unsetProviderCredential(hostUrl: string, cookie: string, ref: string): Promise<void> {
  await hostRpc(hostUrl, cookie, 'credentials', 'unset', { ref })
}

function protocolFor(kind: ProviderRecord['kind']): string {
  if (kind === 'anthropic') return 'anthropic-messages'
  return 'openai-completions'
}

function defaultBaseUrl(kind: ProviderRecord['kind']): string | undefined {
  return kind === 'deepseek' ? 'https://api.deepseek.com/v1' : undefined
}

/** One llm-pi-ai route; the map key is the route id and only the ref is secret-free. */
function routeFor(provider: ProviderRecord): Record<string, unknown> {
  const baseURL = provider.baseUrl ?? defaultBaseUrl(provider.kind)
  return {
    displayName: provider.name,
    api: protocolFor(provider.kind),
    ...(baseURL === undefined ? {} : { baseURL }),
    apiKeyEnv: provider.apiKeyRef,
    models: provider.models.map(model => ({
      id: model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    })),
    ...(provider.kind === 'deepseek' ? { compat: { thinkingFormat: 'deepseek' } } : {}),
  }
}

interface SettingsNamespace {
  readonly ns?: unknown
  readonly revision?: unknown
  readonly value?: unknown
}

/** Replace the managed llm-pi-ai routes while preserving foreign provider keys. */
export async function syncProvidersToHost(
  hostUrl: string,
  cookie: string,
  providers: readonly ProviderRecord[],
  log: (line: string) => void,
): Promise<void> {
  const described = await hostRpc(hostUrl, cookie, 'settings', 'describe', {})
  const namespaces = (described as { namespaces?: unknown }).namespaces
  const namespace = Array.isArray(namespaces)
    ? namespaces.find((item): item is SettingsNamespace => typeof item === 'object' && item !== null && (item as SettingsNamespace).ns === 'llm-pi-ai')
    : undefined
  const current = typeof namespace?.value === 'object' && namespace.value !== null
    ? namespace.value as Record<string, unknown>
    : {}
  const currentProviders = typeof current.providers === 'object' && current.providers !== null
    ? current.providers as Record<string, unknown>
    : {}
  const managed = new Set(providers.map(provider => provider.providerId))
  const nextProviders: Record<string, unknown> = {}
  for (const [route, config] of Object.entries(currentProviders)) {
    // Preserve routes we do not own; drop stale managed routes.
    const ref = typeof config === 'object' && config !== null ? (config as { apiKeyEnv?: unknown }).apiKeyEnv : undefined
    if (typeof ref === 'string' && ref.startsWith('CADRE_PROVIDER_') && !managed.has(route)) continue
    nextProviders[route] = config
  }
  for (const provider of providers) {
    if (!provider.enabled) continue
    nextProviders[provider.providerId] = routeFor(provider)
  }
  const revision = typeof namespace?.revision === 'number' ? namespace.revision : undefined
  await hostRpc(hostUrl, cookie, 'settings', 'replace', {
    ns: 'llm-pi-ai',
    section: { ...current, providers: nextProviders },
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  })
  log(`cadre-providers sync routes=${Object.keys(nextProviders).length} managed=${managed.size}`)
}

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

/**
 * Admit one text prompt from the shell (the Session source is a user message).
 *
 * Used for first-turn report-in: the official shell hides Sessions with no
 * messages, so a newly created supervisor/employee must speak once.
 */
export async function promptSession(
  hostUrl: string, cookie: string, request: { sessionId: string; text: string },
): Promise<void> {
  await hostRpc(hostUrl, cookie, 'session', 'prompt', {
    request: {
      requestId: randomUUID(),
      sessionId: request.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: request.text }],
    },
  })
}

/** One routable provider group from the official model catalog. */
export interface ModelCatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }[]
}

/** Dialog-facing option derived from one official provider group. */
export interface ProviderOptionView {
  readonly providerId: string
  readonly name: string
  readonly defaultModel: string
  readonly models: ModelCatalogGroup['models']
  readonly enabled: true
  readonly hasKey: true
  readonly isDefault: boolean
}

/**
 * Map the official catalog to the create-employee dialog options.
 *
 * Providers with no catalog models are omitted (there is nothing to bind);
 * the deployment default model wins when it belongs to the group.
 */
export function providerOptionsFromCatalog(catalog: ModelCatalog): ProviderOptionView[] {
  return catalog.groups.flatMap((group) => {
    const first = group.models[0]
    if (first === undefined) return []
    const preferred = catalog.default?.provider === group.id
      && catalog.default.model !== undefined
      && group.models.some(model => model.id === catalog.default?.model)
      ? catalog.default.model
      : first.id
    return [{
      providerId: group.id,
      name: group.name,
      defaultModel: preferred,
      models: group.models,
      enabled: true as const,
      // A provider only appears in the catalog when its models are routable.
      hasKey: true as const,
      isDefault: catalog.default?.provider === group.id,
    }]
  })
}

/** `session/modelCatalog` value: the official source of providers and models. */
export interface ModelCatalog {
  readonly default?: { readonly provider?: string; readonly model?: string }
  readonly groups: readonly ModelCatalogGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

/**
 * Official model catalog (per-provider groups with reasoning efforts).
 *
 * This is the same directory the official "Models" page writes: a provider
 * configured there appears here, even when this app's legacy provider table is
 * empty. The value is an object, not an array; groups/failures are optional.
 */
export async function fetchModelCatalog(hostUrl: string, cookie: string): Promise<ModelCatalog> {
  const value = await hostRpc(hostUrl, cookie, 'session', 'modelCatalog', {})
  if (typeof value !== 'object' || value === null) return { groups: [], failures: [] }
  const record = value as {
    default?: { provider?: unknown; model?: unknown }
    groups?: unknown
    failures?: unknown
  }
  const defaultSelection = typeof record.default?.provider === 'string'
    ? {
      provider: record.default.provider,
      ...(typeof record.default.model === 'string' ? { model: record.default.model } : {}),
    }
    : undefined
  const groups: ModelCatalogGroup[] = Array.isArray(record.groups)
    ? record.groups.flatMap((group: unknown) => {
      if (typeof group !== 'object' || group === null) return []
      const entry = group as { id?: unknown; name?: unknown; models?: unknown }
      if (typeof entry.id !== 'string' || !Array.isArray(entry.models)) return []
      return [{
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        models: entry.models as ModelCatalogGroup['models'],
      }]
    })
    : []
  const failures: ModelCatalog['failures'] = Array.isArray(record.failures)
    ? record.failures.flatMap((failure: unknown) => {
      if (typeof failure !== 'object' || failure === null) return []
      const entry = failure as { id?: unknown; name?: unknown; message?: unknown }
      if (typeof entry.id !== 'string') return []
      return [{
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        message: typeof entry.message === 'string' ? entry.message : '',
      }]
    })
    : []
  return {
    groups,
    failures,
    ...(defaultSelection === undefined ? {} : { default: defaultSelection }),
  }
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

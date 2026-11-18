import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native welcome operations using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'
import { DesktopHostAuthenticationError, HOST_AUTH_ATTEMPTS, authenticateWebHost } from './web-document.ts'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface WelcomeState {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  readonly writable: boolean
  readonly localePreference: string | null
}

/** Narrow operations available to the native welcome flow. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  readonly account: DesktopAccountBackend
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns Configured-key presence and the shared language preference, without credential values. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /**
   * @param apiKey - User-entered official provider key.
   * @returns A safe write outcome without provider diagnostics.
   */
  save(apiKey: string): Promise<{ ok: boolean }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * An unauthenticated response is retried once; a remaining failure is typed so
 * startup can degrade instead of aborting.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @param cookies - Cookie reader for the same loopback session.
 * @returns metadata reads and write-only credential operations over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  let status: number | undefined
  let cause: unknown
  for (let attempt = 0; attempt < HOST_AUTH_ATTEMPTS; attempt++) {
    try {
      const authenticated = await send(authenticatedUrl, { credentials: 'include' })
      await authenticated.body?.cancel()
      if (authenticated.ok) break
      status = authenticated.status
      cause = undefined
    } catch (error) {
      status = undefined
      cause = error
    }
    if (attempt === HOST_AUTH_ATTEMPTS - 1) {
      throw new DesktopHostAuthenticationError('desktop welcome: Web authentication failed', status,
        cause === undefined ? undefined : { cause })
    }
  }
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) {
      // Account and analytics are optional plugins in Cadre Heihei; their
      // absence is a 404 and the caller handles it as a disabled feature.
      const optional = request.namespace === 'account' || request.namespace === 'productAnalytics'
      if (!(optional && response.status === 404)) {
        console.error(`desktop welcome: ${method} request failed (HTTP ${String(response.status)})`)
      }
      throw new Error('desktop welcome: Web request failed')
    }
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const account = desktopAccountBackend(origin, invoke, cookies)
  const settingsAndReference = async () => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
    const official: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
    if (official === undefined) return { settings: { namespaces: settings.namespaces }, ref: undefined }
    if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') {
      throw new Error('desktop welcome: missing official DeepSeek credential reference')
    }
    return { settings: { namespaces: settings.namespaces }, ref: official.value.apiKeyEnv }
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const read = async (): Promise<WelcomeState> => {
    const { settings, ref } = await settingsAndReference()
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
    const namespaces = settings.namespaces
    const refs = providers.flatMap((provider: unknown) => {
      if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
        throw new Error('desktop welcome: invalid provider settings address')
      }
      const namespace: unknown = namespaces.find((item: unknown) => record(item) && item.ns === provider.settingsNs)
      let value: unknown = record(namespace) ? namespace.value : undefined
      for (const key of provider.settingsPath as unknown[]) {
        if (typeof key !== 'string') throw new Error('desktop welcome: invalid provider settings path')
        value = record(value) ? value[key] : undefined
      }
      return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
    })
    const unique = [...new Set([...(ref === undefined ? [] : [ref]), ...refs])]
    const states: Record<string, unknown> = {}
    // credentials.describe accepts at most 64 references per request.
    for (let offset = 0; offset < unique.length; offset += 64) {
      const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
      if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
      Object.assign(states, batch)
    }
    if (ref !== undefined && !record(states[ref])) throw new Error('desktop welcome: missing credential metadata')
    // Cadre Heihei ships without the account plugin, so `account/getState` is
    // not routed. The API-key route must still boot the workspace; an absent
    // account backend is a signed-out account, not a startup failure.
    const loggedIn = await account.state()
      .then(state => state.status === 'credential-stored')
      .catch(() => false)
    return {
      loggedIn,
      hasApiKey: Object.values(states).some(value => record(value) && value.configured === true),
      writable: ref !== undefined && record(states[ref]) && states[ref].writable === true,
      localePreference: localePreference(namespaces),
    }
  }
  return {
    account,
    read,
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() {
      const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
      if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
      return localePreference(settings.namespaces)
    },
    async save(apiKey) {
      if (!/^[\x21-\x7e]+$/.test(apiKey)) return { ok: false }
      try {
        const { ref } = await settingsAndReference()
        if (ref === undefined) return { ok: false }
        await invoke({ namespace: 'credentials', method: 'set', args: { ref, value: apiKey } })
        return { ok: true }
      } catch {
        // Provider diagnostics may contain credentials; the native form owns failure copy.
        return { ok: false }
      }
    },
  }
}

/** Welcome connection plus the cookie needed by the Web document forwarder. */
export interface DesktopWelcomeStartup {
  /** Connected Host backend; absent when the launch URL stayed unauthenticated. */
  readonly backend: DesktopWelcomeBackend | undefined
  /** Host cookie for forwarded Web requests; absent when authentication degraded. */
  readonly hostCookie: string | undefined
}

/**
 * Authenticate the Host launch URL and connect the native welcome backend.
 *
 * A proxy can answer loopback with 401/407/502 even though the Host is healthy.
 * Each authentication path retries once; a remaining typed failure degrades to
 * the native welcome window instead of rejecting startup. Unrelated failures
 * still reject so they are not hidden.
 * @param url - URL reported by the running Desktop Host.
 * @param send - Loopback transport, normally the dedicated session fetch.
 * @param cookies - Cookie reader for the same loopback session.
 * @returns Backend and cookie, either absent after authentication degradation.
 */
export async function startDesktopWelcome(
  url: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string>,
): Promise<DesktopWelcomeStartup> {
  let hostCookie: string | undefined
  try {
    hostCookie = await authenticateWebHost(url, send, cookies)
  } catch (error) {
    if (!(error instanceof DesktopHostAuthenticationError)) throw error
    console.warn(`desktop host authentication failed; continuing to welcome (${describeAuthFailure(error)})`)
  }
  let backend: DesktopWelcomeBackend | undefined
  try {
    backend = await connectDesktopWelcome(url, send, cookies)
  } catch (error) {
    if (!(error instanceof DesktopHostAuthenticationError)) throw error
    console.warn(`desktop welcome authentication failed; continuing to welcome (${describeAuthFailure(error)})`)
  }
  if (hostCookie === undefined) {
    try {
      const stored = await cookies()
      if (stored !== '') hostCookie = stored
    } catch (error) {
      console.warn(`desktop host cookie unavailable after degraded authentication: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { backend, hostCookie }
}

/**
 * Format a typed authentication failure without exposing proxy credentials.
 * @param error - Failure thrown by either loopback authentication path.
 * @returns HTTP status or transport description for the degradation log.
 */
function describeAuthFailure(error: DesktopHostAuthenticationError): string {
  if (error.status !== undefined) return `HTTP ${String(error.status)}`
  return error.cause instanceof Error ? error.cause.message : 'transport failure'
}

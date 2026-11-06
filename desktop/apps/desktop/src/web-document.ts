/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
const BOOT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>'

/** One retry absorbs a proxy's transient 401/407/502 before startup degrades. */
export const HOST_AUTH_ATTEMPTS = 2

/** A Host launch exchange that produced no usable cookie. */
export class DesktopHostAuthenticationError extends Error {
  /**
   * @param message - Operation-specific failure without proxy credentials.
   * @param status - Final HTTP status, or undefined when the transport failed.
   * @param options - Original transport failure retained for crash reports.
   */
  constructor(message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DesktopHostAuthenticationError'
  }
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = pathname === '/' || pathname === '/index.html'
    ? body.toString().replace('<head>', '<head>' + BOOT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * The Chromium session follows the launch redirect to the authenticated index;
 * an unauthenticated response or transport failure is retried once, after which
 * the typed failure lets startup continue into welcome without treating the
 * proxy as fatal. `redirect: 'manual'` is deliberately not used: Electron's
 * `session.fetch` cancels a manual redirect, so a followed 2xx is the success
 * signal and the cookie comes from the session jar.
 * @param url - Authenticated URL reported by the owned Host process.
 * @param send - Loopback transport; defaults to Node fetch for direct unit use.
 * @param cookies - Cookie reader for transports that hide `set-cookie`.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(
  url: string,
  send: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<string> {
  let status: number | undefined
  let cause: unknown
  for (let attempt = 0; attempt < HOST_AUTH_ATTEMPTS; attempt++) {
    try {
      const response = await send(url, { credentials: 'include' })
      const header = cookieHeader(response.headers.get('set-cookie'))
      await response.body?.cancel()
      if (response.ok || response.status === 303) {
        const stored = await cookies()
        const value = stored === '' ? header : stored
        if (value !== undefined) return value
      }
      status = response.status
      cause = undefined
    } catch (error) {
      status = undefined
      cause = error
    }
  }
  throw new DesktopHostAuthenticationError('Desktop Host authentication failed', status,
    cause === undefined ? undefined : { cause })
}

/**
 * Reduce a `set-cookie` header to the request cookie value.
 * @param header - First `set-cookie` header, if any.
 * @returns Cookie pair without attributes, or undefined when absent/empty.
 */
function cookieHeader(header: string | null): string | undefined {
  if (header === null) return undefined
  const end = header.indexOf(';')
  const value = end < 0 ? header : header.slice(0, end)
  return value === '' ? undefined : value
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}

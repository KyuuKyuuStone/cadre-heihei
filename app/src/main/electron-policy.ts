/**
 * Electron 策略纯函数（无 electron import，可在 node:test 直测）。
 *
 * - CSP：生产严格；dev 仅放行本地 Vite HMR，dev 值不进入生产路径；
 * - 导航：dev 只允许 Vite 源，prod 只允许 renderer 产物目录内的 file://；
 * - index.html meta 注入（构建期双保险，作用于 dist 产物，不改 renderer 源码）。
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AppMode = 'dev' | 'prod'

export const DEV_SERVER_URL = 'http://localhost:1420'

export const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'"

export const DEV_CONNECT_SRC = `connect-src ws://localhost:1420 http://localhost:1420`

export function buildContentSecurityPolicy(mode: AppMode): string {
  if (mode === 'prod') return PROD_CSP
  return PROD_CSP.replace("connect-src 'none'", DEV_CONNECT_SRC)
}

export interface ModeInputs {
  readonly isPackaged: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}

/** 显式 CADRE_MODE 优先；CADRE_DEV_SERVER_URL 表示 dev；默认 prod。 */
export function resolveAppMode(inputs: ModeInputs): AppMode {
  const explicit = inputs.env.CADRE_MODE
  if (explicit === 'dev' || explicit === 'prod') return explicit
  if (inputs.env.CADRE_DEV_SERVER_URL !== undefined) return 'dev'
  return 'prod'
}

export interface NavigationPolicy {
  readonly mode: AppMode
  readonly devServerUrl: string
  readonly rendererRoot: string
}

/** dev：同源才允许；prod：仅 rendererRoot 内的 file://。 */
export function isAllowedNavigation(rawUrl: string, policy: NavigationPolicy): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (policy.mode === 'dev') {
    try {
      return url.origin === new URL(policy.devServerUrl).origin
    } catch {
      return false
    }
  }

  if (url.protocol !== 'file:') return false
  try {
    const target = resolve(fileURLToPath(url))
    const root = resolve(policy.rendererRoot)
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

export function hasCspMeta(html: string): boolean {
  return /<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/i.test(html)
}

/**
 * 往 dist/index.html 注入生产 CSP meta；已有则替换 content，幂等。
 * CSP 只含单引号，可安全放进双引号属性。
 */
export function applyCspMeta(html: string, csp: string = PROD_CSP): string {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`
  const existing =
    /<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/i
  if (existing.test(html)) return html.replace(existing, tag)
  const head = /<\/head>/i
  if (head.test(html)) return html.replace(head, `  ${tag}\n</head>`)
  return `${tag}\n${html}`
}

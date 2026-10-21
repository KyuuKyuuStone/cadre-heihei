/** Electron 纯策略：CSP / 导航 / meta / 模式。 */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  DEV_SERVER_URL,
  PROD_CSP,
  applyCspMeta,
  buildContentSecurityPolicy,
  hasCspMeta,
  isAllowedNavigation,
  resolveAppMode,
} from '../../src/main/electron-policy.ts'

test('CSP：生产严格，dev 仅放行本地 Vite HMR', () => {
  const prod = buildContentSecurityPolicy('prod')
  assert.equal(prod, PROD_CSP)
  assert.equal(prod.includes('localhost'), false)
  assert.equal(prod.includes('ws:'), false)

  const dev = buildContentSecurityPolicy('dev')
  assert.notEqual(dev, prod)
  assert.ok(dev.includes("connect-src ws://localhost:1420 http://localhost:1420"))
  assert.ok(dev.includes("default-src 'self'"))
  assert.ok(dev.includes("object-src 'none'"))
})

test('meta 注入：插入、替换与幂等，dev CSP 不进入产物', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
  assert.equal(hasCspMeta(html), false)
  const injected = applyCspMeta(html, PROD_CSP)
  assert.equal(hasCspMeta(injected), true)
  assert.ok(injected.includes('Content-Security-Policy'))
  assert.ok(injected.includes(PROD_CSP))
  assert.equal(injected.includes('localhost:1420'), false)
  assert.equal(applyCspMeta(injected, PROD_CSP), injected, '幂等')

  const legacy = applyCspMeta(
    '<html><head><meta http-equiv="content-security-policy" content="old"></head></html>',
    PROD_CSP,
  )
  assert.equal(legacy.includes('content="old"'), false)
  assert.ok(legacy.includes(PROD_CSP))
})

test('模式解析：显式 CADRE_MODE 优先，dev URL 次之，默认 prod', () => {
  assert.equal(resolveAppMode({ isPackaged: false, env: { CADRE_MODE: 'dev' } }), 'dev')
  assert.equal(resolveAppMode({ isPackaged: true, env: { CADRE_MODE: 'prod' } }), 'prod')
  assert.equal(
    resolveAppMode({ isPackaged: false, env: { CADRE_DEV_SERVER_URL: DEV_SERVER_URL } }),
    'dev',
  )
  assert.equal(resolveAppMode({ isPackaged: false, env: {} }), 'prod')
})

test('导航：dev 仅同源；prod 仅 rendererRoot 内 file://', () => {
  const devPolicy = {
    mode: 'dev' as const,
    devServerUrl: DEV_SERVER_URL,
    rendererRoot: resolve('/tmp/app/dist/renderer'),
  }
  assert.equal(isAllowedNavigation('http://localhost:1420/', devPolicy), true)
  assert.equal(isAllowedNavigation('http://localhost:1420/index.html?x=1', devPolicy), true)
  assert.equal(isAllowedNavigation('https://evil.example/', devPolicy), false)
  assert.equal(isAllowedNavigation('http://localhost:1421/', devPolicy), false)

  const root = resolve('/tmp/app/dist/renderer')
  const prodPolicy = { mode: 'prod' as const, devServerUrl: DEV_SERVER_URL, rendererRoot: root }
  assert.equal(
    isAllowedNavigation(pathToFileURL(join(root, 'index.html')).href, prodPolicy),
    true,
  )
  assert.equal(
    isAllowedNavigation(pathToFileURL(join(root, 'assets', 'app.js')).href, prodPolicy),
    true,
  )
  assert.equal(
    isAllowedNavigation(pathToFileURL(join(root, '..', 'secret.html')).href, prodPolicy),
    false,
  )
  assert.equal(isAllowedNavigation('https://evil.example/', prodPolicy), false)
  assert.equal(isAllowedNavigation('not a url', prodPolicy), false)
})

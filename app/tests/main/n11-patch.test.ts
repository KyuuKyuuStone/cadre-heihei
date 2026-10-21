/** N11：会话 patch 禁用 llm-deepseek、启用 pi-ai deepseek 路由。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIdentityPatch } from '../../src/runtime/patches.ts'

const BASE = {
  sessionId: 's1',
  projectId: 'p1',
  databasePath: 'C:/db/cadre.sqlite',
  serverPath: 'C:/app/src/mcp/server.ts',
}

test('patch：禁用 llm-deepseek，配置 llm-pi-ai deepseek（无 baseURL）', () => {
  const content = buildIdentityPatch(BASE)
  assert.match(content, /- id: llm-deepseek\n {2}disabled: true/)
  assert.match(content, /- id: llm-pi-ai\n {2}config:/)
  assert.match(content, /providers:\n {6}deepseek:\n {8}apiKeyEnv: DEEPSEEK_API_KEY/)
  assert.equal(content.includes('baseURL:'), false)
  assert.match(content, /- insert:/)
})

test('patch：测试用 baseURL 被引用；非法 URL fail-closed', () => {
  const content = buildIdentityPatch({ ...BASE, providerBaseUrl: 'http://127.0.0.1:18711' })
  assert.ok(content.includes('baseURL: "http://127.0.0.1:18711"'))
  assert.throws(
    () => buildIdentityPatch({ ...BASE, providerBaseUrl: 'file:///c:/secret' }),
    /providerBaseUrl/,
  )
  assert.throws(
    () => buildIdentityPatch({ ...BASE, providerBaseUrl: 'http://user:pass@127.0.0.1:1' }),
    /providerBaseUrl/,
  )
})

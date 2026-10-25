import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished } from 'vitest'
import { fetchModelCatalog, promptSession, providerOptionsFromCatalog } from '../src/provider-runtime.ts'

interface RpcRequestBody {
  rpcId?: string
  method?: string
  payload?: {
    args?: {
      request?: {
        requestId?: string
        sessionId?: string
        mode?: string
        content?: unknown
      }
    }
  }
}

/** Serve one RPC response and hand back the decoded request body. */
async function fakeHost(value: unknown): Promise<{ url: string; requests: RpcRequestBody[] }> {
  const requests: RpcRequestBody[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const parsed = JSON.parse(body) as RpcRequestBody
      requests.push(parsed)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: parsed.rpcId,
        result: { ok: true, value },
      }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(address.port)}`, requests }
}

it('reads the official catalog object shape (not an array)', async () => {
  const host = await fakeHost({
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    routableProviders: ['deepseek'],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }],
    failures: [{ id: 'broken', name: 'Broken', message: 'boom' }],
  })

  const catalog = await fetchModelCatalog(host.url, 'cookie=test')
  const options = providerOptionsFromCatalog(catalog)

  expect(host.requests[0]?.method).toBe('session/modelCatalog')
  expect(options).toHaveLength(1)
  expect(options[0]).toMatchObject({ providerId: 'deepseek', defaultModel: 'deepseek-chat' })
  expect(catalog.failures[0]?.id).toBe('broken')
})

it('admits the report-in prompt as one queued text part', async () => {
  const host = await fakeHost({ accepted: true })

  await promptSession(host.url, 'cookie=test', { sessionId: 's-1', text: '【系统】报到' })

  const request = host.requests[0]?.payload?.args?.request
  expect(host.requests[0]?.method).toBe('session/prompt')
  expect(request).toMatchObject({
    sessionId: 's-1',
    mode: 'queue',
    content: [{ type: 'text', text: '【系统】报到' }],
  })
  expect(typeof request?.requestId).toBe('string')
})

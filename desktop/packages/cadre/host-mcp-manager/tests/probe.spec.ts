/**
 * The one-shot probe `test` runs: a real `mcp-client` connection to a real child
 * process, its tool list, and the two failure classes a caller can act on.
 * @module
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMcpProbe, instructionBytesOf, PROBE_TIMEOUT_MS } from '../src/probe.ts'
import type { McpServerManifest } from '../src/types.ts'

const FIXTURE_SERVER = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

function stdio(id: string, command: string, args: readonly string[]): McpServerManifest {
  return { id, name: id, transport: 'stdio', command, args, env: {}, headers: {}, tags: [] }
}

describe('createMcpProbe', () => {
  it('connects once, reads the tool list, and disposes', async () => {
    const probe = createMcpProbe({ timeoutMs: 60_000 })
    const outcome = await probe(stdio('fixture', process.execPath, [FIXTURE_SERVER]))
    expect(outcome.tools.length).toBeGreaterThan(0)
    expect(outcome.instructionBytes).toBeGreaterThan(0)
  }, 90_000)

  it('reports a connection failure when the command cannot start', async () => {
    const probe = createMcpProbe({ timeoutMs: 30_000 })
    await expect(probe(stdio('broken', 'dsh-no-such-executable', [])))
      .rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' })
  }, 60_000)

  it('reports a timeout when the server never completes the handshake', async () => {
    const probe = createMcpProbe({ timeoutMs: 500 })
    // A live child that never speaks MCP keeps the handshake pending.
    await expect(probe(stdio('silent', process.execPath, ['-e', 'setInterval(() => {}, 1000)'])))
      .rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
  }, 60_000)
})

describe('instructionBytesOf', () => {
  it('counts UTF-8 bytes of the captured list, not characters', () => {
    expect(instructionBytesOf([{ name: 'a', description: '' }])).toBe(Buffer.byteLength('[{"name":"a","description":""}]'))
    expect(instructionBytesOf([{ name: 'a', description: '说明' }]))
      .toBeGreaterThan(instructionBytesOf([{ name: 'a', description: 'ab' }]))
  })

  it('defaults the deadline to fifteen seconds', () => {
    expect(PROBE_TIMEOUT_MS).toBe(15_000)
  })
})

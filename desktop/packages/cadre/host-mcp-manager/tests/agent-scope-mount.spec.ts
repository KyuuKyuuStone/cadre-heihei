/**
 * Prerequisite proof for design §5 (`待验证`): a real Agent's `ctx` accepts the
 * real `mcp-client` plugin, the server's tools land in that agent's tool scope,
 * stay invisible to a sibling agent, and disappear when the fiber disposes.
 *
 * Tool registration is scope-keyed, so the assertions query the agent's scope
 * explicitly (`tools.get(name, scope)` / `tools.schemas(scope)`). The unqualified
 * `ctx.tools` view binds through the calling context, and `agent.ctx` is an
 * `extend`-derived context, so that view reports the root scope instead.
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpServerConfig } from '@deepseek-ai/dsh-mcp-client'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The mcp-client suite's stdio fixture server, reused read-only as a real peer. */
const FIXTURE_SERVER = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

/**
 * @param serverName - namespace the registration must occupy.
 * @returns a stdio config that spawns the real fixture server.
 */
function probeConfig(serverName: string): McpServerConfig {
  return {
    transport: 'stdio',
    serverName,
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {},
    cwd: process.cwd(),
    toolCallTimeoutMs: 15_000,
    failOnStartupError: true,
    reconnect: { enabled: false },
  }
}

describe('agent.ctx.plugin mounts a real MCP server in the agent scope', () => {
  it('publishes the server tools into that agent scope and removes them on dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-agent-scope-'))
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
      const loop = await mountAgentLoopTestHarness(ctx)
      const agent = await loop.create(SessionId('probe'), { provider: 'mock', model: 'mock' }, { cwd: root })
      const sibling = await loop.create(SessionId('sibling'), { provider: 'mock', model: 'mock' }, { cwd: root })
      const agentScope = scopeOf(agent.ctx)
      const siblingScope = scopeOf(sibling.ctx)

      expect(ctx.tools.get('mcp__probe__add', agentScope)).toBeUndefined()

      // The design's anchor: agent.ctx is a live Cordis Context, so plugin() mounts a
      // child fiber in the agent scope and returns the Fiber that owns its disposal.
      const fiber = agent.ctx.plugin(McpClient, probeConfig('probe'))
      await fiber

      // The server's tools belong to this agent's scope only.
      expect(ctx.tools.get('mcp__probe__add', agentScope)).toBeDefined()
      expect(ctx.tools.get('mcp__probe__greet', agentScope)).toBeDefined()
      expect(ctx.tools.get('mcp__probe__add', siblingScope)).toBeUndefined()

      // Model-facing surface: the loop renders the prompt for `scope: agent`, so the
      // schemas the model receives carry the same names.
      expect(ctx.tools.schemas(agentScope).map(schema => schema.name)).toContain('mcp__probe__add')

      await fiber.dispose()
      expect(ctx.tools.get('mcp__probe__add', agentScope)).toBeUndefined()
      expect(ctx.tools.schemas(agentScope)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/**
 * REAL-composition coverage for the manager: a test-only `cordis.yml` boots
 * through the vendored Loader with the real webserver, the real agent loop, and
 * the manager itself; a real stdio MCP server mounts into a real Agent's tool
 * scope on a real turn.
 *
 * The only test-provided pieces are the transport admission seam and the model
 * input (the mock adapter stands in for a nondeterministic provider). Everything
 * the assertions touch — the manager plugin, the SQLite ledger, the catalog
 * directory, the MCP server process, the Agent, and `mcp-client` — is real.
 * @module
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { openLedger, readSelection, writeSelection } from '../src/selection.ts'
import {
  bootComposition, callRoute, compositionModules, compositionRows, makeCompositionPaths, removeCompositionPaths,
  seedLedger, serviceOf, waitForService, writeStdioServer,
} from './real-composition.ts'

const FIXTURE_SERVER = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

/** Tool-registry surface these assertions read (scope-keyed, as the registry is). */
interface ToolsSurface {
  get(name: string, scope?: unknown): unknown
  schemas(scope?: unknown): readonly { readonly name: string }[]
}

/** Minimal Agent surface a real step drives. */
interface DrivableAgent {
  readonly ctx: unknown
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/** Loop driver the booted composition publishes as `testLoop`. */
interface TestLoop {
  create(id: SessionId, options?: unknown, meta?: unknown): Promise<unknown>
}

async function until(probe: () => unknown, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe() !== undefined) return
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }
}

describe('host-mcp-manager booted from cordis.yml', () => {
  it('mounts a catalog server on a real turn, swaps generations, unmounts, and disposes', async () => {
    const admission = { reject: false }
    const paths = await makeCompositionPaths('mcp-real-')
    seedLedger(paths.ledgerPath, [])
    await writeStdioServer(paths.serversDir, {
      id: 'probe', name: 'Probe', command: process.execPath,
      args: [FIXTURE_SERVER], toolCallTimeoutMs: 15_000,
    })
    const sessionId = 'probe-session'
    writeSelection(paths.ledgerPath, sessionId, { servers: [{ id: 'probe', enabled: true }] })

    let context: Context | undefined
    try {
      context = await bootComposition({
        root: paths.root,
        rows: compositionRows({ ...paths, admission }),
        modules: compositionModules(admission),
      })
      const booted = context
      await waitForService(booted, 'testLoop')
      await waitForService(booted, 'tools')
      const llm = serviceOf(booted, 'llm') as { registerAdapter(names: readonly string[], adapter: MockAdapter): void }
      llm.registerAdapter(['mock'], new MockAdapter([
        textResponse('one'), textResponse('two'), textResponse('three'), textResponse('four'),
      ]))
      const loop = serviceOf(booted, 'testLoop') as TestLoop
      const tools = serviceOf(booted, 'tools') as ToolsSurface
      const agent = await loop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' }) as DrivableAgent
      const scope = scopeOf(agent.ctx as Context)

      const step = async (): Promise<void> => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }

      // The first real turn fires `agent/pre-step`, so the manager mounts the
      // catalog server that the ledger selects.
      await step()
      await until(() => tools.get('mcp__probe__add', scope))
      expect(tools.schemas(scope).map(schema => schema.name)).toContain('mcp__probe__add')

      // A changed override alters the resolved config, so the manager disposes the
      // old fiber and mounts the new generation; the tool stays reachable.
      writeSelection(paths.ledgerPath, sessionId, {
        servers: [{ id: 'probe', enabled: true, overrides: { toolCallTimeoutMs: 30_000 } }],
      })
      await step()
      await until(() => tools.get('mcp__probe__add', scope))

      // Disabling the entry unmounts it on the next step.
      writeSelection(paths.ledgerPath, sessionId, { servers: [{ id: 'probe', enabled: false }] })
      await step()
      await until(() => (tools.get('mcp__probe__add', scope) === undefined ? true : undefined))
      expect(tools.schemas(scope).map(schema => schema.name)).not.toContain('mcp__probe__add')

      // Plugin disposal removes the routes with the rest of the manager's effects,
      // and the mounted catalog state goes with the context.
      await booted.fiber.dispose()
      context = undefined
      expect(tools.get('mcp__probe__add', scope)).toBeUndefined()
    } finally {
      if (context !== undefined) await context.fiber.dispose()
      await removeCompositionPaths(paths.root)
    }
  }, 120_000)

  it('converges a CRUD-written catalog entry onto the next step without another channel', async () => {
    const admission = { reject: false }
    const paths = await makeCompositionPaths('mcp-crud-real-')
    const sessionId = 'crud-session'
    seedLedger(paths.ledgerPath, [{ projectId: 'p1', sessionId, role: 'supervisor' }])

    let context: Context | undefined
    try {
      context = await bootComposition({
        root: paths.root,
        rows: compositionRows({ ...paths, admission }),
        modules: compositionModules(admission),
      })
      const booted = context
      await waitForService(booted, 'testLoop')
      await waitForService(booted, 'tools')
      const origin = (serviceOf(booted, 'webServer') as { getOrigin(): string }).getOrigin()
      const llm = serviceOf(booted, 'llm') as { registerAdapter(names: readonly string[], adapter: MockAdapter): void }
      llm.registerAdapter(['mock'], new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')]))
      const loop = serviceOf(booted, 'testLoop') as TestLoop
      const tools = serviceOf(booted, 'tools') as ToolsSurface
      const agent = await loop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' }) as DrivableAgent
      const scope = scopeOf(agent.ctx as Context)
      const step = async (): Promise<void> => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }

      // Nothing is selected, so the first turn exposes no MCP tool.
      await step()
      expect(tools.schemas(scope).map(schema => schema.name).filter(name => name.startsWith('mcp__'))).toEqual([])

      // `add` writes the catalog directory; `set` records the selection. Both are
      // the only channel the next step needs — no restart, no notification.
      const added = await callRoute(origin, '/cadre/mcp/add', {
        projectId: 'p1',
        actorSessionId: sessionId,
        manifest: {
          id: 'crud', name: 'CRUD', transport: 'stdio', command: process.execPath,
          args: [FIXTURE_SERVER], toolCallTimeoutMs: 15_000,
        },
      })
      expect(added.status).toBe(200)
      const selected = await callRoute(origin, '/cadre/mcp/set', {
        projectId: 'p1', actorSessionId: sessionId, targetSessionId: sessionId,
        servers: [{ id: 'crud', enabled: true }],
      })
      expect(selected.status).toBe(200)

      await step()
      await until(() => tools.get('mcp__crud__add', scope))
      expect(tools.schemas(scope).map(schema => schema.name)).toContain('mcp__crud__add')

      // Removing the entry makes the stored selection an inert orphan: the next
      // step skips it, and the row itself is never rewritten by the manager.
      const removed = await callRoute(origin, '/cadre/mcp/remove', {
        projectId: 'p1', actorSessionId: sessionId, serverId: 'crud', confirm: true,
      })
      expect(removed.status).toBe(200)
      await step()
      await until(() => (tools.get('mcp__crud__add', scope) === undefined ? true : undefined))
      expect(readSelection(openLedger(paths.ledgerPath), sessionId).servers).toEqual([{ id: 'crud', enabled: true }])
    } finally {
      if (context !== undefined) await context.fiber.dispose()
      await removeCompositionPaths(paths.root)
    }
  }, 120_000)
})

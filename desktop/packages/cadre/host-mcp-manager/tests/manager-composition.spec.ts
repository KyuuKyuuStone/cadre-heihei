/**
 * The manager mounting a real server through its real `agent/pre-step` listener:
 * a real ledger row selects a real stdio MCP server, which appears in that
 * agent's tool scope, remounts when the config changes, and disappears when the
 * selection is cleared.
 *
 * What is real: the manager plugin (`apply`), the SQLite ledger, the catalog scan,
 * the agent from the production AgentLoop, the `mcp-client` plugin, and the
 * `mcp-client` fixture MCP server process. What is stubbed: the host context that
 * delivers `agent/pre-step`, so the listener is invoked directly instead of
 * through a Loader-booted profile.
 * @module
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { apply, type Config } from '../src/index.ts'
import { writeSelection } from '../src/selection.ts'
import type { PreStepPayload } from '../src/types.ts'

const FIXTURE_SERVER = fileURLToPath(new URL('../../../mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

type Listener = (payload: PreStepPayload, next: () => unknown) => unknown

interface Harness {
  readonly listeners: Listener[]
  readonly provided: Map<string, unknown>
  readonly cleanups: (() => void)[]
}

/** Stand-in for the host context: records the hook, the service, and the cleanups. */
function hostContext(): Harness {
  const listeners: Listener[] = []
  const provided = new Map<string, unknown>()
  const cleanups: (() => void)[] = []
  return { listeners, provided, cleanups }
}

function install(harness: Harness, config: Config): void {
  apply({
    provide(name, value) {
      harness.provided.set(name, value)
    },
    on(_event, listener) {
      harness.listeners.push(listener)
      return listener
    },
    inject() {
      // No web server in this composition; the routes are covered by ipc.spec.ts.
      return undefined
    },
    effect(setup) {
      // The plugin's teardown closes the ledger handle; without it Windows keeps the
      // database file locked after the test.
      harness.cleanups.push(setup())
      return undefined
    },
    get() {
      return undefined
    },
  }, config)
}

async function until<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('host-mcp-manager mounts a catalogue server into one agent scope', () => {
  it('mounts on selection, remounts on a config change, and unmounts when cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-manager-'))
    const ctx = new Context()
    const harness = hostContext()
    try {
      const serversRoot = join(root, 'servers')
      await mkdir(join(serversRoot, 'probe'), { recursive: true })
      await writeFile(join(serversRoot, 'probe', 'manifest.json'), JSON.stringify({
        id: 'probe',
        name: 'Probe',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE_SERVER],
        toolCallTimeoutMs: 15_000,
      }))
      const ledgerPath = join(root, 'ledger.db')
      writeSelection(ledgerPath, 'probe', { servers: [{ id: 'probe', enabled: true }] })

      await mountAgentLoopTestDependencies(ctx)
      ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
      const loop = await mountAgentLoopTestHarness(ctx)
      const agent = await loop.create(SessionId('probe'), { provider: 'mock', model: 'mock' }, { cwd: root })
      const scope = scopeOf(agent.ctx)

      install(harness, { ledgerPath, mcpDir: serversRoot })
      expect(harness.listeners).toHaveLength(1)
      expect(harness.provided.has('mcpSelection')).toBe(true)

      const listener = harness.listeners[0]
      if (listener === undefined) throw new Error('agent/pre-step listener was not registered')
      const step = async (): Promise<void> => {
        await listener({ agent }, () => undefined)
      }

      await step()
      await until(() => ctx.tools.get('mcp__probe__add', scope))
      expect(ctx.tools.schemas(scope).map(schema => schema.name)).toContain('mcp__probe__add')

      // Same selection, new timeout: the resolved config changes, so the fiber swaps
      // and the tool stays reachable.
      writeSelection(ledgerPath, 'probe', {
        servers: [{ id: 'probe', enabled: true, overrides: { toolCallTimeoutMs: 30_000 } }],
      })
      await step()
      await until(() => ctx.tools.get('mcp__probe__add', scope))

      // Disabling the entry removes the server's tools from the step.
      writeSelection(ledgerPath, 'probe', { servers: [{ id: 'probe', enabled: false }] })
      await step()
      await until(() => (ctx.tools.get('mcp__probe__add', scope) === undefined ? true : undefined))
      expect(ctx.tools.schemas(scope).map(schema => schema.name)).not.toContain('mcp__probe__add')
    } finally {
      for (const cleanup of harness.cleanups) cleanup()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})

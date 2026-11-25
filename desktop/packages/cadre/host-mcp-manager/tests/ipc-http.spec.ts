/**
 * Real HTTP coverage for `/cadre/mcp/{catalog,get,set}`: the routes are served by
 * the booted real webserver, the ledger is a real SQLite database, the catalog is
 * a real directory, and only `connection.admit` is test-provided so a denial can
 * be exercised.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  bootComposition, callRoute, compositionModules, compositionRows, makeCompositionPaths,
  removeCompositionPaths, seedLedger, serviceOf, waitForService, writeStdioServer,
} from './real-composition.ts'

const CATALOG = '/cadre/mcp/catalog'
const GET = '/cadre/mcp/get'
const SET = '/cadre/mcp/set'

/** Roster the authorization matrix is checked against. */
const ROSTER = [
  { projectId: 'p1', sessionId: 's-sup', role: 'supervisor' as const },
  { projectId: 'p1', sessionId: 'w-worker', role: 'worker' as const },
  { projectId: 'p1', sessionId: 'w-worker2', role: 'worker' as const },
  { projectId: 'p1', sessionId: 'gone', role: 'worker' as const, state: 'departed' as const },
]

interface Composition {
  readonly context: Context
  readonly origin: string
}

async function bootRoutes(admission: { reject: boolean }): Promise<Composition & { cleanup(): Promise<void> }> {
  const paths = await makeCompositionPaths('mcp-routes-')
  seedLedger(paths.ledgerPath, ROSTER)
  await writeStdioServer(paths.serversDir, {
    id: 'probe', name: 'Probe', command: process.execPath, args: ['-e', 'process.exit(0)'],
  })
  const context = await bootComposition({
    root: paths.root,
    rows: compositionRows({ ...paths, admission }),
    modules: compositionModules(admission),
  })
  await waitForService(context, 'webServer')
  const origin = (serviceOf(context, 'webServer') as { getOrigin(): string }).getOrigin()
  return {
    context,
    origin,
    async cleanup(): Promise<void> {
      await context.fiber.dispose()
      await removeCompositionPaths(paths.root)
    },
  }
}

describe('cadre MCP routes over real HTTP', () => {
  it('serves the catalog to a member and to an off-roster session, and refuses a departed one', async () => {
    const admission = { reject: false }
    const booted = await bootRoutes(admission)
    try {
      const supervisor = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 's-sup' })
      expect(supervisor.status).toBe(200)
      expect(supervisor.ok).toBe(true)
      expect(supervisor.result).toMatchObject({ servers: [{ id: 'probe', selected: false }] })

      // The ledger cannot prove an off-roster session's project; the catalog is
      // still served with nothing selected.
      const outsider = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 'outsider' })
      expect(outsider.status).toBe(200)
      expect(outsider.result).toMatchObject({ servers: [{ id: 'probe', selected: false, enabled: false }] })

      const departed = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 'gone' })
      expect(departed.status).toBe(403)
      expect(departed).toMatchObject({ ok: false, code: 'MCP_FORBIDDEN' })
      expect(departed.remediation).toBeTruthy()
    } finally {
      await booted.cleanup()
    }
  }, 90_000)

  it('reserves another member’s selection for a supervisor and persists what set writes', async () => {
    const admission = { reject: false }
    const booted = await bootRoutes(admission)
    try {
      const denied = await callRoute(booted.origin, CATALOG, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker2',
      })
      expect(denied.status).toBe(403)
      expect(denied).toMatchObject({ ok: false, code: 'MCP_FORBIDDEN' })

      const allowed = await callRoute(booted.origin, CATALOG, {
        projectId: 'p1', actorSessionId: 's-sup', targetSessionId: 'w-worker2',
      })
      expect(allowed.status).toBe(200)

      // A worker may write its own selection; the change is durable and visible.
      const written = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'probe', enabled: true, overrides: { toolCallTimeoutMs: 45_000 } }],
      })
      expect(written.status).toBe(200)
      expect(written.result).toEqual({ servers: [{ id: 'probe', enabled: true, overrides: { toolCallTimeoutMs: 45_000 } }] })

      const read = await callRoute(booted.origin, GET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
      })
      expect(read.status).toBe(200)
      expect(read.result).toEqual({ servers: [{ id: 'probe', enabled: true, overrides: { toolCallTimeoutMs: 45_000 } }] })

      // Sibling isolation: another member's selection is still empty.
      const sibling = await callRoute(booted.origin, GET, {
        projectId: 'p1', actorSessionId: 's-sup', targetSessionId: 'w-worker2',
      })
      expect(sibling.result).toEqual({ servers: [] })

      const crossWrite = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker2', servers: [],
      })
      expect(crossWrite.status).toBe(403)
      expect(crossWrite).toMatchObject({ code: 'MCP_FORBIDDEN' })
    } finally {
      await booted.cleanup()
    }
  }, 90_000)

  it('reports validation, confirmation, transport, and body-limit failures with structured codes', async () => {
    const admission = { reject: false }
    const booted = await bootRoutes(admission)
    try {
      const unknownId = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker', servers: [{ id: 'nope' }],
      })
      expect(unknownId.status).toBe(400)
      expect(unknownId).toMatchObject({ ok: false, code: 'MCP_INVALID' })
      expect(unknownId.remediation).toBeTruthy()

      // A session may never redirect a catalog entry to another endpoint.
      const endpointOverride = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'probe', overrides: { command: 'evil' } }],
      })
      expect(endpointOverride.status).toBe(400)
      expect(endpointOverride).toMatchObject({ code: 'MCP_INVALID' })

      const plaintextSecret = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'probe', overrides: { env: { API_TOKEN: 'plain' } } }],
      })
      expect(plaintextSecret.status).toBe(400)
      expect(plaintextSecret).toMatchObject({ code: 'MCP_INVALID' })

      const missing = await callRoute(booted.origin, CATALOG, { actorSessionId: 's-sup' })
      expect(missing.status).toBe(400)
      expect(missing).toMatchObject({ code: 'MCP_INVALID' })

      const notPost = await callRoute(booted.origin, CATALOG, undefined, 'GET')
      expect(notPost.status).toBe(405)
      expect(notPost).toMatchObject({ code: 'METHOD_NOT_ALLOWED' })

      // The 16 KiB body ceiling rejects before any handler runs.
      const oversized = await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [], pad: 'x'.repeat(17_000),
      })
      expect(oversized.status).toBe(400)
      expect(oversized).toMatchObject({ code: 'MCP_INVALID' })

      // The transport gate answers before routing when the connection refuses.
      admission.reject = true
      const refused = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 's-sup' })
      expect(refused.status).toBe(403)
      expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      admission.reject = false
      const recovered = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 's-sup' })
      expect(recovered.status).toBe(200)
    } finally {
      await booted.cleanup()
    }
  }, 90_000)
})

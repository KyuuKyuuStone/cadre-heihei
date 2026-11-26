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
import type { StdioServerFixture } from './real-composition.ts'

const CATALOG = '/cadre/mcp/catalog'
const GET = '/cadre/mcp/get'
const SET = '/cadre/mcp/set'
const PREVIEW = '/cadre/mcp/preview'
const ADD = '/cadre/mcp/add'
const EDIT = '/cadre/mcp/edit'
const REMOVE = '/cadre/mcp/remove'
const TEST = '/cadre/mcp/test'

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

async function bootRoutes(
  admission: { reject: boolean },
  fixtures: readonly StdioServerFixture[] = [{
    id: 'probe', name: 'Probe', command: process.execPath, args: ['-e', 'process.exit(0)'],
  }],
): Promise<Composition & { cleanup(): Promise<void> }> {
  const paths = await makeCompositionPaths('mcp-routes-')
  seedLedger(paths.ledgerPath, ROSTER)
  for (const fixture of fixtures) await writeStdioServer(paths.serversDir, fixture)
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
      expect(read.result).toEqual({
        servers: [{
          id: 'probe',
          enabled: true,
          overrides: { toolCallTimeoutMs: 45_000 },
          // `get` projects the catalog description for the caller's locale; this
          // fixture carries none, so the projection is empty.
          localizedDescription: '',
        }],
      })

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

  it('projects the description localized for the caller locale, falling back to the base field', async () => {
    const admission = { reject: false }
    const booted = await bootRoutes(admission, [
      {
        id: 'localized', name: 'Localized', command: process.execPath, args: ['-e', 'process.exit(0)'],
        descriptionI18n: { zh: '中文说明', en: 'English text' },
      },
      {
        id: 'plain', name: 'Plain', command: process.execPath, args: ['-e', 'process.exit(0)'],
        description: 'base description',
      },
    ])
    interface CatalogRow { readonly id: string; readonly description: string }
    const catalog = async (locale?: string): Promise<readonly CatalogRow[]> => {
      const reply = await callRoute(booted.origin, CATALOG, {
        projectId: 'p1', actorSessionId: 's-sup', ...(locale === undefined ? {} : { locale }),
      })
      expect(reply.status).toBe(200)
      return (reply.result as { readonly servers: readonly CatalogRow[] }).servers
    }
    const descriptionOf = (rows: readonly CatalogRow[], id: string): string | undefined =>
      rows.find(row => row.id === id)?.description
    try {
      // A `zh*` locale reads the Chinese entry even when it carries a region tag.
      const zh = await catalog('zh-CN')
      expect(descriptionOf(zh, 'localized')).toBe('中文说明')
      // A manifest without translations keeps its base description.
      expect(descriptionOf(zh, 'plain')).toBe('base description')

      const en = await catalog('en-US')
      expect(descriptionOf(en, 'localized')).toBe('English text')
      expect(descriptionOf(en, 'plain')).toBe('base description')

      // No locale selects English, matching the skill catalog's chain.
      expect(descriptionOf(await catalog(), 'localized')).toBe('English text')

      // `get` projects the same chain onto the stored selection.
      await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'localized', enabled: true }],
      })
      const read = await callRoute(booted.origin, GET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker', locale: 'zh-CN',
      })
      expect(read.result).toMatchObject({ servers: [{ id: 'localized', localizedDescription: '中文说明' }] })
      const readEn = await callRoute(booted.origin, GET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker', locale: 'en',
      })
      expect(readEn.result).toMatchObject({ servers: [{ id: 'localized', localizedDescription: 'English text' }] })
    } finally {
      await booted.cleanup()
    }
  }, 90_000)

  it('runs the CRUD and probe routes over real HTTP behind the supervisor and confirm gates', async () => {
    const admission = { reject: false }
    const booted = await bootRoutes(admission, [{
      id: 'probe', name: 'Probe', command: process.execPath, args: ['-e', 'process.exit(0)'],
    }])
    try {
      const added = await callRoute(booted.origin, ADD, {
        projectId: 'p1', actorSessionId: 's-sup',
        manifest: {
          id: 'fresh', name: 'Fresh', transport: 'stdio', command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { API_TOKEN: { fromEnv: 'API_TOKEN' }, LOG_LEVEL: 'debug' },
        },
      })
      expect(added.status).toBe(200)
      expect(added.result).toEqual({ id: 'fresh', created: true, overwritten: false })

      // A worker cannot touch the machine-wide directory, even naming itself.
      const refusedAdd = await callRoute(booted.origin, ADD, {
        projectId: 'p1', actorSessionId: 'w-worker',
        manifest: { id: 'nope', transport: 'stdio', command: 'x' },
      })
      expect(refusedAdd.status).toBe(403)
      expect(refusedAdd).toMatchObject({ code: 'MCP_FORBIDDEN' })

      // The catalog now serves it, and preview masks the secret to its reference.
      const catalog = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 's-sup' })
      expect(catalog.result).toMatchObject({ servers: [{ id: 'fresh' }, { id: 'probe' }] })
      const preview = await callRoute(booted.origin, PREVIEW, {
        projectId: 'p1', actorSessionId: 'w-worker', serverId: 'fresh',
      })
      expect(preview.status).toBe(200)
      expect(preview.result).toMatchObject({
        id: 'fresh', envKeys: [{ name: 'API_TOKEN', fromEnv: 'API_TOKEN' }, { name: 'LOG_LEVEL' }],
      })
      // The reference NAME travels; the literal a non-secret entry carries does not.
      expect(preview.text).toContain('API_TOKEN')
      expect(preview.text).not.toContain('debug')

      const editWithoutConfirm = await callRoute(booted.origin, EDIT, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'fresh', patch: { description: 'x' },
      })
      expect(editWithoutConfirm.status).toBe(409)
      expect(editWithoutConfirm).toMatchObject({ code: 'MCP_CONFIRM_REQUIRED' })
      const edited = await callRoute(booted.origin, EDIT, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'fresh',
        patch: { description: 'edited' }, confirm: true,
      })
      expect(edited.status).toBe(200)
      expect(edited.result).toEqual({ id: 'fresh', updated: true })

      // A conflicting id needs overwrite+confirm; a rename is an input error.
      const conflict = await callRoute(booted.origin, ADD, {
        projectId: 'p1', actorSessionId: 's-sup',
        manifest: { id: 'fresh', transport: 'stdio', command: 'x' },
      })
      expect(conflict.status).toBe(409)
      expect(conflict).toMatchObject({ code: 'MCP_NAME_CONFLICT' })
      const rename = await callRoute(booted.origin, EDIT, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'fresh', patch: { id: 'other' }, confirm: true,
      })
      expect(rename.status).toBe(400)
      expect(rename).toMatchObject({ code: 'MCP_INVALID' })

      // `test` executes, so it needs the supervisor confirmation too.
      const testWithoutConfirm = await callRoute(booted.origin, TEST, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'probe',
      })
      expect(testWithoutConfirm.status).toBe(409)
      expect(testWithoutConfirm).toMatchObject({ code: 'MCP_CONFIRM_REQUIRED' })
      const unknownTest = await callRoute(booted.origin, TEST, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'missing', confirm: true,
      })
      expect(unknownTest.status).toBe(503)
      expect(unknownTest).toMatchObject({ code: 'MCP_SERVER_UNAVAILABLE' })

      // Removing drops the entry from the catalog and leaves the selection inert.
      await callRoute(booted.origin, SET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'fresh', enabled: true }],
      })
      const removeWithoutConfirm = await callRoute(booted.origin, REMOVE, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'fresh',
      })
      expect(removeWithoutConfirm.status).toBe(400)
      expect(removeWithoutConfirm).toMatchObject({ code: 'MCP_INVALID' })
      const removed = await callRoute(booted.origin, REMOVE, {
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'fresh', confirm: true,
      })
      expect(removed.status).toBe(200)
      expect(removed.result).toEqual({ removed: true })
      const afterRemove = await callRoute(booted.origin, CATALOG, { projectId: 'p1', actorSessionId: 's-sup' })
      expect(afterRemove.result).toMatchObject({ servers: [{ id: 'probe' }] })
      const orphanRead = await callRoute(booted.origin, GET, {
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
      })
      expect(orphanRead.result).toEqual({ servers: [] })
    } finally {
      await booted.cleanup()
    }
  }, 120_000)
})

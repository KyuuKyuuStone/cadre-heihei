/**
 * The authorization matrix behind catalog/get/set, and the codes each denial
 * reports. The ledger is a real SQLite database with the collab `members` table.
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpApi } from '../src/ipc.ts'
import { McpError } from '../src/errors.ts'
import { openLedger, readSelection } from '../src/selection.ts'
import type { CatalogScan, McpServerManifest } from '../src/types.ts'

const paths: string[] = []

const manifest: McpServerManifest = {
  id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', args: [], env: {}, headers: {}, tags: [],
}

const scan: CatalogScan = { servers: new Map([['github', manifest]]), health: [] }

async function fixture(): Promise<{ api: ReturnType<typeof createMcpApi>; ledgerPath: string; db: DatabaseSync }> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-ipc-'))
  paths.push(root)
  const ledgerPath = join(root, 'ledger.db')
  const writer = new DatabaseSync(ledgerPath)
  writer.exec(`CREATE TABLE members (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL
  )`)
  const insert = writer.prepare('INSERT INTO members (project_id, session_id, role, state) VALUES (?, ?, ?, ?)')
  insert.run('p1', 'supervisor-1', 'supervisor', 'active')
  insert.run('p1', 'worker-1', 'worker', 'active')
  insert.run('p1', 'worker-2', 'worker', 'active')
  insert.run('p1', 'gone-1', 'worker', 'departed')
  writer.close()
  const db = openLedger(ledgerPath)
  return { api: createMcpApi({ db, ledgerPath, scanCatalog: async () => scan }), ledgerPath, db }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof McpError) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

afterEach(async () => {
  for (const root of paths.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('catalog and get', () => {
  it('serves an off-roster session the catalog with nothing selected', async () => {
    const { api, db } = await fixture()
    try {
      const result = await api.catalog({ projectId: 'p1', actorSessionId: 'outsider-1' })
      expect(result.servers).toHaveLength(1)
      expect(result.servers[0]).toMatchObject({ id: 'github', selected: false, enabled: false, envKeys: [] })
      expect(await api.get({ projectId: 'p1', actorSessionId: 'outsider-1', targetSessionId: 'outsider-1' }))
        .toEqual({ servers: [] })
    } finally {
      db.close()
    }
  })

  it('reserves another member’s selection for a supervisor', async () => {
    const { api, db } = await fixture()
    try {
      expect(await codeOf(() => api.catalog({ projectId: 'p1', actorSessionId: 'worker-1', targetSessionId: 'worker-2' })))
        .toBe('MCP_FORBIDDEN')
      expect(await api.catalog({ projectId: 'p1', actorSessionId: 'supervisor-1', targetSessionId: 'worker-2' }))
        .toMatchObject({ servers: [{ id: 'github' }] })
    } finally {
      db.close()
    }
  })

  it('refuses a departed member', async () => {
    const { api, db } = await fixture()
    try {
      expect(await codeOf(() => api.catalog({ projectId: 'p1', actorSessionId: 'gone-1' }))).toBe('MCP_FORBIDDEN')
    } finally {
      db.close()
    }
  })
})

describe('set', () => {
  it('persists the selection the caller may write', async () => {
    const { api, ledgerPath, db } = await fixture()
    try {
      const stored = await api.set({
        projectId: 'p1', actorSessionId: 'worker-1', targetSessionId: 'worker-1',
        servers: [{ id: 'github', enabled: true, overrides: { toolCallTimeoutMs: 90_000 } }],
      })
      expect(stored.servers).toEqual([{ id: 'github', enabled: true, overrides: { toolCallTimeoutMs: 90_000 } }])
      const reopened = openLedger(ledgerPath)
      try {
        expect(readSelection(reopened, 'worker-1').servers).toHaveLength(1)
      } finally {
        reopened.close()
      }
    } finally {
      db.close()
    }
  })

  it('refuses a worker writing another member and a departed member writing itself', async () => {
    const { api, db } = await fixture()
    try {
      expect(await codeOf(() => api.set({
        projectId: 'p1', actorSessionId: 'worker-1', targetSessionId: 'worker-2', servers: [],
      }))).toBe('MCP_FORBIDDEN')
      expect(await codeOf(() => api.set({
        projectId: 'p1', actorSessionId: 'gone-1', targetSessionId: 'gone-1', servers: [],
      }))).toBe('MCP_FORBIDDEN')
    } finally {
      db.close()
    }
  })

  it('rejects an unknown id and an endpoint override', async () => {
    const { api, db } = await fixture()
    try {
      expect(await codeOf(() => api.set({
        projectId: 'p1', actorSessionId: 'worker-1', targetSessionId: 'worker-1', servers: [{ id: 'nope' }],
      }))).toBe('MCP_INVALID')
      expect(await codeOf(() => api.set({
        projectId: 'p1', actorSessionId: 'worker-1', targetSessionId: 'worker-1',
        servers: [{ id: 'github', overrides: { url: 'https://evil.test' } }],
      }))).toBe('MCP_INVALID')
    } finally {
      db.close()
    }
  })
})

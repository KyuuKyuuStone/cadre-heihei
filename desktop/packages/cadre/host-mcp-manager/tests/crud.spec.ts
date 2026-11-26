/**
 * The CRUD and probe routes behind `/cadre/mcp/*`: the roster authorization
 * matrix per route, the confirmation gates, the masked preview, and how a
 * removed catalog entry turns a stored selection into an inert orphan.
 *
 * The ledger and the catalog directory are real; only the probe is injected, so
 * a test can pin what a `test` call observed.
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readCatalog } from '../src/catalog.ts'
import { McpError } from '../src/errors.ts'
import { createMcpApi } from '../src/ipc.ts'
import { openLedger, readSelection } from '../src/selection.ts'
import type { McpServerManifest } from '../src/types.ts'

const roots: string[] = []

interface Fixture {
  api: ReturnType<typeof createMcpApi>
  readonly serversDir: string
  readonly ledgerPath: string
  readonly db: DatabaseSync
  readonly probed: McpServerManifest[]
  probeFailure?: McpError
}

function writeEntry(root: string, manifest: Record<string, unknown>): void {
  const dir = join(root, String(manifest.id))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mcp-crud-'))
  roots.push(root)
  const serversDir = join(root, 'servers')
  mkdirSync(serversDir, { recursive: true })
  writeEntry(serversDir, {
    id: 'alpha', name: 'Alpha', transport: 'stdio', command: 'npx', args: ['-y'],
    env: { GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN' }, LOG_LEVEL: 'debug' },
    headers: { 'X-Api-Key': { fromEnv: 'API_KEY' } },
  })
  const ledgerPath = join(root, 'ledger.db')
  const writer = new DatabaseSync(ledgerPath)
  writer.exec(`CREATE TABLE members (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL
  )`)
  const insert = writer.prepare('INSERT INTO members (project_id, session_id, role, state) VALUES (?, ?, ?, ?)')
  insert.run('p1', 's-sup', 'supervisor', 'active')
  insert.run('p1', 'w-worker', 'worker', 'active')
  insert.run('p1', 'gone', 'supervisor', 'departed')
  writer.close()
  const db = openLedger(ledgerPath)
  const state: Fixture = {
    api: undefined as never,
    serversDir,
    ledgerPath,
    db,
    probed: [],
  }
  const api = createMcpApi({
    db,
    ledgerPath,
    serversRoot: serversDir,
    scanCatalog: () => readCatalog(serversDir),
    probe: async (manifest) => {
      if (state.probeFailure !== undefined) throw state.probeFailure
      state.probed.push(manifest)
      return { tools: [`${manifest.id}__echo`], instructionBytes: 42 }
    },
  })
  state.api = api
  return state
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('preview', () => {
  it('masks every secret to its reference and never returns a literal', async () => {
    const { api, db } = fixture()
    try {
      const preview = await api.preview({ projectId: 'p1', actorSessionId: 'w-worker', serverId: 'alpha' })
      expect(preview.envKeys).toEqual([{ name: 'GITHUB_TOKEN', fromEnv: 'GITHUB_TOKEN' }, { name: 'LOG_LEVEL' }])
      expect(preview.headerKeys).toEqual([{ name: 'X-Api-Key', fromEnv: 'API_KEY' }])
      expect(preview).toMatchObject({ id: 'alpha', transport: 'stdio', command: 'npx', args: ['-y'] })
      expect(JSON.stringify(preview)).not.toContain('debug')
    } finally {
      db.close()
    }
  })

  it('localizes the description and serves an off-roster reader', async () => {
    const { api, serversDir, db } = fixture()
    writeEntry(serversDir, {
      id: 'beta', name: 'Beta', transport: 'stdio', command: 'npx',
      description: 'base', descriptionI18n: { zh: '中文', en: 'English' },
    })
    try {
      const zh = await api.preview({ projectId: 'p1', actorSessionId: 'outsider', serverId: 'beta', locale: 'zh-CN' })
      expect(zh.description).toBe('中文')
      const en = await api.preview({ projectId: 'p1', actorSessionId: 'outsider', serverId: 'beta' })
      expect(en.description).toBe('English')
    } finally {
      db.close()
    }
  })

  it('refuses an unknown id and a departed member', async () => {
    const { api, db } = fixture()
    try {
      expect(await codeOf(() => api.preview({ projectId: 'p1', actorSessionId: 'w-worker', serverId: 'nope' })))
        .toBe('MCP_SERVER_UNAVAILABLE')
      expect(await codeOf(() => api.preview({ projectId: 'p1', actorSessionId: 'gone', serverId: 'alpha' })))
        .toBe('MCP_FORBIDDEN')
    } finally {
      db.close()
    }
  })
})

describe('add', () => {
  const incoming = { id: 'gamma', name: 'Gamma', transport: 'stdio', command: 'npx' }

  it('creates as a supervisor and refuses every other caller', async () => {
    const { api, serversDir, db } = fixture()
    try {
      expect(await codeOf(() => api.add({ projectId: 'p1', actorSessionId: 'w-worker', manifest: incoming })))
        .toBe('MCP_FORBIDDEN')
      expect(await codeOf(() => api.add({ projectId: 'p1', actorSessionId: 'outsider', manifest: incoming })))
        .toBe('MCP_FORBIDDEN')
      expect(await codeOf(() => api.add({ projectId: 'p1', actorSessionId: 'gone', manifest: incoming })))
        .toBe('MCP_FORBIDDEN')
      const written = await api.add({ projectId: 'p1', actorSessionId: 's-sup', manifest: incoming })
      expect(written).toEqual({ id: 'gamma', created: true, overwritten: false })
      expect([...(await readCatalog(serversDir)).servers.keys()].sort()).toEqual(['alpha', 'gamma'])
    } finally {
      db.close()
    }
  })

  it('needs a confirmation only to overwrite an existing id', async () => {
    const { api, db } = fixture()
    try {
      await api.add({ projectId: 'p1', actorSessionId: 's-sup', manifest: incoming })
      expect(await codeOf(() => api.add({ projectId: 'p1', actorSessionId: 's-sup', manifest: incoming })))
        .toBe('MCP_NAME_CONFLICT')
      expect(await codeOf(() => api.add({
        projectId: 'p1', actorSessionId: 's-sup', manifest: incoming, overwrite: true,
      }))).toBe('MCP_CONFIRM_REQUIRED')
      const replaced = await api.add({
        projectId: 'p1', actorSessionId: 's-sup', manifest: incoming, overwrite: true, confirm: true,
      })
      expect(replaced.overwritten).toBe(true)
    } finally {
      db.close()
    }
  })

  it('rejects a plaintext secret and an out-of-whitelist field', async () => {
    const { api, db } = fixture()
    try {
      expect(await codeOf(() => api.add({
        projectId: 'p1', actorSessionId: 's-sup',
        manifest: { ...incoming, id: 'delta', env: { API_TOKEN: 'plain' } },
      }))).toBe('MCP_INVALID')
      expect(await codeOf(() => api.add({
        projectId: 'p1', actorSessionId: 's-sup', manifest: { ...incoming, id: 'delta', extra: 1 },
      }))).toBe('MCP_INVALID')
    } finally {
      db.close()
    }
  })
})

describe('edit', () => {
  it('requires a supervisor confirmation and merges the patch', async () => {
    const { api, serversDir, db } = fixture()
    try {
      expect(await codeOf(() => api.edit({
        projectId: 'p1', actorSessionId: 'w-worker', serverId: 'alpha', patch: {}, confirm: true,
      }))).toBe('MCP_FORBIDDEN')
      expect(await codeOf(() => api.edit({ projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', patch: {} })))
        .toBe('MCP_CONFIRM_REQUIRED')
      const edited = await api.edit({
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', patch: { description: 'patched' }, confirm: true,
      })
      expect(edited).toEqual({ id: 'alpha', updated: true })
      expect((await readCatalog(serversDir)).servers.get('alpha')).toMatchObject({
        description: 'patched', args: ['-y'], command: 'npx',
      })
    } finally {
      db.close()
    }
  })

  it('refuses an renamed id, an unknown id, and a departed caller', async () => {
    const { api, db } = fixture()
    try {
      expect(await codeOf(() => api.edit({
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', patch: { id: 'rename' }, confirm: true,
      }))).toBe('MCP_INVALID')
      expect(await codeOf(() => api.edit({
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'nope', patch: {}, confirm: true,
      }))).toBe('MCP_SERVER_UNAVAILABLE')
      expect(await codeOf(() => api.edit({
        projectId: 'p1', actorSessionId: 'gone', serverId: 'alpha', patch: {}, confirm: true,
      }))).toBe('MCP_FORBIDDEN')
    } finally {
      db.close()
    }
  })
})

describe('remove', () => {
  it('needs confirm:true, then makes the stored selection an inert orphan', async () => {
    const { api, serversDir, ledgerPath, db } = fixture()
    try {
      await api.set({
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'alpha', enabled: true }],
      })
      expect(await codeOf(() => api.remove({ projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha' })))
        .toBe('MCP_INVALID')
      expect(await codeOf(() => api.remove({
        projectId: 'p1', actorSessionId: 'w-worker', serverId: 'alpha', confirm: true,
      }))).toBe('MCP_FORBIDDEN')
      expect(await api.remove({ projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', confirm: true }))
        .toEqual({ removed: true })

      // The entry is gone from the catalog but the row survives as a lazy orphan.
      expect((await readCatalog(serversDir)).servers.has('alpha')).toBe(false)
      const reader = openLedger(ledgerPath)
      try {
        expect(readSelection(reader, 'w-worker').servers).toEqual([{ id: 'alpha', enabled: true }])
      } finally {
        reader.close()
      }
      // Reads project it away; writes refuse it until the caller refreshes.
      expect(await api.get({ projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker' }))
        .toEqual({ servers: [] })
      expect(await codeOf(() => api.set({
        projectId: 'p1', actorSessionId: 'w-worker', targetSessionId: 'w-worker',
        servers: [{ id: 'alpha', enabled: true }],
      }))).toBe('MCP_INVALID')
    } finally {
      db.close()
    }
  })

  it('refuses an unknown id and a departed caller', async () => {
    const { api, db } = fixture()
    try {
      expect(await codeOf(() => api.remove({
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'nope', confirm: true,
      }))).toBe('MCP_SERVER_UNAVAILABLE')
      expect(await codeOf(() => api.remove({
        projectId: 'p1', actorSessionId: 'gone', serverId: 'alpha', confirm: true,
      }))).toBe('MCP_FORBIDDEN')
    } finally {
      db.close()
    }
  })
})

describe('test', () => {
  it('probes as a confirmed supervisor and reports the discovered tools', async () => {
    const { api, db, probed } = fixture()
    try {
      expect(await codeOf(() => api.test({ projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha' })))
        .toBe('MCP_CONFIRM_REQUIRED')
      expect(await codeOf(() => api.test({
        projectId: 'p1', actorSessionId: 'w-worker', serverId: 'alpha', confirm: true,
      }))).toBe('MCP_FORBIDDEN')
      expect(await api.test({ projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', confirm: true }))
        .toEqual({ ok: true, tools: ['alpha__echo'], instructionBytes: 42 })
      expect(probed.map(manifest => manifest.id)).toEqual(['alpha'])
    } finally {
      db.close()
    }
  })

  it('surfaces the probe failure code and refuses an unknown server', async () => {
    const { api, db, probed } = fixture()
    try {
      expect(await codeOf(() => api.test({
        projectId: 'p1', actorSessionId: 's-sup', serverId: 'nope', confirm: true,
      }))).toBe('MCP_SERVER_UNAVAILABLE')
      expect(probed).toHaveLength(0)
      const failing = fixture()
      try {
        failing.probeFailure = new McpError('MCP_TIMEOUT', 504, '探测超时', '增大超时或检查服务器')
        expect(await codeOf(() => failing.api.test({
          projectId: 'p1', actorSessionId: 's-sup', serverId: 'alpha', confirm: true,
        }))).toBe('MCP_TIMEOUT')
      } finally {
        failing.db.close()
      }
    } finally {
      db.close()
    }
  })
})

/** One-key skill session binding: reuse-or-replace, persistence, and the HTTP route. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { SkillAdminApi, type AdminSessionPort } from '../src/admin.ts'

const roots: string[] = []
const ledgers = new Map<string, DatabaseSync>()
const routeDisposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of routeDisposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      // Disposal only releases the plugin's handles; a failure here must not hide the test result.
      console.error(`bind-session fixture: dispose failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const db of ledgers.values()) {
    try {
      db.close()
    } catch (error) {
      // A handle already closed by its test is fine; only the temp directory still needs removal.
      console.error(`bind-session fixture: ledger close skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  ledgers.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-bind-session-'))
  roots.push(root)
  mkdirSync(join(root, 'installed'), { recursive: true })
  return root
}

/** Roster with two supervising projects and one project that has only a worker. */
function ledger(root: string): DatabaseSync {
  const cached = ledgers.get(root)
  if (cached !== undefined) return cached
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
    VALUES ('p1', 's1', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p2', 's2', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p3', 'w3', 'worker', 'available', '[]', 'now', 'now')`).run()
  ledgers.set(root, db)
  return db
}

interface Sessions {
  readonly port: AdminSessionPort
  readonly created: { readonly sessionId: string; readonly title: string }[]
  readonly deleted: string[]
  /** Failure injected into the next delete; cleared by the test that sets it. */
  readonly deleteFailure: { error?: Error }
  /** Failure injected into the next session listing; cleared by the test that sets it. */
  readonly listFailure: { error?: Error }
}

/** Session store whose create/delete/list calls stay observable to the assertions. */
function sessions(deleteSupported = true, prefix = 'admin'): Sessions {
  const created: { sessionId: string; title: string }[] = []
  const deleted: string[] = []
  const deleteFailure: { error?: Error } = {}
  const listFailure: { error?: Error } = {}
  const port: AdminSessionPort = {
    create: async input => {
      const sessionId = `${prefix}-${String(created.length + 1)}`
      created.push({ sessionId, title: input.title })
      return { sessionId }
    },
    list: async () => {
      if (listFailure.error !== undefined) throw listFailure.error
      return created.map(item => ({ sessionId: item.sessionId, title: item.title, updatedAt: 1 }))
    },
    ...(deleteSupported
      ? {
        delete: async input => {
          if (deleteFailure.error !== undefined) throw deleteFailure.error
          deleted.push(input.sessionId)
        },
      }
      : {}),
  }
  return { port, created, deleted, deleteFailure, listFailure }
}

function apiAt(root: string, store: Sessions, extra: Record<string, unknown> = {}): SkillAdminApi {
  return new SkillAdminApi({
    db: ledger(root),
    ledgerPath: join(root, 'ledger.sqlite'),
    skillsDir: join(root, 'installed'),
    sessions: store.port,
    workspace: { create: async (path: string) => ({ id: `ws-${path}`, path, attachSession: async () => {} }) },
    auditDir: join(root, 'audit'),
    ...extra,
  })
}

function skillSessions(root: string): Record<string, Record<string, { sessionId: string; updatedAt: string }>> {
  return JSON.parse(readFileSync(join(root, 'audit', 'skill-sessions.json'), 'utf8')) as
    Record<string, Record<string, { sessionId: string; updatedAt: string }>>
}

function sessionBindings(root: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, 'audit', 'sessions.json'), 'utf8')) as Record<string, string>
}

describe('bindSession', () => {
  it('creates the first session for a key and persists project→skill→session', async () => {
    const root = workspace()
    const store = sessions()
    const admin = apiAt(root, store)

    const bound = await admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '安装技能：pack-a' })

    expect(bound).toEqual({ sessionId: 'admin-1', title: '安装技能：pack-a', projectId: 'p1' })
    expect(store.created).toEqual([{ sessionId: 'admin-1', title: '安装技能：pack-a' }])
    expect(store.deleted).toEqual([])
    expect(skillSessions(root)).toEqual({
      p1: { 'pack-a': { sessionId: 'admin-1', updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) } },
    })
    // The ordinary admin-session binding is written too, so the new session resolves its project.
    expect(sessionBindings(root)).toEqual({ 'admin-1': 'p1' })
  })

  it('reuses the session bound before instead of replacing it', async () => {
    const root = workspace()
    const store = sessions()
    const first = await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    expect(first.sessionId).toBe('admin-1')
    const before = skillSessions(root)

    // A later instance reads the persisted binding, proves the session still exists, and reuses it.
    const rebound = await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' })

    expect(rebound).toEqual({ sessionId: 'admin-1', title: '技能 pack-a', projectId: 'p1' })
    expect(store.created).toHaveLength(1)
    expect(store.deleted).toEqual([])
    // Reuse touches no binding file: the session and its timestamp stay the ones already persisted.
    expect(skillSessions(root)).toEqual(before)
    expect(sessionBindings(root)).toEqual({ 'admin-1': 'p1' })
  })

  it('aborts without creating when the Host cannot list sessions, and keeps the bound session', async () => {
    const root = workspace()
    const store = sessions()
    await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    store.listFailure.error = new Error('会话列表不可用')

    const failure = await apiAt(root, store)
      .bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' })
      .then(() => Promise.reject(new Error('bindSession unexpectedly resolved')), (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'SKILL_BIND_LOOKUP_FAILED', status: 503 })
    expect(String((failure as Error).message)).toMatch(/会话列表不可用/u)
    // The remediation travels in the message, so HTTP and locale surfaces both see it.
    expect(String((failure as Error).message)).toMatch(/处理方式：/u)
    expect(store.created).toHaveLength(1)
    // A failed liveness check never deletes or forgets the working binding.
    expect(store.deleted).toEqual([])
    expect(skillSessions(root)).toEqual({ p1: { 'pack-a': { sessionId: 'admin-1', updatedAt: expect.any(String) } } })
    expect(sessionBindings(root)).toEqual({ 'admin-1': 'p1' })
  })

  it('reuses a live binding on a Host that cannot delete, and still binds an unbound key', async () => {
    const root = workspace()
    const store = sessions(false)
    const admin = apiAt(root, store)

    const first = await admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    expect(first.sessionId).toBe('admin-1')

    // A live binding needs no deletion, so a Host without deletion still answers the repeated bind.
    const reused = await admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' })
    expect(reused.sessionId).toBe('admin-1')
    expect(store.created).toHaveLength(1)

    // A key with no binding needs no listing either, so an undeletable Host still binds it.
    const other = await admin.bindSession({ projectId: 'p1', skillId: 'pack-b', skillName: '技能 pack-b' })
    expect(other.sessionId).toBe('admin-2')
    expect(store.created).toHaveLength(2)
  })

  it('reports one binding failure instead of the create pipeline codes', async () => {
    const root = workspace()
    const store = sessions()
    const admin = apiAt(root, store, {})
    // Breaking the workspace registry is the cheapest create-pipeline failure to induce.
    const broken = new SkillAdminApi({
      db: ledger(root),
      ledgerPath: join(root, 'ledger.sqlite'),
      skillsDir: join(root, 'installed'),
      sessions: store.port,
      auditDir: join(root, 'audit'),
    })

    await expect(broken.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' }))
      .rejects.toMatchObject({ code: 'SKILL_BIND_SESSION_FAILED', status: 500 })
    expect(store.created).toEqual([])
    expect(existsSync(join(root, 'audit', 'skill-sessions.json'))).toBe(false)
    // The unused instance keeps the fixture honest: the same inputs succeed when the registry exists.
    expect((await admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })).sessionId)
      .toBe('admin-1')
  })

  it('accepts an opaque key without checking the catalog or a directory', async () => {
    const root = workspace()
    const store = sessions()
    const admin = apiAt(root, store)

    // The installed directory stays empty: neither key exists as a pack or a folder.
    expect(readdirSync(join(root, 'installed'))).toEqual([])
    const install = await admin.bindSession({ projectId: 'p1', skillId: '__install__', skillName: '安装技能' })
    const unknown = await admin.bindSession({ projectId: 'p1', skillId: 'not-an-installed-pack', skillName: '未知技能' })
    expect(install.sessionId).toBe('admin-1')
    expect(unknown.sessionId).toBe('admin-2')
    expect(Object.keys(skillSessions(root).p1 ?? {}).sort()).toEqual(['__install__', 'not-an-installed-pack'])
  })

  it('keeps the reserved install key separate per project', async () => {
    const root = workspace()
    const store = sessions()
    const admin = apiAt(root, store)

    const first = await admin.bindSession({ projectId: 'p1', skillId: '__install__', skillName: '安装技能' })
    const second = await admin.bindSession({ projectId: 'p2', skillId: '__install__', skillName: '安装技能' })
    expect([first.sessionId, second.sessionId]).toEqual(['admin-1', 'admin-2'])

    // Rebinding p1 reuses p1's install conversation; p2 keeps its own.
    const rebound = await admin.bindSession({ projectId: 'p1', skillId: '__install__', skillName: '安装技能' })
    expect(store.deleted).toEqual([])
    expect(store.created.map(item => item.sessionId)).toEqual(['admin-1', 'admin-2'])
    expect(rebound.sessionId).toBe('admin-1')
    expect(skillSessions(root)).toEqual({
      p1: { __install__: { sessionId: 'admin-1', updatedAt: expect.any(String) } },
      p2: { __install__: { sessionId: 'admin-2', updatedAt: expect.any(String) } },
    })
  })

  it('creates a replacement only when the bound session is stale', async () => {
    const root = workspace()
    // The earlier Host run created its own session id that the later run cannot list.
    const oldRun = sessions(true, 'old')
    await apiAt(root, oldRun).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })

    const newRun = sessions(true, 'new')
    const rebound = await apiAt(root, newRun).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })

    expect(rebound.sessionId).toBe('new-1')
    expect(newRun.created).toEqual([{ sessionId: 'new-1', title: '技能 pack-a' }])
    expect(newRun.deleted).toEqual([])
    // A session the Host no longer lists needs no deletion; the stale binding is replaced instead.
    expect(oldRun.deleted).toEqual([])
    expect(skillSessions(root)).toEqual({ p1: { 'pack-a': { sessionId: 'new-1', updatedAt: expect.any(String) } } })
    expect(sessionBindings(root)).toEqual({ 'new-1': 'p1' })
  })

  it('resolves the operator from the roster and refuses projects without a supervisor', async () => {
    const root = workspace()
    const store = sessions()
    const admin = apiAt(root, store)

    await expect(admin.bindSession({ projectId: 'p3', skillId: 'pack-a', skillName: '技能 pack-a' }))
      .rejects.toMatchObject({ code: 'SKILL_FORBIDDEN', status: 403 })
    await expect(admin.bindSession({ projectId: 'p9', skillId: 'pack-a', skillName: '技能 pack-a' }))
      .rejects.toMatchObject({ code: 'SKILL_FORBIDDEN', status: 403, message: expect.stringMatching(/未知项目/u) })
    expect(store.created).toEqual([])
  })
})

type RouteHandler = (req: Readable & { method?: string; url?: string }, res: FakeResponse) => void | Promise<void>
interface FakeResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

interface Harness {
  readonly created: string[]
  readonly deleted: string[]
  readonly deleteFailure: { error?: Error }
  call(path: string, payload: Record<string, unknown> | undefined, method?: string): Promise<{ status: number; body: unknown }>
}

/** Boot the HTTP layer with fake Host services and capture the reply of one request. */
function host(root: string, deleteSupported = true): Harness {
  const routes = new Map<string, RouteHandler>()
  // The plugin opens the ledger read-only, so the roster has to exist before apply runs.
  ledger(root)
  const created: string[] = []
  const deleted: string[] = []
  const deleteFailure: { error?: Error } = {}
  const scope = {
    webServer: {
      register(route: { kind: 'exact'; path: string; handler: RouteHandler }): () => void {
        routes.set(route.path, route.handler)
        return () => undefined
      },
    },
    connection: { admit: () => ({ admitted: true }) },
    effect(setup: () => () => void): () => void { return setup() },
  }
  const archive = async (sessionId: string): Promise<void> => {
    if (deleteFailure.error !== undefined) throw deleteFailure.error
    deleted.push(sessionId)
  }
  const services: Record<string, unknown> = {
    sessionController: {
      create: async (request: { readonly cwd: string }) => {
        const sessionId = `admin-${String(created.length + 1)}`
        created.push(sessionId)
        return { sessionId, cwd: request.cwd }
      },
      // The listing carries the admin preset projection, so a reused binding looks live here.
      list: async () => ({
        items: created.map(sessionId => ({
          sessionId,
          updatedAt: 1,
          projections: { values: { agentPreset: 'cadre-skill-admin' } },
        })),
      }),
    },
    workspaceRegistry: {
      create: async (path: string, title?: string) => ({
        id: `ws-${path}`, path, title, attachSession: async () => undefined,
      }),
      ...(deleteSupported ? { archiveSession: archive } : {}),
    },
  }
  apply({
    on: () => () => undefined,
    // The plugin closes its read-only ledger handle in this disposer; the temp directory needs it.
    effect(setup: () => () => void) { routeDisposers.push(setup()) },
    inject(_dependencies: readonly string[], callback: (scope: unknown) => void) { callback(scope) },
    get(name: string) { return services[name] },
    provide() {},
  }, {
    ledgerPath: join(root, 'ledger.sqlite'),
    skillsDir: join(root, 'installed'),
    skillAdminAuditDir: join(root, 'audit'),
  })
  return {
    created,
    deleted,
    deleteFailure,
    call: async (path, payload, method = 'POST') => {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`route not registered: ${path}`)
      let status = 0
      const chunks: string[] = []
      const response: FakeResponse = {
        writeHead: code => { status = code },
        end: body => { if (body !== undefined) chunks.push(body) },
      }
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload ?? {}))]), { method, url: path })
      await handler(request, response)
      return { status, body: chunks.join('') === '' ? undefined : JSON.parse(chunks.join('')) as unknown }
    },
  }
}

describe('POST /cadre/skills/admin/bind-session', () => {
  it('replies with the ordinary admin envelope and exactly the three result fields', async () => {
    const root = workspace()
    const host0 = host(root)
    const response = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: '__install__', skillName: '安装技能',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      result: { sessionId: 'admin-1', title: '安装技能', projectId: 'p1' },
    })
    expect(Object.keys((response.body as { result: Record<string, unknown> }).result).sort())
      .toEqual(['projectId', 'sessionId', 'title'])
    expect(skillSessions(root)).toEqual({ p1: { __install__: { sessionId: 'admin-1', updatedAt: expect.any(String) } } })
  })

  it('answers 400 when a required field is missing', async () => {
    const root = workspace()
    const host0 = host(root)
    const response = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: '__install__',
    })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ ok: false, code: 'SKILL_INVALID' })
    expect(JSON.stringify(response.body)).toMatch(/skillName/u)
    expect(host0.created).toEqual([])
  })

  it('answers 403 for a project with no supervising member', async () => {
    const root = workspace()
    const host0 = host(root)
    const response = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p3', skillId: 'pack-a', skillName: '技能 pack-a',
    })
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ ok: false, code: 'SKILL_FORBIDDEN' })
    expect(host0.created).toEqual([])
  })

  it('reuses the bound session instead of archiving it, even when archiving would fail', async () => {
    const root = workspace()
    const host0 = host(root)
    const first = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a',
    })
    expect(first.status).toBe(200)
    host0.deleteFailure.error = new Error('归档失败')

    const response = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）',
    })
    expect(response.status).toBe(200)
    // The listed session's title replaces the requested one, so the reply describes the live session.
    expect(response.body).toMatchObject({
      ok: true, result: { sessionId: 'admin-1', title: '技能管理员', projectId: 'p1' },
    })
    expect(host0.created).toHaveLength(1)
    expect(host0.deleted).toEqual([])
  })

  it('reuses a live binding on a Host that cannot delete, and binds an unbound key', async () => {
    const root = workspace()
    const host0 = host(root, false)
    const first = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a',
    })
    expect(first.status).toBe(200)

    const reused = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）',
    })
    expect(reused.status).toBe(200)
    expect(reused.body).toMatchObject({ ok: true, result: { sessionId: 'admin-1', projectId: 'p1' } })
    expect(host0.created).toHaveLength(1)

    // A key with no binding needs no listing, so an undeletable Host still binds it.
    const other = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-b', skillName: '技能 pack-b',
    })
    expect(other.status).toBe(200)
    expect(other.body).toMatchObject({ ok: true, result: { sessionId: 'admin-2', projectId: 'p1' } })
    expect(host0.created).toHaveLength(2)
  })

  it('answers 405 for a method other than POST', async () => {
    const root = workspace()
    const host0 = host(root)
    const response = await host0.call('/cadre/skills/admin/bind-session', undefined, 'GET')
    expect(response.status).toBe(405)
    expect(response.body).toMatchObject({ ok: false, code: 'METHOD_NOT_ALLOWED' })
  })
})

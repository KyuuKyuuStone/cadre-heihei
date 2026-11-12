/** One-key skill session binding: delete-old-then-create, persistence, and the HTTP route. */
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
}

/** Session store whose create/delete calls stay observable to the assertions. */
function sessions(deleteSupported = true): Sessions {
  const created: { sessionId: string; title: string }[] = []
  const deleted: string[] = []
  const deleteFailure: { error?: Error } = {}
  const port: AdminSessionPort = {
    create: async input => {
      const sessionId = `admin-${String(created.length + 1)}`
      created.push({ sessionId, title: input.title })
      return { sessionId }
    },
    list: async () => created.map(item => ({ sessionId: item.sessionId, title: item.title, updatedAt: 1 })),
    ...(deleteSupported
      ? {
        delete: async input => {
          if (deleteFailure.error !== undefined) throw deleteFailure.error
          deleted.push(input.sessionId)
        },
      }
      : {}),
  }
  return { port, created, deleted, deleteFailure }
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

  it('deletes the session bound before and only then creates the replacement', async () => {
    const root = workspace()
    const store = sessions()
    const first = await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    expect(first.sessionId).toBe('admin-1')

    const rebound = await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' })

    expect(store.deleted).toEqual(['admin-1'])
    expect(rebound.sessionId).toBe('admin-2')
    expect(rebound.title).toBe('技能 pack-a（新）')
    expect(skillSessions(root)).toEqual({
      p1: { 'pack-a': { sessionId: 'admin-2', updatedAt: expect.any(String) } },
    })
    // The replaced session's project binding is gone; only the live session keeps one.
    expect(sessionBindings(root)).toEqual({ 'admin-2': 'p1' })
  })

  it('aborts before creating when deleting the old session fails, and keeps the old binding', async () => {
    const root = workspace()
    const store = sessions()
    await apiAt(root, store).bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    store.deleteFailure.error = new Error('会话控制器忙')

    const failure = await apiAt(root, store)
      .bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' })
      .then(() => Promise.reject(new Error('bindSession unexpectedly resolved')), (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'SKILL_BIND_DELETE_FAILED', status: 502 })
    expect(String((failure as Error).message)).toMatch(/会话控制器忙/u)
    // The remediation travels in the message, so HTTP and locale surfaces both see it.
    expect(String((failure as Error).message)).toMatch(/处理方式：/u)
    expect(store.created).toHaveLength(1)
    expect(store.deleted).toEqual([])
    // A failed replacement never forgets the working binding.
    expect(skillSessions(root)).toEqual({ p1: { 'pack-a': { sessionId: 'admin-1', updatedAt: expect.any(String) } } })
    expect(sessionBindings(root)).toEqual({ 'admin-1': 'p1' })
  })

  it('refuses a replacement while the Host cannot delete, but still binds an unbound key', async () => {
    const root = workspace()
    const store = sessions(false)
    const admin = apiAt(root, store)

    const first = await admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a' })
    expect(first.sessionId).toBe('admin-1')

    await expect(admin.bindSession({ projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）' }))
      .rejects.toMatchObject({ code: 'SKILL_ADMIN_DELETE_UNSUPPORTED', status: 501 })
    expect(store.created).toHaveLength(1)

    // A key with no old binding needs no deletion, so an undeletable Host still binds it.
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

    // Rebinding p1 must delete only p1's session; p2 keeps its own install conversation.
    const rebound = await admin.bindSession({ projectId: 'p1', skillId: '__install__', skillName: '安装技能' })
    expect(store.deleted).toEqual(['admin-1'])
    expect(store.created.map(item => item.sessionId)).toEqual(['admin-1', 'admin-2', 'admin-3'])
    expect(rebound.sessionId).toBe('admin-3')
    expect(skillSessions(root)).toEqual({
      p1: { __install__: { sessionId: 'admin-3', updatedAt: expect.any(String) } },
      p2: { __install__: { sessionId: 'admin-2', updatedAt: expect.any(String) } },
    })
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
      list: async () => ({ items: [] }),
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

  it('answers 502 and creates nothing when the old session cannot be deleted', async () => {
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
    expect(response.status).toBe(502)
    expect(response.body).toMatchObject({ ok: false, code: 'SKILL_BIND_DELETE_FAILED' })
    // The route forwards code and message; the message carries the remediation sentence.
    expect(JSON.stringify(response.body)).toMatch(/处理方式：/u)
    expect(host0.created).toHaveLength(1)
    expect(host0.deleted).toEqual([])
  })

  it('answers 501 for a replacement when the Host cannot delete, and binds an unbound key', async () => {
    const root = workspace()
    const host0 = host(root, false)
    const first = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a',
    })
    expect(first.status).toBe(200)

    const blocked = await host0.call('/cadre/skills/admin/bind-session', {
      projectId: 'p1', skillId: 'pack-a', skillName: '技能 pack-a（新）',
    })
    expect(blocked.status).toBe(501)
    expect(blocked.body).toMatchObject({ ok: false, code: 'SKILL_ADMIN_DELETE_UNSUPPORTED' })
    expect(host0.created).toHaveLength(1)
  })

  it('answers 405 for a method other than POST', async () => {
    const root = workspace()
    const host0 = host(root)
    const response = await host0.call('/cadre/skills/admin/bind-session', undefined, 'GET')
    expect(response.status).toBe(405)
    expect(response.body).toMatchObject({ ok: false, code: 'METHOD_NOT_ALLOWED' })
  })
})

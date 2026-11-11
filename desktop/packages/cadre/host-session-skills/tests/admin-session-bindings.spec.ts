import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillAdminApi, SkillAdminRecoveryError, type AdminSessionPort } from '../src/admin.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-admin-bindings-'))
  roots.push(root)
  return root
}

/** Roster shared by every Host instance in one test, standing in for the plugin's read-only ledger. */
function ledger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
    VALUES ('p1', 's1', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p1', 'w1', 'worker', 'available', '[]', 'now', 'now')`).run()
  return db
}

/**
 * Production ledger shape for a project that never received a roster row: the project
 * exists, the roster is empty, and `p3` is a second project used to make recovery ambiguous.
 */
function projectLedger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, archived_at TEXT);
  CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.exec(`INSERT INTO projects (project_id, name, root_path, created_at)
    VALUES ('p9', '无花名册项目', '/tmp/p9', 'now')`)
  return db
}

/** Session controller shared by restarts; only its own store survives a Host restart. */
function sessionPort(): AdminSessionPort & { readonly store: string[] } {
  const store: string[] = []
  return {
    store,
    create: async () => {
      const sessionId = `admin-${String(store.length + 1)}`
      store.push(sessionId)
      return { sessionId }
    },
    list: async () => store.map(sessionId => ({ sessionId, title: '技能管理员', updatedAt: 1 })),
    delete: async ({ sessionId }) => {
      const index = store.indexOf(sessionId)
      if (index >= 0) store.splice(index, 1)
    },
  }
}

/** A project id shaped like the real ledger's, kept as one constant for the fixtures below. */
const REAL_PROJECT = '253e8634-3a36-4c08-97d2-241ca0a8e7be'

/**
 * Real-ledger shape: the schema created `projects` and no writer filled it, so the roster is
 * the only evidence that the project exists.
 */
function rosterOnlyLedger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, archived_at TEXT);
  CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
    VALUES (?, 's1', 'supervisor', 'available', '[]', 'now', 'now'),
           (?, 'w1', 'worker', 'available', '[]', 'now', 'now')`).run(REAL_PROJECT, REAL_PROJECT)
  return db
}

const workspacePort = {
  create: async (path: string) => ({ id: `ws-${path}`, path, attachSession: async () => {} }),
}

function optionsFor(root: string, db: DatabaseSync, port: AdminSessionPort, extra: Record<string, unknown> = {}) {
  const skillsDir = join(root, 'installed')
  mkdirSync(skillsDir, { recursive: true })
  return {
    db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir, sessions: port,
    auditDir: join(root, 'audit'), workspace: workspacePort, ...extra,
  }
}

/** GitHub raw manifest whose metadata decides whether an install carries warnings. */
function remoteFetch(license: string, author?: string): typeof globalThis.fetch {
  return vi.fn(async (input: URL | string) => String(input).endsWith('manifest.json')
    ? new Response(JSON.stringify({
      id: 'remote-pack', name: 'Remote Pack', description: 'remote', roles: ['worker'],
      tokenEstimate: 3, tools: [], source: 'github:o/r', license,
      ...(author === undefined ? {} : { author }),
    }), { status: 200 })
    : new Response('# remote-pack', { status: 200 })) as unknown as typeof globalThis.fetch
}

describe('skill admin session bindings across restarts', () => {
  it('resolves catalog, project, and session listings from a new Host instance', async () => {
    const root = workspace()
    const db = ledger(root)
    const port = sessionPort()
    const options = optionsFor(root, db, port)

    const first = new SkillAdminApi(options)
    const created = await first.createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    expect(await first.catalogFor(created.sessionId)).toBeDefined()

    // A Host restart keeps the roster and the session store but loses every in-memory binding.
    const second = new SkillAdminApi(options)
    expect(await second.catalogFor(created.sessionId)).toBeDefined()
    expect(await second.tokenForSession(created.sessionId, 'unknown-plan')).toBeUndefined()
    expect((await second.listSessions({ projectId: 'p1' })).map(session => session.sessionId))
      .toEqual([created.sessionId])
    expect(await second.listSessions({ projectId: 'p2' })).toEqual([])
    // Sessions belonging to another project never resolve through a restarted instance either.
    await expect(second.catalogFor('someone-else')).rejects.toThrowError(/未知的技能管理员会话/u)
    db.close()
  })

  it('persists deletion so a later Host instance no longer resolves the session', async () => {
    const root = workspace()
    const db = ledger(root)
    const port = sessionPort()
    const options = optionsFor(root, db, port)

    const first = new SkillAdminApi(options)
    const created = await first.createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    await first.deleteSession({ projectId: 'p1', sessionId: created.sessionId })

    const second = new SkillAdminApi(options)
    expect(await second.listSessions({ projectId: 'p1' })).toEqual([])
    await expect(second.catalogFor(created.sessionId)).rejects.toThrowError(/未知的技能管理员会话/u)
    await expect(second.deleteSession({ projectId: 'p1', sessionId: created.sessionId }))
      .rejects.toThrowError(/未知的技能管理员会话/u)
    db.close()
  })

  it('rebinds a live admin session whose binding file is gone, and keeps the written binding', async () => {
    const root = workspace()
    const db = ledger(root)
    const port = sessionPort()
    const options = optionsFor(root, db, port)

    const created = await new SkillAdminApi(options).createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    // Losing the bindings file is exactly the dead end this recovery covers: the Host still
    // lists the admin session, but no instance remembers which project it administers.
    rmSync(join(root, 'audit', 'sessions.json'), { force: true })

    const restarted = new SkillAdminApi(options)
    expect(await restarted.catalogFor(created.sessionId)).toEqual(expect.any(Array))

    // A second project makes inference ambiguous, so only the recovered binding can answer.
    db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
      VALUES ('p2', 'w2', 'worker', 'available', '[]', 'now', 'now')`).run()
    const third = new SkillAdminApi(options)
    expect(await third.catalogFor(created.sessionId)).toBeDefined()
    db.close()
  })

  it('reports a recoverable failure when a binding cannot be inferred', async () => {
    const root = workspace()
    const db = ledger(root)
    const port = sessionPort()
    // Two projects exist and the session was never bound, so no project is provable.
    db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
      VALUES ('p2', 'w2', 'worker', 'available', '[]', 'now', 'now')`).run()
    const options = optionsFor(root, db, port)
    await new SkillAdminApi(options).createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    rmSync(join(root, 'audit', 'sessions.json'), { force: true })
    port.store.push('unbound-admin')

    const failure = await new SkillAdminApi(options).catalogFor('unbound-admin').then(
      () => Promise.reject(new Error('catalogFor unexpectedly resolved')),
      (error: SkillAdminRecoveryError) => error,
    )
    expect(failure).toBeInstanceOf(SkillAdminRecoveryError)
    expect(failure).toMatchObject({ code: 'SKILL_ADMIN_SESSION_NOT_FOUND', status: 404 })
    expect(failure.remediation).toMatch(/技能管理员会话/u)
    expect(failure.message).toMatch(/未知的技能管理员会话/u)
    // The remediation travels in the message so HTTP and tool callers both see it.
    expect(failure.message).toMatch(/处理方式：/u)
    // A session the Host never created is not an admin session, so recovery refuses it too.
    await expect(new SkillAdminApi(options).previewFor('not-an-admin-session', 'anything'))
      .rejects.toThrowError(/未知的技能管理员会话/u)
    db.close()
  })

  it('serves a project with no roster row, including a clean install', async () => {
    const root = workspace()
    const db = projectLedger(root)
    const port = sessionPort()
    const options = optionsFor(root, db, port, { fetch: remoteFetch('MIT', 'Remote Author') })

    const admin = new SkillAdminApi(options)
    const created = await admin.createSession({ projectId: 'p9', cwd: join(root, 'cwd') })
    expect(await admin.catalogFor(created.sessionId)).toEqual([])

    const installed = await admin.installForSession(created.sessionId, {
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote/SKILL.md',
    })
    expect(installed).toMatchObject({ kind: 'url', installed: true, warnings: [] })
    // The audit names the admin session as the operator because the roster has no supervisor.
    expect((await admin.auditForSession(created.sessionId))[0])
      .toMatchObject({ kind: 'tool-install', result: 'installed' })
    const preview = await admin.previewFor(created.sessionId, 'remote-pack')
    expect(preview).toMatchObject({ id: 'remote-pack', content: '# remote-pack' })

    // Warning-bearing installs still ask for a supervisor: the IPC confirmation gate owns
    // that decision, so an unrostered project cannot bypass it from the admin layer.
    const warned = new SkillAdminApi(optionsFor(root, db, port, { fetch: remoteFetch('unknown') }))
    await expect(warned.installForSession(created.sessionId, {
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote/SKILL.md', confirm: true,
    })).rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    db.close()
  })

  it('serves a project the roster carries while the projects table stays empty', async () => {
    const root = workspace()
    const db = rosterOnlyLedger(root)
    const port = sessionPort()
    const options = optionsFor(root, db, port)
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toMatchObject({ count: 0 })

    const admin = new SkillAdminApi(options)
    const created = await admin.createSession({ projectId: REAL_PROJECT, cwd: join(root, 'cwd') })
    expect(await admin.catalogFor(created.sessionId)).toEqual(expect.any(Array))
    expect(await admin.auditForSession(created.sessionId)).toEqual([])
    // Roster-only evidence does not admit an id the ledger never mentioned.
    await expect(admin.createSession({ projectId: 'p9', cwd: join(root, 'cwd-2') }))
      .rejects.toMatchObject({ code: 'SKILL_FORBIDDEN', message: expect.stringMatching(/未知项目/u) })
    db.close()
  })
})

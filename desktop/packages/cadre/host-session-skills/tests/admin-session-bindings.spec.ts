import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillAdminApi, type AdminSessionPort } from '../src/admin.ts'

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

describe('skill admin session bindings across restarts', () => {
  it('resolves catalog, project, and session listings from a new Host instance', async () => {
    const root = workspace()
    const db = ledger(root)
    const skillsDir = join(root, 'installed')
    mkdirSync(skillsDir, { recursive: true })
    const auditDir = join(root, 'audit')
    const port = sessionPort()
    const options = { db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir, sessions: port, auditDir }
    const workspacePort = {
      create: async (path: string) => ({ id: `ws-${path}`, path, attachSession: async () => {} }),
    }

    const first = new SkillAdminApi({ ...options, workspace: workspacePort })
    const created = await first.createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    expect(first.catalogFor(created.sessionId)).toBeDefined()

    // A Host restart keeps the roster and the session store but loses every in-memory binding.
    const second = new SkillAdminApi({ ...options, workspace: workspacePort })
    expect(second.catalogFor(created.sessionId)).toBeDefined()
    expect(second.tokenForSession(created.sessionId, 'unknown-plan')).toBeUndefined()
    expect((await second.listSessions({ projectId: 'p1' })).map(session => session.sessionId))
      .toEqual([created.sessionId])
    expect(await second.listSessions({ projectId: 'p2' })).toEqual([])
    // Sessions belonging to another project never resolve through a restarted instance either.
    expect(() => second.catalogFor('someone-else')).toThrowError(/未知的技能管理员会话/u)
    db.close()
  })

  it('persists deletion so a later Host instance no longer resolves the session', async () => {
    const root = workspace()
    const db = ledger(root)
    const skillsDir = join(root, 'installed')
    mkdirSync(skillsDir, { recursive: true })
    const auditDir = join(root, 'audit')
    const port = sessionPort()
    const options = { db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir, sessions: port, auditDir }
    const workspacePort = {
      create: async (path: string) => ({ id: `ws-${path}`, path, attachSession: async () => {} }),
    }

    const first = new SkillAdminApi({ ...options, workspace: workspacePort })
    const created = await first.createSession({ projectId: 'p1', cwd: join(root, 'cwd') })
    await first.deleteSession({ projectId: 'p1', sessionId: created.sessionId })

    const second = new SkillAdminApi({ ...options, workspace: workspacePort })
    expect(await second.listSessions({ projectId: 'p1' })).toEqual([])
    expect(() => second.catalogFor(created.sessionId)).toThrowError(/未知的技能管理员会话/u)
    await expect(second.deleteSession({ projectId: 'p1', sessionId: created.sessionId }))
      .rejects.toThrowError(/未知的技能管理员会话/u)
    db.close()
  })
})

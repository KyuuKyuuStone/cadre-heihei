import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkillApi } from '../src/ipc.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-skill-scope-'))
  roots.push(root)
  return root
}

function pack(root: string, id: string, roles: string[] = ['worker']): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, description: `${id} description`, roles, tokenEstimate: 12, tools: ['read'],
    source: 'internal', license: 'MIT',
  }))
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}`)
}

/**
 * Ledger with the production roster tables. `p1` holds a supervisor, a worker,
 * and a departed member; `p2` holds a worker used for cross-project attempts.
 */
function ledger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, archived_at TEXT);
  CREATE TABLE members (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    display_name TEXT, description TEXT, state TEXT NOT NULL,
    skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.exec(`INSERT INTO projects (project_id, name, root_path, created_at)
    VALUES ('p1', '一号项目', '/tmp/p1', 'now'), ('p2', '二号项目', '/tmp/p2', 'now')`)
  const insert = db.prepare(`INSERT INTO members
    (project_id, session_id, role, display_name, description, state, skills_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, '[]', 'now', 'now')`)
  insert.run('p1', 's1', 'supervisor', 'available')
  insert.run('p1', 'w1', 'worker', 'available')
  insert.run('p1', 'd1', 'worker', 'departed')
  insert.run('p2', 'x1', 'worker', 'available')
  return db
}

function remoteFetch(license: string): typeof globalThis.fetch {
  return vi.fn(async (input: URL | string) => String(input).endsWith('manifest.json')
    ? new Response(JSON.stringify({
      id: 'remote-pack', name: 'Remote Pack', description: 'remote', roles: ['worker'],
      tokenEstimate: 3, tools: [], source: 'github:o/r', license, author: 'Remote Author',
    }), { status: 200 })
    : new Response('# remote-pack', { status: 200 })) as unknown as typeof globalThis.fetch
}

function addInput(projectId: string, actorSessionId: string, id: string) {
  return {
    projectId, actorSessionId, id, name: id, description: id, roles: ['worker'],
    tokenEstimate: 1, tools: [], source: 'manual', license: 'MIT', content: `# ${id}`,
  }
}

describe('skill API project scope', () => {
  it('admits an off-roster session to catalog, selection echo, add, and remove', () => {
    const root = workspace()
    const packs = join(root, 'installed')
    pack(packs, 'design')
    const db = ledger(root)
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })

    expect(api.catalog({ projectId: 'p1', actorSessionId: 'guest' }))
      .toEqual([expect.objectContaining({ id: 'design', selected: false })])
    expect(api.get({ projectId: 'p1', actorSessionId: 'guest', targetSessionId: 'guest' }))
      .toEqual({ skills: [] })
    expect(api.set({ projectId: 'p1', actorSessionId: 'guest', targetSessionId: 'guest', skills: ['design'] }))
      .toEqual({ skills: ['design'] })
    // An off-roster session has no members row, so the echoed selection is not stored.
    expect(api.get({ projectId: 'p1', actorSessionId: 'guest', targetSessionId: 'guest' }))
      .toEqual({ skills: [] })
    expect(db.prepare("SELECT COUNT(*) AS count FROM members WHERE session_id = 'guest'").get())
      .toMatchObject({ count: 0 })
    expect(() => { api.assertMember({ projectId: 'p1', actorSessionId: 'guest' }) }).not.toThrow()
    expect(api.add(addInput('p1', 'guest', 'guest-pack'))).toMatchObject({ id: 'guest-pack' })
    expect(api.remove({ projectId: 'p1', actorSessionId: 'guest', packId: 'guest-pack', confirm: true }))
      .toEqual({ removed: true })
    db.close()
  })

  it('keeps roster behavior: own selection persists, other targets and preview stay supervisor-only', () => {
    const root = workspace()
    const packs = join(root, 'installed')
    pack(packs, 'design')
    const db = ledger(root)
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })

    expect(api.set({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1', skills: ['design'] }))
      .toEqual({ skills: ['design'] })
    expect(api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1' }))
      .toEqual({ skills: ['design'] })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 'w1' }))
      .toEqual([expect.objectContaining({ id: 'design', selected: true })])
    expect(() => api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 's1' }))
      .toThrow(/supervisor/)
    expect(() => api.set({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 's1', skills: [] }))
      .toThrow(/supervisor/)
    expect(() => api.preview({ projectId: 'p1', actorSessionId: 'w1', packId: 'design' }))
      .toThrow(/supervisor/)
    expect(() => { api.assertSupervisor({ projectId: 'p1', actorSessionId: 'w1' }) }).toThrow(/supervisor/)
    // A supervisor still targets any member, and preview stays available to it.
    expect(api.get({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1' }))
      .toEqual({ skills: ['design'] })
    expect(api.preview({ projectId: 'p1', actorSessionId: 's1', packId: 'design' }))
      .toMatchObject({ id: 'design', content: '# design' })
    // Supervisor-only guards reject an off-roster session too.
    expect(() => { api.assertSupervisor({ projectId: 'p1', actorSessionId: 'guest' }) }).toThrow(/supervisor/)
    expect(() => api.preview({ projectId: 'p1', actorSessionId: 'guest', packId: 'design' })).toThrow(/supervisor/)
    db.close()
  })

  it('rejects a missing project, a session of another project, and a departed member', () => {
    const root = workspace()
    const packs = join(root, 'installed')
    pack(packs, 'design')
    const db = ledger(root)
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })

    expect(() => api.catalog({ projectId: 'p9', actorSessionId: 'guest' })).toThrow(/项目不存在/)
    expect(() => api.add(addInput('p9', 'guest', 'any-pack'))).toThrow(/项目不存在/)
    expect(() => api.catalog({ projectId: 'p1', actorSessionId: 'x1' })).toThrow(/其他项目/)
    expect(() => api.set({ projectId: 'p1', actorSessionId: 'x1', targetSessionId: 'x1', skills: [] }))
      .toThrow(/其他项目/)
    expect(() => api.catalog({ projectId: 'p1', actorSessionId: 'd1' })).toThrow(/已退出/)
    expect(() => { api.assertMember({ projectId: 'p1', actorSessionId: 'd1' }) }).toThrow(/已退出/)
    // A present project with an unknown session id stays admitted.
    expect(() => { api.assertMember({ projectId: 'p2', actorSessionId: 'someone-new' }) }).not.toThrow()
    db.close()
  })

  it('admits a clean off-roster install but keeps warning-bearing installs supervisor-gated', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const db = ledger(root)
    const clean = createSkillApi({
      db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: remoteFetch('MIT'),
    })
    await expect(clean.installUrl({
      projectId: 'p1', actorSessionId: 'guest',
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote/SKILL.md',
    })).resolves.toMatchObject({ id: 'remote-pack' })

    const unknownLicense = createSkillApi({
      db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: remoteFetch('unknown'),
    })
    await expect(unknownLicense.installUrl({
      projectId: 'p1', actorSessionId: 'guest', confirm: true,
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote2/SKILL.md',
    })).rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    // The confirmation itself stays supervisor-only, and a supervisor can complete it.
    await expect(unknownLicense.installUrl({
      projectId: 'p1', actorSessionId: 's1', confirm: true,
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote2/SKILL.md',
    })).resolves.toMatchObject({ id: 'remote-pack' })
    db.close()
  })

  it('keeps a members-only ledger working without the projects table', () => {
    const root = workspace()
    const packs = join(root, 'installed')
    pack(packs, 'design')
    const db = new DatabaseSync(join(root, 'ledger.sqlite'))
    db.exec(`CREATE TABLE members (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (project_id, session_id))`)
    db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
      VALUES ('p1', 'w1', 'worker', 'available', '[]', 'now', 'now')`).run()
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 'guest' }))
      .toEqual([expect.objectContaining({ id: 'design' })])
    expect(() => api.catalog({ projectId: 'p9', actorSessionId: 'guest' })).toThrow(/项目不存在/)
    db.close()
  })
})

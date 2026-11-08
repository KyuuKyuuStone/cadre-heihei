import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { SkillAdminApi } from '../src/admin.ts'
import { loadSkillCatalog } from '../src/catalog.ts'
import { createSkillApi } from '../src/ipc.ts'

const roots: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

interface FakeSkill { name: string; content: string }
interface FakeAgent {
  id: string
  ctx: { skills: { register(skill: FakeSkill): () => void } }
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-session-skills-'))
  roots.push(dir)
  return dir
}

function pack(root: string, id: string, roles: string[], content = `# ${id}`): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, description: `${id} description`, roles, tokenEstimate: 12, tools: ['read'],
    source: 'internal', license: 'MIT',
  }))
  writeFileSync(join(dir, 'SKILL.md'), content)
}

function ledger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE members (
    project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    display_name TEXT, description TEXT, state TEXT NOT NULL,
    skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  return db
}

function insert(db: DatabaseSync, sessionId: string, role: string, skills: string[]): void {
  db.prepare(`INSERT INTO members (project_id, session_id, role, display_name, description, state, skills_json, created_at, updated_at)
    VALUES ('p1', ?, ?, NULL, NULL, 'available', ?, 'now', 'now')`)
    .run(sessionId, role, JSON.stringify(skills))
}

function harness(root: string, packs: string): {
  fire(agent: FakeAgent): Promise<void>
  skills: FakeSkill[]
  disposed: string[]
} {
  let handler: ((payload: { agent?: FakeAgent }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const skills: FakeSkill[] = []
  const disposed: string[] = []
  type Handler = (payload: { agent?: FakeAgent }, next: () => Promise<unknown>) => Promise<unknown>
  const ctx = {
    on(_event: string, fn: Handler) { handler = fn; return () => undefined },
    effect(fn: () => () => void) { cleanups.push(fn()) },
  }
  apply(ctx, { skillsDir: packs, ledgerPath: join(root, 'ledger.sqlite') })
  return {
    fire: async (agent) => { await handler?.({ agent }, () => Promise.resolve()) },
    skills,
    disposed,
  }
}

function agent(id: string, skills: FakeSkill[], disposed: string[]): FakeAgent {
  return {
    id,
    ctx: {
      skills: {
        register(skill) {
          skills.push(skill)
          return () => { disposed.push(skill.name) }
        },
      },
    },
  }
}

describe('session skill packs', () => {
  it('registers nothing for an empty selection', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'design', ['worker'])
    const db = ledger(root); insert(db, 'w1', 'worker', []); db.close()
    const h = harness(root, packs)
    const events: FakeSkill[] = []
    const disposed: string[] = []
    await h.fire(agent('w1', events, disposed))
    expect(events).toHaveLength(0)
  })

  it('registers only the selected pack and disposes it on change', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'design', ['worker'])
    pack(packs, 'testing', ['worker'])
    const db = ledger(root); insert(db, 'w1', 'worker', ['design']); db.close()
    const events: FakeSkill[] = []
    const disposed: string[] = []
    const h = harness(root, packs)
    const a = agent('w1', events, disposed)
    await h.fire(a)
    expect(events.map(skill => skill.name)).toEqual(['design'])
    const db2 = new DatabaseSync(join(root, 'ledger.sqlite'))
    db2.prepare(`UPDATE members SET skills_json = ? WHERE session_id = 'w1'`).run(JSON.stringify(['testing']))
    db2.close()
    await h.fire(a)
    expect(disposed).toEqual(['design'])
    expect(events.map(skill => skill.name)).toEqual(['design', 'testing'])
  })

  it('registers a pack whose manifest roles do not match the member role', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'supervisor-only', ['supervisor'])
    const db = ledger(root); insert(db, 'w1', 'worker', ['supervisor-only']); db.close()
    const events: FakeSkill[] = []
    const disposed: string[] = []
    await harness(root, packs).fire(agent('w1', events, disposed))
    expect(events.map(skill => skill.name)).toEqual(['supervisor-only'])
  })

  it('keeps supervisor and worker selections independent', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'lead', ['supervisor'])
    pack(packs, 'design', ['worker'])
    const db = ledger(root)
    insert(db, 's1', 'supervisor', ['lead', 'design'])
    insert(db, 'w1', 'worker', ['design', 'lead'])
    db.close()
    const h = harness(root, packs)
    const supervisor: FakeSkill[] = []
    const worker: FakeSkill[] = []
    await h.fire(agent('s1', supervisor, []))
    await h.fire(agent('w1', worker, []))
    expect(supervisor.map(skill => skill.name).sort()).toEqual(['design', 'lead'])
    expect(worker.map(skill => skill.name).sort()).toEqual(['design', 'lead'])
  })

  it('hot-reloads changed pack content and disposes the old registration', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'design', ['worker'], '# v1')
    const db = ledger(root); insert(db, 'w1', 'worker', ['design']); db.close()
    const events: FakeSkill[] = []
    const disposed: string[] = []
    const h = harness(root, packs)
    const a = agent('w1', events, disposed)
    await h.fire(a)
    writeFileSync(join(packs, 'design', 'SKILL.md'), '# v2')
    await h.fire(a)
    expect(disposed).toEqual(['design'])
    expect(events.map(skill => skill.content)).toEqual(['# v1', '# v2'])
  })

  it('catalog/get/set/preview dedupe and persistence', () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'design', ['worker'], '# design body')
    pack(packs, 'lead', ['supervisor'])
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    insert(db, 'w1', 'worker', ['design'])
    db.prepare(`UPDATE members SET description = 'keep me' WHERE session_id = 'w1'`).run()
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })

    expect(api.catalog({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1' }))
      .toMatchObject([
        { id: 'design', selected: true, roles: ['worker'], tokenEstimate: 12 },
        { id: 'lead', selected: false, roles: ['supervisor'] },
      ])
    expect(api.get({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1' }).skills).toEqual(['design'])
    expect(api.set({
      projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['design', 'design'],
    }).skills).toEqual(['design'])
    const row = db.prepare(`SELECT skills_json, description FROM members WHERE session_id = 'w1'`).get() as {
      skills_json: string; description: string
    }
    expect(JSON.parse(row.skills_json)).toEqual(['design'])
    expect(row.description).toBe('keep me')
    expect(api.preview({ projectId: 'p1', actorSessionId: 's1', packId: 'design' }))
      .toMatchObject({ id: 'design', content: '# design body', tokenEstimate: 12 })
    expect(api.set({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['lead'] }))
      .toEqual({ skills: ['lead'] })
    expect(() => api.set({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['missing'] }))
      .toThrow(/未知技能包/)
    expect(api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1' }).skills).toEqual(['lead'])
    expect(() => api.preview({ projectId: 'p1', actorSessionId: 'w1', packId: 'design' }))
      .toThrow(/只有本项目在册 supervisor/)
    db.close()
  })

  it('adds, rejects, overwrites and removes packs', () => {
    const root = workspace()
    const packs = join(root, 'packs')
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })
    const base = {
      projectId: 'p1', actorSessionId: 's1', name: 'Manual', description: 'manual pack',
      roles: ['worker'], tokenEstimate: 10, tools: ['read'], source: 'manual', license: 'MIT',
    }
    expect(api.add({ ...base, id: 'manual-pack', content: '# v1' })).toMatchObject({
      id: 'manual-pack', roles: ['worker'], tokenEstimate: 10,
    })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 's1' }).map(pack => pack.id)).toContain('manual-pack')
    expect(readFileSync(join(packs, 'manual-pack', 'SKILL.md'), 'utf8')).toBe('# v1')
    expect(() => api.add({ ...base, id: '../escape', content: '# x' })).toThrow(/kebab-case/)
    expect(() => api.add({ ...base, id: 'manual-pack', content: '# x' })).toThrow(/已存在/)
    expect(api.add({ ...base, id: 'manual-pack', content: '# v2', overwrite: true })).toMatchObject({ id: 'manual-pack' })
    expect(readFileSync(join(packs, 'manual-pack', 'SKILL.md'), 'utf8')).toBe('# v2')
    expect(() => api.remove({ projectId: 'p1', actorSessionId: 's1', packId: 'manual-pack', confirm: false }))
      .toThrow(/confirm:true/)
    expect(api.remove({ projectId: 'p1', actorSessionId: 's1', packId: 'manual-pack', confirm: true }))
      .toEqual({ removed: true })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 's1' }).map(pack => pack.id)).not.toContain('manual-pack')
    db.close()
  })

  it('degrades to empty selections when the real ledger is still schema 2', () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'design', ['worker'])
    const db = new DatabaseSync(join(root, 'ledger.sqlite'))
    db.exec(`CREATE TABLE members (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      display_name TEXT, description TEXT, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id))`)
    db.prepare(`INSERT INTO members (project_id, session_id, role, state, created_at, updated_at)
      VALUES ('p1', 's1', 'supervisor', 'available', 'now', 'now')`).run()
    db.prepare(`INSERT INTO members (project_id, session_id, role, state, created_at, updated_at)
      VALUES ('p1', 'w1', 'worker', 'available', 'now', 'now')`).run()
    const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs })
    expect(api.get({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1' }).skills).toEqual([])
    expect(api.catalog({ projectId: 'p1', actorSessionId: 's1' })[0]).toMatchObject({ id: 'design', selected: false })
    expect(() => api.set({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['design'] }))
      .toThrow(/schema 3 迁移/)
    db.close()
  })

  it('distinguishes builtin read-only packs from installed packs and localizes descriptions', () => {
    const root = workspace()
    const builtin = join(root, 'builtin')
    const installed = join(root, 'installed')
    pack(builtin, 'cadre-workflow', ['worker'])
    const manifestPath = join(builtin, 'cadre-workflow', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.descriptionI18n = { zh: '中文说明', en: 'English description' }
    manifest.author = 'Elaya'
    manifest.homepage = 'https://github.com/elayadesign/ai-design-skills'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    pack(installed, 'manual-pack', ['worker'])
    pack(installed, 'cadre-workflow', ['worker'])
    const db = ledger(root); insert(db, 's1', 'supervisor', []); db.close()
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'))
    const api = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'),
      skillsDir: installed, builtinDir: builtin,
    })
    const zh = api.catalog({ projectId: 'p1', actorSessionId: 's1', locale: 'zh-CN' })
    expect(zh.find(item => item.id === 'cadre-workflow')).toMatchObject({
      origin: 'builtin', description: '中文说明', author: 'Elaya',
      homepage: 'https://github.com/elayadesign/ai-design-skills',
    })
    expect(zh.find(item => item.id === 'manual-pack')).toMatchObject({ origin: 'installed' })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 's1', locale: 'en' })
      .find(item => item.id === 'cadre-workflow')?.description).toBe('English description')
    expect(api.preview({ projectId: 'p1', actorSessionId: 's1', packId: 'cadre-workflow' })).toMatchObject({
      author: 'Elaya', homepage: 'https://github.com/elayadesign/ai-design-skills',
    })
    expect(() => api.add({
      projectId: 'p1', actorSessionId: 's1', id: 'bad-home', name: 'bad', description: 'bad',
      roles: ['worker'], tokenEstimate: 1, tools: [], source: 'manual', license: 'MIT',
      content: '# bad', homepage: 'http://insecure.example',
    })).toThrow(/https URL/)
    expect(() => api.remove({ projectId: 'p1', actorSessionId: 's1', packId: 'cadre-workflow', confirm: true }))
      .toThrow(/内置技能包/)
    reader.close()
  })

  it('installs a remote raw pack, rejects invalid/oversized/duplicate URLs, and overwrites with confirm', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const db = ledger(root); insert(db, 's1', 'supervisor', []); db.close()
    const writer = new DatabaseSync(join(root, 'ledger.sqlite'))
    const calls: string[] = []
    const fetch = vi.fn(async (input: URL | string) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({
          id: 'remote-pack', name: 'Remote', description: 'remote pack', roles: ['worker'],
          tokenEstimate: 5, tools: [], source: 'github:o/r', license: 'MIT',
          author: 'Remote Author', homepage: 'https://github.com/o/r',
        }), { status: 200 })
      }
      return new Response('# remote v1', { status: 200 })
    })
    const api = createSkillApi({
      db: writer, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: fetch as never,
    })
    const input = {
      projectId: 'p1', actorSessionId: 's1',
      url: 'https://raw.githubusercontent.com/o/r/main/packs/remote/SKILL.md',
    }
    expect(await api.installUrl(input)).toMatchObject({
      id: 'remote-pack', origin: 'installed', author: 'Remote Author', homepage: 'https://github.com/o/r',
    })
    expect(calls.some(url => url.endsWith('manifest.json'))).toBe(true)
    expect(readFileSync(join(packs, 'remote-pack', 'SKILL.md'), 'utf8')).toBe('# remote v1')
    await expect(api.installUrl(input)).rejects.toThrow(/已存在/)
    expect(await api.installUrl({ ...input, confirm: true })).toMatchObject({ id: 'remote-pack' })
    await expect(api.installUrl({ ...input, url: 'http://raw.githubusercontent.com/o/r/main/SKILL.md' }))
      .rejects.toThrow(/https/)
    const big = vi.fn(async (input: URL | string) => {
      return String(input).endsWith('manifest.json')
        ? new Response(JSON.stringify({
          id: 'huge', name: 'Huge', description: 'huge', roles: ['worker'], tokenEstimate: 1,
          tools: [], source: 'x', license: 'MIT',
        }), { status: 200 })
        : new Response('x'.repeat(300 * 1024), { status: 200 })
    })
    const bigApi = createSkillApi({
      db: writer, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: big as never,
    })
    await expect(bigApi.installUrl({
      ...input, url: 'https://raw.githubusercontent.com/o/r/main/packs/huge/SKILL.md',
    })).rejects.toThrow(/大小限制/)
    writer.close()
  })

  it('scans SkillHub scope layouts and synthesizes frontmatter packs without manifest.json', () => {
    const root = workspace()
    const scoped = join(root, '@indiv-guipi', 'find-skills')
    mkdirSync(scoped, { recursive: true })
    const body = '---\nname: find-skills\nslug: find-skills\ndisplayName: 技能发现·Find Skills\ndescription: 场景驱动和关键词双模式。\nversion: "1.7.0"\n---\n# Find Skills\n\nbody\n'
    writeFileSync(join(scoped, 'SKILL.md'), body)
    writeFileSync(join(scoped, '_meta.json'), '{"slug":"find-skills","version":"1.7.0"}')
    writeFileSync(join(scoped, 'README.md'), '# README\n')

    const flat = join(root, 'flat-skill')
    mkdirSync(flat, { recursive: true })
    writeFileSync(join(flat, 'SKILL.md'), '---\nname: flat-skill\ndescription: flat\n---\n# flat\n')

    const invalid = join(root, 'invalid-skill')
    mkdirSync(invalid, { recursive: true })
    writeFileSync(join(invalid, 'SKILL.md'), '# no frontmatter\n')

    const catalog = loadSkillCatalog(root)
    expect(catalog.get('indiv-guipi-find-skills')).toMatchObject({
      name: '技能发现·Find Skills',
      description: '场景驱动和关键词双模式。',
      roles: ['worker'],
      license: 'unknown',
      source: 'skillhub:@indiv-guipi/find-skills',
      tokenEstimate: Math.ceil(body.length / 4),
      origin: 'installed',
    })
    expect(catalog.get('flat-skill')).toMatchObject({ name: 'flat-skill', description: 'flat' })
    expect(catalog.has('invalid-skill')).toBe(false)
    expect(existsSync(join(scoped, 'manifest.json'))).toBe(false)
  })

  it('derives scope-qualified ids so same slugs in different scopes do not collide', () => {
    const root = workspace()
    for (const scope of ['@alpha', '@beta']) {
      const directory = join(root, scope, 'find-skills')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'SKILL.md'), '---\nname: find-skills\ndescription: shared slug\n---\n# body\n')
    }
    const catalog = loadSkillCatalog(root)
    expect([...catalog.keys()]).toEqual(['alpha-find-skills', 'beta-find-skills'])
  })

  it('creates ordinary admin sessions without roster rows and applies a confirmed plan with audit', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    insert(db, 'w1', 'worker', [])
    db.close()
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'))
    const sessions: Array<{ sessionId: string; title: string; updatedAt: number }> = []
    const port = {
      create: async (input: { title: string }) => {
        const sessionId = `admin-${String(sessions.length + 1)}`
        sessions.push({ sessionId, title: input.title, updatedAt: 1 })
        return { sessionId }
      },
      list: async () => sessions,
      delete: async (input: { sessionId: string }) => {
        const index = sessions.findIndex(session => session.sessionId === input.sessionId)
        if (index >= 0) sessions.splice(index, 1)
      },
    }
    const fetch = vi.fn(async (input: URL | string) => {
      return String(input).endsWith('manifest.json')
        ? new Response(JSON.stringify({
          id: 'admin-pack', name: 'Admin Pack', description: 'from admin', roles: ['worker'],
          tokenEstimate: 1, tools: [], source: 'github:o/r', license: 'MIT',
        }), { status: 200 })
        : new Response('# admin body', { status: 200 })
    })
    const workspacePort = {
      create: async (path: string) => ({
        id: 'ws-admin', path, attachSession: async () => {},
      }),
    }
    const admin = new SkillAdminApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs,
      sessions: port, workspace: workspacePort, auditDir: join(root, 'audit'), fetch: fetch as never,
    })
    const created = await admin.createSession({ projectId: 'p1', cwd: root })
    expect(created.sessionId).toBe('admin-1')
    expect(reader.prepare('SELECT COUNT(*) AS count FROM members').get()).toMatchObject({ count: 2 })
    expect(await admin.listSessions({ projectId: 'p1' })).toHaveLength(1)

    const plan = await admin.plan({
      projectId: 'p1', operatorSessionId: 's1',
      url: 'https://raw.githubusercontent.com/o/r/main/packs/admin/SKILL.md',
    })
    expect(plan).toMatchObject({ kind: 'install', packId: 'admin-pack', license: 'MIT' })
    expect(plan.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    const token = admin.tokenFor(plan.planId)
    expect(token).toBeTruthy()
    expect(await admin.apply({
      projectId: 'p1', operatorSessionId: 's1', planId: plan.planId, token: token ?? '',
    })).toMatchObject({ status: 'applied', packId: 'admin-pack' })
    expect(readFileSync(join(packs, 'admin-pack', 'SKILL.md'), 'utf8')).toBe('# admin body')

    const removePlan = await admin.plan({ projectId: 'p1', operatorSessionId: 's1', kind: 'remove', packId: 'admin-pack' })
    const removeToken = admin.tokenFor(removePlan.planId) ?? ''
    expect(await admin.apply({
      projectId: 'p1', operatorSessionId: 's1', planId: removePlan.planId, token: removeToken,
    })).toMatchObject({ status: 'applied', packId: 'admin-pack' })
    expect(existsSync(join(packs, 'admin-pack'))).toBe(false)
    expect(existsSync(join(packs, `admin-pack.backup-${removePlan.planId}`))).toBe(true)

    const audit = admin.auditFor({ projectId: 'p1', operatorSessionId: 's1' })
    expect(audit.at(-1)).toMatchObject({ result: 'applied', packId: 'admin-pack' })
    expect(JSON.stringify(audit)).not.toContain('# admin body')

    const workerSession = await admin.createSession({ projectId: 'p1', cwd: root })
    expect(workerSession.sessionId).toBe('admin-2')
    await expect(admin.plan({ projectId: 'p1', operatorSessionId: 'w1', url: 'https://x.test' }))
      .rejects.toThrow(/supervisor/)

    const unsupported = await admin.plan({
      projectId: 'p1', operatorSessionId: 's1', url: 'https://example.com/README.md',
    })
    expect(unsupported.kind).toBe('unsupported')
    expect(unsupported.reason).toBeTruthy()

    await admin.deleteSession({ projectId: 'p1', sessionId: created.sessionId })
    expect(await admin.listSessions({ projectId: 'p1' })).toHaveLength(1)
    reader.close()
  })

  it('lets members view/edit their own skills and install packs, while admin stays supervisor-only', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    pack(packs, 'design', ['worker'])
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    insert(db, 'w1', 'worker', [])
    insert(db, 'w2', 'worker', [])
    db.close()
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'))
    const api = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs,
    })
    expect(api.catalog({ projectId: 'p1', actorSessionId: 'w1' })).toEqual([
      expect.objectContaining({ id: 'design', selected: false }),
    ])
    expect(api.set({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1', skills: ['design'] }))
      .toEqual({ skills: ['design'] })
    expect(api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1' }))
      .toEqual({ skills: ['design'] })
    expect(() => api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w2' }))
      .toThrow(/supervisor/)
    expect(() => api.set({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w2', skills: [] }))
      .toThrow(/supervisor/)
    expect(() => api.preview({ projectId: 'p1', actorSessionId: 'w1', packId: 'design' }))
      .toThrow(/supervisor/)
    expect(api.add({
      projectId: 'p1', actorSessionId: 'w1', id: 'worker-pack', name: 'Worker Pack', description: 'worker',
      roles: ['worker'], tokenEstimate: 1, tools: [], source: 'manual', license: 'MIT', content: '# worker',
    })).toMatchObject({ id: 'worker-pack' })
    expect(api.remove({ projectId: 'p1', actorSessionId: 'w1', packId: 'worker-pack', confirm: true }))
      .toEqual({ removed: true })
    expect(api.add({
      projectId: 'p1', actorSessionId: 'off-roster', id: 'guest-pack', name: 'Guest Pack', description: 'guest',
      roles: ['worker'], tokenEstimate: 1, tools: [], source: 'manual', license: 'MIT', content: '# guest',
    })).toMatchObject({ id: 'guest-pack' })
    const fetch = vi.fn(async (input: URL | string) => String(input).endsWith('manifest.json')
      ? new Response(JSON.stringify({
        id: 'url-pack', name: 'URL Pack', description: 'url', roles: ['worker'],
        tokenEstimate: 1, tools: [], source: 'github:o/r', license: 'MIT', author: 'URL Author',
      }), { status: 200 })
      : new Response('# url', { status: 200 }))
    const urlApi = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: fetch as never,
    })
    await expect(urlApi.installUrl({
      projectId: 'p1', actorSessionId: 'w1',
      url: 'https://raw.githubusercontent.com/o/r/main/packs/url/SKILL.md',
    })).resolves.toMatchObject({ id: 'url-pack' })
    await expect(urlApi.installUrl({
      projectId: 'p1', actorSessionId: 'off-roster', confirm: true,
      url: 'https://raw.githubusercontent.com/o/r/main/packs/url/SKILL.md',
    })).resolves.toMatchObject({ id: 'url-pack' })
    reader.close()
  })

  it('routes free-form install text to one validated package or URL', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    insert(db, 'w1', 'worker', [])
    db.close()
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'))
    const calls: string[][] = []
    const install = async (name: string): Promise<void> => {
      const parts = name.startsWith('@') ? name.split('/') : [name]
      const dir = join(packs, ...parts)
      mkdirSync(dir, { recursive: true })
      const id = parts.at(-1)!
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: test\n---\n# ${id}\n`)
    }
    const fetch = vi.fn(async (input: URL | string) => String(input).endsWith('manifest.json')
      ? new Response(JSON.stringify({
        id: 'url-any', name: 'URL Any', description: 'url', roles: ['worker'],
        tokenEstimate: 1, tools: [], source: 'github:o/r', license: 'MIT', author: 'URL Author',
      }), { status: 200 })
      : new Response('# url-any', { status: 200 }))
    const api = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, fetch: fetch as never,
      runPackageCommand: async args => {
        calls.push([...args])
        await install(args[5]!)
        return { code: 0, stdout: 'installed', stderr: '' }
      },
    })
    const sentence = '请根据 https://skillhub.cn/install/skillhub.md，安装 @zhaopintong/multi-search-engine。'
    const pending = await api.installAny({ projectId: 'p1', actorSessionId: 's1', text: sentence })
    expect(pending).toMatchObject({
      kind: 'package', target: '@zhaopintong/multi-search-engine', installed: false, requiresConfirmation: true,
    })
    expect(calls).toHaveLength(0)
    const anyPackage = await api.installAny({
      projectId: 'p1', actorSessionId: 's1', text: sentence, confirm: true,
    })
    expect(anyPackage).toMatchObject({ kind: 'package', target: '@zhaopintong/multi-search-engine', installed: true })
    expect(anyPackage.warnings).toEqual(expect.arrayContaining(['missing-license', 'missing-hash']))
    expect(calls.at(-1)?.[5]).toBe('@zhaopintong/multi-search-engine')
    await expect(api.installAny({ projectId: 'p1', actorSessionId: 'w1', text: '请安装 find-skills。' }))
      .rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    const anyUrl = await api.installAny({
      projectId: 'p1', actorSessionId: 'w1',
      text: '从 https://raw.githubusercontent.com/o/r/main/packs/url/SKILL.md 安装',
    })
    expect(anyUrl).toMatchObject({ kind: 'url', target: expect.stringContaining('raw.githubusercontent.com'), installed: true })
    expect(anyUrl.warnings).toEqual([])
    expect(fetch).toHaveBeenCalled()
    const before = calls.length
    await expect(api.installAny({ projectId: 'p1', actorSessionId: 'w1', text: '安装 aaa-bbb 和 ccc-ddd' }))
      .rejects.toMatchObject({ code: 'SKILL_INSTRUCTION_UNSUPPORTED' })
    await expect(api.installAny({
      projectId: 'p1', actorSessionId: 'w1',
      text: '安装 @scope/pkg 和 https://example.com/not-an-instruction',
    })).rejects.toMatchObject({ code: 'SKILL_INSTRUCTION_UNSUPPORTED' })
    await expect(api.installAny({ projectId: 'p1', actorSessionId: 'w1', text: '请安装这个技能' }))
      .rejects.toMatchObject({ code: 'SKILL_INSTRUCTION_UNSUPPORTED' })
    await expect(api.installAny({ projectId: 'p1', actorSessionId: 'off-roster', text: '安装 find-skills' }))
      .rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    expect(calls).toHaveLength(before)
    reader.close()
  })

  it('installs a SkillHub package through the fixed WSL command and audits each outcome', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const auditDir = join(root, 'audit')
    const db = ledger(root)
    insert(db, 's1', 'supervisor', [])
    insert(db, 'w1', 'worker', [])
    db.close()
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'))
    const calls: string[][] = []
    const success = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, auditDir,
      runPackageCommand: async args => {
        calls.push([...args])
        const pack = join(packs, '@indiv-guipi', 'find-skills')
        mkdirSync(pack, { recursive: true })
        writeFileSync(join(pack, 'SKILL.md'), '---\nname: find-skills\ndescription: find\n---\n# find\n')
        return { code: 0, stdout: 'installed', stderr: '' }
      },
    })
    await expect(success.installPackage({
      projectId: 'p1', actorSessionId: 's1', name: '@indiv-guipi/find-skills',
    })).resolves.toMatchObject({
      installed: false, requiresConfirmation: true,
      warnings: expect.arrayContaining(['missing-license', 'missing-hash']),
    })
    expect(calls).toHaveLength(0)
    await expect(success.installPackage({
      projectId: 'p1', actorSessionId: 's1', name: '@indiv-guipi/find-skills', confirm: true,
    })).resolves.toMatchObject({
      name: '@indiv-guipi/find-skills', visible: true, installed: true,
      warnings: expect.arrayContaining(['missing-license', 'missing-hash']),
    })
    await expect(success.installPackage({
      projectId: 'p1', actorSessionId: 'w1', name: '@indiv-guipi/find-skills',
    })).rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    expect(calls[0]).toEqual([
      '-d', 'Ubuntu-24.04', '--', '/root/.local/bin/skillhub', 'install',
      '@indiv-guipi/find-skills', '--dir', packs,
    ])
    expect(readFileSync(join(auditDir, 'audit.jsonl'), 'utf8')).toContain('"result":"installed"')
    expect(readFileSync(join(auditDir, 'audit.jsonl'), 'utf8')).toContain('missing-license')
    expect(readFileSync(join(auditDir, 'audit.jsonl'), 'utf8')).toContain('confirmedBy')
    expect(readFileSync(join(auditDir, 'audit.jsonl'), 'utf8')).not.toContain('apiKey')

    const failing = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, auditDir,
      runPackageCommand: async () => ({ code: 1, stdout: '', stderr: 'registry denied' }),
    })
    await expect(failing.installPackage({ projectId: 'p1', actorSessionId: 's1', name: 'find-skills', confirm: true }))
      .rejects.toMatchObject({ code: 'SKILL_INSTALL_PACKAGE_FAILED' })
    await expect(failing.installPackage({ projectId: 'p1', actorSessionId: 's1', name: 'bad name; rm -rf', confirm: true }))
      .rejects.toMatchObject({ code: 'SKILL_INVALID' })
    const unsupported = createSkillApi({
      db: reader, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs, auditDir,
      runPackageCommand: async () => ({ code: 127, stdout: '', stderr: 'WSL_E_DISTRO_NOT_FOUND' }),
    })
    await expect(unsupported.installPackage({ projectId: 'p1', actorSessionId: 's1', name: 'find-skills', confirm: true }))
      .rejects.toMatchObject({ code: 'SKILL_INSTALL_PACKAGE_UNSUPPORTED' })
    await expect(unsupported.installPackage({ projectId: 'p1', actorSessionId: 'w1', name: 'find-skills' }))
      .rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    await expect(unsupported.installPackage({ projectId: 'p1', actorSessionId: 'off-roster', name: 'find-skills' }))
      .rejects.toMatchObject({ code: 'SKILL_CONFIRM_REQUIRED' })
    reader.close()
  })
})

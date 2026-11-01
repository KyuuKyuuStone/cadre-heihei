import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
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

  it('rejects a pack whose roles do not match the member role', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'supervisor-only', ['supervisor'])
    const db = ledger(root); insert(db, 'w1', 'worker', ['supervisor-only']); db.close()
    const events: FakeSkill[] = []
    const disposed: string[] = []
    await harness(root, packs).fire(agent('w1', events, disposed))
    expect(events).toHaveLength(0)
  })

  it('keeps supervisor and worker selections independent', async () => {
    const root = workspace()
    const packs = join(root, 'packs')
    pack(packs, 'lead', ['supervisor'])
    pack(packs, 'design', ['worker'])
    const db = ledger(root)
    insert(db, 's1', 'supervisor', ['lead'])
    insert(db, 'w1', 'worker', ['design'])
    db.close()
    const h = harness(root, packs)
    const supervisor: FakeSkill[] = []
    const worker: FakeSkill[] = []
    await h.fire(agent('s1', supervisor, []))
    await h.fire(agent('w1', worker, []))
    expect(supervisor.map(skill => skill.name)).toEqual(['lead'])
    expect(worker.map(skill => skill.name)).toEqual(['design'])
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

  it('catalog/get/set/preview enforce supervisor, roles, dedupe and persistence', () => {
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
    expect(() => api.set({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['lead'] }))
      .toThrow(/不能加载技能包 lead/)
    expect(() => api.set({ projectId: 'p1', actorSessionId: 's1', targetSessionId: 'w1', skills: ['missing'] }))
      .toThrow(/未知技能包/)
    expect(() => api.get({ projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1' }))
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
})

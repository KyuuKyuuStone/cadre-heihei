import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

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
})

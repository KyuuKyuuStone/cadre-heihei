import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import { apply } from '../src/index.ts'

const PROJECT = 'p-skill'
const SUP = 'sup-skill'
const WORKER = 'worker-skill'
const AT = '2026-10-30T00:00:00.000Z'
const roots: string[] = []
const previous = process.env.CADRE_LEDGER_PATH

afterEach(() => {
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(root, { recursive: true, force: true }); break } catch { /* retry after async close */ }
    }
  }
  if (previous === undefined) delete process.env.CADRE_LEDGER_PATH
  else process.env.CADRE_LEDGER_PATH = previous
})

function mount(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-skill-'))
  roots.push(dir)
  const db = join(dir, 'cadre.sqlite')
  initCadreStore(db)
  const raw = new DatabaseSync(db)
  try {
    raw.prepare(`INSERT INTO projects (project_id, name, root_path, status, created_at)
      VALUES (?, 'p', 'C:/p', 'active', ?)`).run(PROJECT, AT)
    const member = raw.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    member.run(PROJECT, SUP, 'supervisor', '主管', AT, AT)
    member.run(PROJECT, WORKER, 'worker', '员工', AT, AT)
  } finally {
    raw.close()
  }
  process.env.CADRE_LEDGER_PATH = db
  const registered: { skill: Record<string, unknown>; dispose: () => void; disposed: boolean }[] = []
  const makeAgent = (id: string) => ({
    id,
    ctx: { skills: { register: (skill: Record<string, unknown>) => {
      const entry = { skill, disposed: false, dispose: () => { entry.disposed = true } }
      registered.push(entry)
      return entry.dispose
    } } },
  })
  let listener: ((payload: { agent?: { id: string; ctx: unknown } }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  let dispose: (() => void) | undefined
  let nextCalls = 0
  apply({
    on: (_event, handler) => { listener = handler as typeof listener; return () => {} },
    effect: (setup) => { dispose = setup(); return () => {} },
  }, { enabled })
  if (enabled && listener === undefined) throw new Error('skill listener missing')
  return {
    fire: async (agent: { id: string; ctx: unknown }) => {
      const decision = await listener?.({ agent }, async () => {
        nextCalls += 1
        return { kind: 'allow' }
      })
      return { decision, nextCalls }
    },
    makeAgent,
    registered,
    nextCalls: () => nextCalls,
    dispose: () => dispose?.(),
  }
}

describe('supervisor skill', () => {
  it('registers one scoped skill for a supervisor with file content/metadata', () => {
    const mounted = mount()
    const agent = mounted.makeAgent(SUP)
    mounted.fire(agent)
    mounted.fire(agent)
    expect(mounted.registered).toHaveLength(1)
    const skill = mounted.registered[0]!.skill
    expect(skill).toMatchObject({
      name: 'cadre-supervisor',
      source: 'runtime',
      metadata: { version: '0.1.0', roles: ['supervisor'] },
      invocation: { modelInvocable: true, userInvocable: true },
    })
    expect(String(skill.content)).toContain('先分清讨论还是任务')
    expect(String(skill.content)).toContain('聚合，不逐条转述')
    expect(String(skill.content)).toContain('精致交付时，派员工')
    expect(String(skill.content)).toContain('read`/`grep`')
    mounted.dispose()
  })

  it('does not short-circuit the agent/pre-step waterfall in any branch', async () => {
    const mounted = mount()
    const supervisor = mounted.makeAgent(SUP)
    const worker = mounted.makeAgent(WORKER)
    expect((await mounted.fire(supervisor)).decision).toEqual({ kind: 'allow' })
    expect((await mounted.fire(supervisor)).decision).toEqual({ kind: 'allow' })
    expect((await mounted.fire(worker)).decision).toEqual({ kind: 'allow' })
    expect((await mounted.fire(mounted.makeAgent('stranger'))).decision).toEqual({ kind: 'allow' })
    expect(mounted.nextCalls()).toBe(4)
    mounted.dispose()
  })

  it('never registers for a worker or an ordinary session', () => {
    const mounted = mount()
    mounted.fire(mounted.makeAgent(WORKER))
    mounted.fire(mounted.makeAgent('stranger'))
    expect(mounted.registered).toHaveLength(0)
    mounted.dispose()
  })

  it('stays off when enabled=false', () => {
    const mounted = mount(false)
    mounted.fire(mounted.makeAgent(SUP))
    expect(mounted.registered).toHaveLength(0)
    mounted.dispose()
  })

  it('is visible through the real skill registry only in the supervisor scope', async () => {
    const mounted = mount()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const supervisorKey = { id: SUP }
    const workerKey = { id: WORKER }
    const scoped = async (key: object) => {
      let scope: ReturnType<typeof createScope> | undefined
      await ctx.plugin({
        inject: ['skills'],
        apply: (inner: Context) => { scope = createScope(inner, key) },
      })
      if (scope === undefined) throw new Error('scope not created')
      return scope
    }
    const supervisorScope = await scoped(supervisorKey)
    const workerScope = await scoped(workerKey)
    let skillDispose: (() => void) | undefined
    try {
      let listener: ((payload: { agent?: { id: string; ctx: unknown } }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
      apply({
        on: (_event, handler) => { listener = handler as typeof listener; return () => {} },
        effect: (setup) => { skillDispose = setup(); return () => {} },
      }, {})
      await listener?.({ agent: { id: SUP, ctx: supervisorScope.ctx } }, async () => ({ kind: 'allow' }))
      await listener?.({ agent: { id: WORKER, ctx: workerScope.ctx } }, async () => ({ kind: 'allow' }))
      const supervisorSkills = await ctx.skills.list({ scope: supervisorKey })
      const workerSkills = await ctx.skills.list({ scope: workerKey })
      expect(supervisorSkills.map(skill => skill.name)).toContain('cadre-supervisor')
      expect(workerSkills.map(skill => skill.name)).not.toContain('cadre-supervisor')
    } finally {
      skillDispose?.()
      await supervisorScope.dispose()
      await workerScope.dispose()
      await ctx.fiber.dispose()
      mounted.dispose()
    }
  })

  it('disposes the skill when the agent stops being a supervisor', () => {
    const mounted = mount()
    const agent = mounted.makeAgent(SUP)
    mounted.fire(agent)
    expect(mounted.registered).toHaveLength(1)
    // Simulate roster demotion by re-pointing the member role.
    const db = new DatabaseSync(process.env.CADRE_LEDGER_PATH!, {})
    try {
      db.prepare("UPDATE members SET role = 'worker' WHERE session_id = ?").run(SUP)
    } finally {
      db.close()
    }
    mounted.fire(agent)
    expect(mounted.registered[0]?.disposed).toBe(true)
    mounted.dispose()
  })
})

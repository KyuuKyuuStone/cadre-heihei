import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import { apply, type Config } from '../src/index.ts'
import { TaskMemoryReader, TaskMemoryCompactionGate, capTaskMemory } from '../src/task-memory.ts'

const roots: string[] = []
const closers: (() => void)[] = []
const previousLedgerPath = process.env.CADRE_LEDGER_PATH
afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousLedgerPath === undefined) delete process.env.CADRE_LEDGER_PATH
  else process.env.CADRE_LEDGER_PATH = previousLedgerPath
})

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'task-memory-'))
  roots.push(root)
  const path = join(root, 'ledger.sqlite')
  initCadreStore(path)
  const db = new DatabaseSync(path)
  try {
    const at = '2026-11-02T00:00:00.000Z'
    const member = db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'available', ?, ?)`)
    member.run('p1', 'sup', 'supervisor', '主管', at, at)
    member.run('p1', 'w1', 'worker', '小王', at, at)
    member.run('p1', 'w2', 'worker', '小李', at, at)
    member.run('p2', 'other', 'worker', '外部', at, at)
    const task = db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes,
      body_sha256, status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 'sha', ?, 'sup', ?, ?, ?)`)
    task.run('t-ongoing', 'p1', 1, '进行中任务', '当前工作', 'in_progress', 'w1', at, at)
    task.run('t-done', 'p1', 2, '已完成任务', '完成内容', 'verified', 'w1', at, at)
    task.run('t-other', 'p1', 3, '别人任务', '别人内容', 'verified', 'w2', at, at)
    task.run('t-cross', 'p2', 1, '跨项目任务', '跨项目', 'verified', 'other', at, at)
    const memory = db.prepare(`INSERT INTO task_memory
      (task_id, project_id, name, status, summary, decisions_json, artifacts_json, transcript_ref, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    memory.run('t-done', 'p1', '已完成任务', 'verified', '已完成任务｜完成内容', '["验收通过"]',
      '["C:/out.md"]', 'task:t-done', at)
    memory.run('t-other', 'p1', '别人任务', 'verified', '别人任务｜别人内容', '[]', '[]', 'task:t-other', at)
    memory.run('t-cross', 'p2', '跨项目任务', 'verified', '跨项目｜跨项目', '[]', '[]', 'task:t-cross', at)
  } finally {
    db.close()
  }
  return path
}

type StatusListener = (payload: {
  readonly agent: { readonly id: string; readonly status?: string }
  readonly status: string
}) => void

function mountCompaction(config: Config = {}, options: { readonly systemPrompt?: boolean; readonly agentPresets?: boolean } = {}) {
  const path = seed()
  const raw = new DatabaseSync(path)
  try {
    raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE status = 'in_progress'").run()
  } finally {
    raw.close()
  }
  process.env.CADRE_LEDGER_PATH = path
  const session = { snapshotEvents: () => [] }
  const agent = {
    id: 'sup', status: 'idle', session,
    ctx: { get: (name: string) => name === 'compaction' && options.agentPresets === false ? compaction : undefined },
  }
  const goal = { id: 'goal', revision: 1, phase: 'active' as const, activation: 'armed' as const }
  let currentContextTokens = 0
  let compactCalls = 0
  let compactResult: unknown = { compacted: true }
  let compactFailure: Error | undefined
  let listener: StatusListener | undefined
  const disposers: (() => void)[] = []
  const promptSections: { name: string; text: (context: { scope?: unknown }) => string }[] = []
  const compaction = {
    compactNow: async (target: typeof agent) => {
      expect(target).toBe(agent)
      compactCalls += 1
      if (compactFailure !== undefined) throw compactFailure
      return compactResult
    },
  }
  const tokenMeter = {
    measure: (target: typeof session) => {
      expect(target).toBe(session)
      return { totalTokens: currentContextTokens }
    },
  }
  const agentPresets = {
    serviceFor: (target: typeof agent, name: string) => {
      expect(target).toBe(agent)
      expect(name).toBe('compaction')
      return compaction
    },
  }
  const systemPrompt = {
    context: (section: { name: string; text: (context: { scope?: unknown }) => string }) => {
      promptSections.push(section)
      return () => { promptSections.splice(promptSections.indexOf(section), 1) }
    },
  }
  apply({
    tools: { register: () => {} },
    sessionController: { prompt: async () => ({}) },
    sessions: { get: (id: string) => id === agent.id ? session : undefined, list: () => [session] },
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    goals: {
      get: () => undefined,
      create: () => goal,
      resume: () => goal,
      pause: () => goal,
      complete: () => goal,
      disarm: () => goal,
    },
    get: (name: string) => name === 'tokenMeter' ? tokenMeter
      : name === 'agentPresets' && options.agentPresets !== false ? agentPresets
        : name === 'systemPrompt' && options.systemPrompt === true ? systemPrompt : undefined,
    provide: () => {},
    on: (event: string, handler: StatusListener) => {
      if (event === 'agent/status') listener = handler
      return () => {}
    },
    effect: (setup: () => () => void) => { disposers.push(setup()) },
  } as never, config)
  closers.push(() => { for (const dispose of disposers.reverse()) dispose() })
  if (listener === undefined) throw new Error('agent/status listener missing')
  const statusListener = listener
  return {
    setCurrentContextTokens: (value: number) => { currentContextTokens = value },
    setCompactResult: (value: unknown) => { compactResult = value },
    setCompactFailure: (error: Error | undefined) => { compactFailure = error },
    idle: () => { statusListener({ agent, status: 'idle' }) },
    compactCalls: () => compactCalls,
    promptSections,
    settle: async () => { await Promise.resolve(); await Promise.resolve() },
  }
}

describe('task memory', () => {
  it('assembles ongoing plus relevant completed summaries and trims unrelated history', () => {
    const reader = new TaskMemoryReader(seed())
    try {
      const supervisor = reader.context({ projectId: 'p1', actorSessionId: 'sup' })
      expect(supervisor.ongoing.map(task => task.taskId)).toEqual(['t-ongoing'])
      expect(supervisor.completed.map(task => task.taskId)).toEqual(expect.arrayContaining(['t-done', 't-other']))
      expect(supervisor.rendered).toContain('已完成任务')
      expect(supervisor.rendered).not.toContain('跨项目任务')
      const employee = reader.context({ projectId: 'p1', actorSessionId: 'w1' })
      expect(employee.completed.map(task => task.taskId)).toEqual(['t-done'])
      expect(employee.rendered).not.toContain('别人任务')
    } finally {
      reader.close()
    }
  })

  it('searches summaries by id/name/keyword and refuses cross-project rows', () => {
    const reader = new TaskMemoryReader(seed())
    try {
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: 't-done' })
        .map(task => task.taskId)).toEqual(['t-done'])
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: '验收通过' })
        .map(task => task.taskId)).toEqual(['t-done'])
      expect(reader.search({
        projectId: 'p1', actorSessionId: 'sup', query: 't-done', includeSnippet: true,
      })[0]?.snippet).toContain('完成内容')
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: '跨项目' })).toEqual([])
      expect(reader.search({ projectId: 'p1', actorSessionId: 'w1', query: 't-other' })).toEqual([])
      expect(reader.search({ projectId: 'p2', actorSessionId: 'other', query: '跨项目' })).toHaveLength(1)
    } finally {
      reader.close()
    }
  })

  it('caps prompt memory and preserves constraints when over budget', () => {
    const text = `【进行中任务】\n- 任务：${'x'.repeat(5_000)}\n约束：不改 schema\n验收：pnpm test`
    const capped = capTaskMemory(text, 100)
    expect(capped).toContain('task memory truncated')
    expect(capped).toContain('约束：不改 schema')
    expect(capped).toContain('验收：pnpm test')
    expect(capTaskMemory('', 100)).toBe('')
    expect(capTaskMemory('短记忆', 100)).toBe('短记忆')
  })

  it('compacts once per new archive only while idle and at or above the configured context floor', () => {
    const gate = new TaskMemoryCompactionGate(60_000)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 59_999)).toBe(false)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 60_000)).toBe(true)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 60_001)).toBe(true)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'running', 60_001)).toBe(false)
    gate.markCompacted('s1', 't1')
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 60_001)).toBe(false)
    expect(gate.shouldCompact('s1', { updatedAt: 't2' }, 'idle', 60_000)).toBe(true)
    expect(gate.shouldCompact('s1', { updatedAt: 't2' }, 'idle', 60_001)).toBe(true)
  })

  it('honors a custom inclusive current-context floor without consulting cumulative usage', () => {
    const gate = new TaskMemoryCompactionGate(1_000)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 999)).toBe(false)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle', 1_000)).toBe(true)
    expect(gate.shouldCompact('s1', undefined, 'idle', 1_001)).toBe(false)
  })

  it('uses the default inclusive 60k current-context floor and compacts an archive only once', async () => {
    const mounted = mountCompaction()
    mounted.setCurrentContextTokens(59_999)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(0)
    mounted.setCurrentContextTokens(60_000)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(1)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(1)
  })

  it('reads a directly Agent-scoped engine when no preset registry is available', async () => {
    const mounted = mountCompaction({}, { agentPresets: false })
    mounted.setCurrentContextTokens(60_000)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(1)
  })

  it('applies the configured inclusive current-context floor at the plugin boundary', async () => {
    const mounted = mountCompaction({ taskMemoryCompactionThresholdTokens: 70_000 })
    mounted.setCurrentContextTokens(60_001)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(0)
    mounted.setCurrentContextTokens(70_000)
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(1)
  })

  it('retries a resolved compaction no-op until compactNow returns a result', async () => {
    const mounted = mountCompaction()
    mounted.setCurrentContextTokens(60_000)
    mounted.setCompactResult(null)
    mounted.idle()
    await mounted.settle()
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(2)
    mounted.setCompactResult({ compacted: true })
    mounted.idle()
    await mounted.settle()
    mounted.idle()
    await mounted.settle()
    expect(mounted.compactCalls()).toBe(3)
  })

  it('retries a failed archive compaction and marks only the successful settlement', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const mounted = mountCompaction()
      mounted.setCurrentContextTokens(60_000)
      mounted.setCompactFailure(new Error('injected compaction failure'))
      mounted.idle()
      await mounted.settle()
      mounted.idle()
      await mounted.settle()
      expect(mounted.compactCalls()).toBe(2)
      mounted.setCompactFailure(undefined)
      mounted.idle()
      await mounted.settle()
      mounted.idle()
      await mounted.settle()
      expect(mounted.compactCalls()).toBe(3)
    } finally {
      warning.mockRestore()
    }
  })

  it('registers task memory through an optional systemPrompt service', () => {
    const mounted = mountCompaction({}, { systemPrompt: true })
    expect(mounted.promptSections.map(section => section.name)).toEqual(['cadre/task-memory'])
    expect(mounted.promptSections[0]?.text({ scope: { session: { id: 'sup' } } })).toContain('已完成任务')
  })

  it('exposes the latest archive marker used by the compaction trigger', () => {
    const reader = new TaskMemoryReader(seed())
    try {
      expect(reader.latest('p1')?.updatedAt).toBe('2026-11-02T00:00:00.000Z')
      expect(reader.latest('missing')).toBeUndefined()
    } finally {
      reader.close()
    }
  })

  it('adds task_memory to an existing ledger without dropping rows', () => {
    const path = seed()
    const raw = new DatabaseSync(path)
    try {
      raw.exec('DROP INDEX IF EXISTS idx_task_memory_project; DROP TABLE task_memory')
    } finally {
      raw.close()
    }
    initCadreStore(path)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(check.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'task_memory'`).get()).toBeTruthy()
      expect((check.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count).toBe(4)
    } finally {
      check.close()
    }
  })
})

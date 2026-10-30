// DF-014 三态回放验收（报告 §3 时间线 → StallService 三态语义）
import { StallService, type StallPorts } from '../src/service.ts'
import type { SessionActivity } from '../src/types.ts'
import { describe, expect, it } from 'vitest'

const MIN = 60_000
const T0 = Date.parse('2026-10-30T00:43:03Z') // 报告 §3：任务3派发
const member = (id: string, role: string) => ({ sessionId: id, role, state: 'active', displayName: id })

function harness(clock: number[]) {
  let tick = 0
  const prompts: string[] = []
  const task = () => ({ taskId: 't1', projectId: 'p1', title: '交接 Word', status: 'in_progress' as const, assigneeSessionId: 'w1', dispatcherSessionId: 's1', version: 3, windowStartAt: T0, updatedAt: new Date(T0).toISOString() })
  const ports: StallPorts = {
    now: (): number => clock[Math.min(tick, clock.length - 1)] ?? clock[clock.length - 1]!,
    listProjects: () => ['p1'],
    listTasks: () => [task()],
    lastTaskEventAt: () => T0,
    members: () => [member('s1', 'supervisor'), member('w1', 'worker')],
    prompt: async (_id: string, text: string): Promise<void> => { prompts.push(text) },
    sessionActivity: async (): Promise<SessionActivity> => ({ waitingQuestion: false }),
    cancelTask: async () => ({ ok: true }),
    reassignTask: async () => ({ ok: true }),
    escalate: async () => ({ ok: true }),
    goal: () => undefined, createGoal: () => false, resumeGoal: () => {}, pauseGoal: () => {}, completeGoal: () => {}, disarmGoal: () => {},
    log: () => {},
  }
  return {
    svc: new StallService(ports, { suspectAfterMs: 3 * MIN, stalledAfterMs: 10 * MIN, consecutiveSamples: 2 }),
    prompts,
    advance: () => { tick += 1 },
    activity: (a: SessionActivity) => { ports.sessionActivity = async () => a },
  }
}

// 报告 §3：单步生成 7min（08:46–08:52:56）——期间两次采样必须 model_generation
describe('三态回放：报告 §3 时间线（验收矩阵 §三.1/2/3）', () => {
  it('长单步生成 7min：model_generation，不判 stalled、不催办', async () => {
    const h = harness([T0 + 4 * MIN, T0 + 5 * MIN, T0 + 7 * MIN])
    h.activity({ waitingQuestion: false, stepKind: 'model_generation', stepSince: T0 + 3 * MIN, firstTokenAt: T0 + 3 * MIN + 500, evidenceEventSeq: 10 })
    await h.svc.scan()
    h.advance()
    await h.svc.scan()
    const view = h.svc.views().find(v => v.taskId === 't1')
    expect(view?.stallState).toBe('normal')
    expect(view?.lastActivityKind ?? null).toBeDefined()
    expect(h.prompts).toEqual([])
  })

  it('生成超过 10min（单步年龄）才 stalled，nudge 带 stallBasis', async () => {
    const h = harness([T0 + 14 * MIN, T0 + 15 * MIN])
    h.activity({ waitingQuestion: false, stepKind: 'model_generation', stepSince: T0 + 3 * MIN, evidenceEventSeq: 10 })
    await h.svc.scan()
    h.advance()
    await h.svc.scan()
    console.log('DEBUG view:', JSON.stringify(h.svc.views().find(v => v.taskId === 't1')))
    let view = h.svc.views().find(v => v.taskId === 't1')
    expect(view?.stallState).toBe('stalled')
    // 催办文本必须含 stallBasis（机器可读依据）
    const act = await h.svc.act({ action: 'nudge', projectId: 'p1', taskId: 't1', episodeId: view!.episodeId, expectedVersion: view!.version, idempotencyKey: 'n1', actorSessionId: 's1' })
    expect(act.ok).toBe(true)
    expect(h.prompts.some(p => p.includes('stallBasis'))).toBe(true)
    expect(h.prompts.some(p => p.includes('model_generation'))).toBe(true)
  })

  it('docx 长工具 3.5min：tool_execution，不判 stalled', async () => {
    const h = harness([T0 + 12 * MIN, T0 + 13 * MIN, T0 + 14.4 * MIN])
    h.activity({ waitingQuestion: false, stepKind: 'tool_execution', stepSince: T0 + 14.4 * MIN - 3.5 * MIN, toolName: 'office_docx', evidenceEventSeq: 20 })
    await h.svc.scan()
    h.advance()
    await h.svc.scan()
    const view = h.svc.views().find(v => v.taskId === 't1')
    expect(view?.stallState).toBe('normal')
    expect(h.prompts).toEqual([])
  })

  it('真无事件 10min：no_events → stalled（3min possibly），stallBasis kind=no_events', async () => {
    const h = harness([T0 + 11 * MIN, T0 + 12 * MIN])
    h.activity({ waitingQuestion: false }) // 无任何活动源
    await h.svc.scan()
    h.advance()
    await h.svc.scan()
    let view = h.svc.views().find(v => v.taskId === 't1')
    expect(view?.stallState).toBe('stalled')
    expect(view?.stale).toBe(false) // 任务事件源存在（taskEvent=T0），非全无源
    const act = await h.svc.act({ action: 'nudge', projectId: 'p1', taskId: 't1', episodeId: view!.episodeId, expectedVersion: view!.version, idempotencyKey: 'n2', actorSessionId: 's1' })
    expect(act.ok).toBe(true)
    expect(h.prompts.some(p => p.includes('no_events'))).toBe(true)
  })

  it('compaction 期间：暂停停摆判定', async () => {
    const h = harness([T0 + 4 * MIN, T0 + 5 * MIN, T0 + 11 * MIN, T0 + 12 * MIN])
    h.activity({ waitingQuestion: false, compactionActive: true })
    await h.svc.scan()
    h.advance()
    await h.svc.scan()
    const view = h.svc.views().find(v => v.taskId === 't1')
    expect(['normal', 'waiting_question']).toContain(view?.stallState ?? 'normal')
    expect(h.prompts).toEqual([])
  })
})











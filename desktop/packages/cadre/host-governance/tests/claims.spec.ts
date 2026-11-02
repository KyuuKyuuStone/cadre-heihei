import { describe, expect, it } from 'vitest'
import { ClaimVerifier, extractTaskIds, type ClaimRecord } from '../src/claims.ts'
import type { WatchMember, WatchTask } from '../src/types.ts'

const task = (id: string, overrides: Partial<WatchTask> = {}): WatchTask => ({
  taskId: id,
  projectId: 'p1',
  title: '任务',
  status: 'dispatched',
  assigneeSessionId: 'w1',
  dispatcherSessionId: 's1',
  version: 1,
  updatedAt: '2026-11-02T00:00:00.000Z',
  windowStartAt: 1,
  ...overrides,
})

const member = (sessionId: string, displayName: string, overrides: Partial<WatchMember> = {}): WatchMember => ({
  sessionId, role: 'worker', state: 'available', displayName, ...overrides,
})

const assistant = (text: string, seq = 1): { type: string; seq: number; data: unknown } => ({
  type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } },
})

function harness(options: { tasks?: WatchTask[]; members?: WatchMember[] } = {}): {
  verifier: ClaimVerifier
  records: ClaimRecord[]
  tasks: Map<string, WatchTask>
  fire(): void
} {
  const tasks = new Map((options.tasks ?? []).map(item => [item.taskId, item]))
  const members = options.members ?? [member('w1', '小王'), member('w2', '小李')]
  const records: ClaimRecord[] = []
  let timer: (() => void) | undefined
  const verifier = new ClaimVerifier({
    projectOf: sessionId => sessionId === 's1' ? 'p1' : undefined,
    ledger: {
      task: id => tasks.get(id),
      members: () => members,
    },
    appendAudit: record => { records.push(record) },
    setTimer: callback => { timer = callback; return 1 },
    clearTimer: () => {},
    pollMs: 15_000,
    now: () => Date.parse('2026-11-02T00:00:00.000Z'),
  })
  return { verifier, records, tasks, fire: () => timer?.() }
}

describe('claim verifier', () => {
  it('marks a matching dispatched task verified and audits without message text', () => {
    const id = '13e8f2c7-59fb-4b50-a017-7dacbab77e81'
    const h = harness({ tasks: [task(id)] })
    h.verifier.handle('s1', assistant(`已派任务 ${id} 给小王，请处理`))
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({
      verdict: 'verified', exists: true, assigneeMatch: true, taskIds: [id], pending: false,
    })
    expect(JSON.stringify(h.records)).not.toContain('请处理')
    expect(JSON.stringify(h.records)).not.toContain('给小王')
    expect(h.verifier.snapshot('p1')).toHaveLength(1)
    expect(h.verifier.snapshot('p2')).toHaveLength(0)
  })

  it('marks missing tasks unverified and upgrades after a later poll', () => {
    const id = 'deadbeefdeadbeef'
    const h = harness()
    h.verifier.handle('s1', assistant(`已安排 ${id}`))
    expect(h.records[0]).toMatchObject({ verdict: 'unverified', exists: false, pending: true, reason: 'missing' })
    h.tasks.set(id, task(id))
    h.fire()
    expect(h.records.at(-1)).toMatchObject({
      verdict: 'verified', exists: true, pending: false, upgraded: true, taskIds: [id],
    })
  })

  it('marks wrong assignee and historical/cross-project tasks correctly', () => {
    const wrong = 'aaaaaaaaaaaaaaaa'
    const historical = 'bbbbbbbbbbbbbbbb'
    const cross = 'cccccccccccccccc'
    const h = harness({
      tasks: [
        task(wrong, { assigneeSessionId: 'w2' }),
        task(historical, { status: 'verified' }),
        task(cross, { projectId: 'p2' }),
      ],
    })
    h.verifier.handle('s1', assistant(`已派 ${wrong} 给小王`))
    expect(h.records.at(-1)).toMatchObject({ verdict: 'unverified', reason: 'assignee' })
    h.verifier.handle('s1', assistant(`已交给 ${historical}`, 2))
    expect(h.records.at(-1)).toMatchObject({ verdict: 'historical', reason: 'terminal' })
    h.verifier.handle('s1', assistant(`已分配 ${cross}`, 3))
    expect(h.records.at(-1)).toMatchObject({ verdict: 'historical', reason: 'cross_project' })
  })

  it('ignores messages without a claim and records claims without task ids', () => {
    const h = harness()
    h.verifier.handle('s1', assistant('今天讨论一下任务安排'))
    expect(h.records).toHaveLength(0)
    h.verifier.handle('s1', assistant('已派给小王'))
    expect(h.records[0]).toMatchObject({ verdict: 'unverified', taskIds: [], reason: 'no_task_id' })
    expect(extractTaskIds('t12 13e8f2c7-59fb-4b50-a017-7dacbab77e81')).toEqual([
      't12', '13e8f2c7-59fb-4b50-a017-7dacbab77e81',
    ])
  })
})

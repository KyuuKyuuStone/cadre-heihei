import { describe, expect, it } from 'vitest'
import { StallService, type StallPorts } from '../src/service.ts'
import type { SessionActivity, WatchTask } from '../src/types.ts'

const MIN = 60_000
const BASE = Date.UTC(2026, 10, 18, 1, 0, 0)

function harness(initialActivityAt: number) {
  let now = BASE
  let activity: SessionActivity = {
    lastActivityAt: initialActivityAt,
    kind: 'tool',
    waitingQuestion: false,
  }
  const prompts: string[] = []
  const task: WatchTask = {
    taskId: 't1', projectId: 'p1', title: '执行任务', status: 'in_progress',
    assigneeSessionId: 'worker', dispatcherSessionId: 'supervisor', version: 1,
    updatedAt: new Date(initialActivityAt).toISOString(), windowStartAt: initialActivityAt,
  }
  const ports: StallPorts = {
    now: () => now,
    listProjects: () => ['p1'],
    listTasks: () => [task],
    lastTaskEventAt: () => initialActivityAt,
    sessionActivity: async () => activity,
    members: () => [
      { sessionId: 'supervisor', role: 'supervisor', state: 'available', displayName: '组长' },
      { sessionId: 'worker', role: 'worker', state: 'available', displayName: '员工' },
    ],
    prompt: async (_sessionId, text) => { prompts.push(text) },
    cancelTask: async () => ({ ok: true }),
    reassignTask: async () => ({ ok: true }),
    escalate: async () => ({ ok: true }),
    goal: () => undefined,
    createGoal: () => false,
    resumeGoal: () => {},
    pauseGoal: () => {},
    completeGoal: () => {},
    disarmGoal: () => {},
    log: () => {},
  }
  return {
    service: new StallService(ports, { scanIntervalMs: 15_000, consecutiveSamples: 2 }),
    prompts,
    setNow: (value: number) => { now = value },
    setActivity: (value: SessionActivity) => { activity = value },
  }
}

describe('supervisor queue notifications', () => {
  it('does not queue model work for a transient warning and recovery', async () => {
    const h = harness(BASE - 2 * MIN)
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('possibly_stalled')

    const activeAt = BASE + 30_000
    h.setNow(activeAt)
    h.setActivity({ lastActivityAt: activeAt, kind: 'assistant', waitingQuestion: false })
    await h.service.scan()
    h.setNow(activeAt + 30_000)
    await h.service.scan()

    console.log(`METRIC transient_prompt_calls=${h.prompts.length}`)
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.prompts).toEqual([])
  })

  it('keeps confirmed stall and recovery notifications', async () => {
    const h = harness(BASE - 15 * MIN)
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')

    const activeAt = BASE + 30_000
    h.setNow(activeAt)
    h.setActivity({ lastActivityAt: activeAt, kind: 'assistant', waitingQuestion: false })
    await h.service.scan()
    h.setNow(activeAt + 30_000)
    await h.service.scan()

    console.log(`METRIC confirmed_prompt_calls=${h.prompts.length}`)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[0]).toContain('已停摆')
    expect(h.prompts[1]).toContain('已恢复活动')
  })
})

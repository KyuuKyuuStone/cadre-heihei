import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { StallService, type StallPorts } from '../src/service.ts'
import type {
  GoalState,
  SessionActivity,
  StallActionRequest,
  StallConfig,
  WatchMember,
  WatchTask,
} from '../src/types.ts'

const PROJECT = 'p1'
const SUP = 'sup'
const WORKER = 'w1'
const MIN = 60_000

interface Harness {
  readonly service: StallService
  readonly prompts: { sessionId: string; text: string }[]
  readonly goals: string[]
  readonly goalRequests: { objective: string; maxGoalRounds: number }[]
  readonly escalations: string[]
  readonly actions: string[]
  setNow(value: number): void
  setActivity(value: SessionActivity): void
  tasks: WatchTask[]
  goal: GoalState | undefined
  supervisorPresent: boolean
}

function task(overrides: Partial<WatchTask> = {}): WatchTask {
  return {
    taskId: 't1', projectId: PROJECT, title: '修复登录', status: 'in_progress',
    assigneeSessionId: WORKER, dispatcherSessionId: SUP, version: 3,
    updatedAt: new Date(Date.now() - 15 * MIN).toISOString(),
    windowStartAt: Date.now() - 15 * MIN, ...overrides,
  }
}

function harness(options: {
  readonly tasks?: WatchTask[]
  readonly config?: Partial<StallConfig>
  readonly members?: WatchMember[]
  readonly taskEventAt?: number | undefined
} = {}): Harness {
  let now = Date.UTC(2026, 9, 29, 12, 0, 0)
  let activity: SessionActivity = { lastActivityAt: now - 15 * MIN, kind: 'tool', waitingQuestion: false }
  const taskEventAt = 'taskEventAt' in options ? options.taskEventAt : now - 15 * MIN
  let tasks = options.tasks ?? [task()]
  let goal: GoalState | undefined
  let supervisorPresent = true
  const prompts: { sessionId: string; text: string }[] = []
  const goals: string[] = []
  const goalRequests: { objective: string; maxGoalRounds: number }[] = []
  const escalations: string[] = []
  const actions: string[] = []
  const members: WatchMember[] = options.members ?? [
    { sessionId: SUP, role: 'supervisor', state: 'available', displayName: '主管' },
    { sessionId: WORKER, role: 'worker', state: 'available', displayName: '小明' },
  ]
  const ports: StallPorts = {
    now: () => now,
    listProjects: () => [PROJECT],
    listTasks: () => tasks,
    lastTaskEventAt: () => taskEventAt,
    sessionActivity: async () => activity,
    members: () => supervisorPresent
      ? members
      : members.filter(member => member.role !== 'supervisor'),
    prompt: async (sessionId, text) => { prompts.push({ sessionId, text }) },
    cancelTask: async (input) => {
      actions.push('cancel')
      tasks = tasks.map(task => task.taskId === input.taskId ? { ...task, version: task.version + 1 } : task)
      return { ok: true }
    },
    reassignTask: async (input) => {
      actions.push(`reassign:${input.toSessionId}`)
      tasks = tasks.map(task => task.taskId === input.taskId ? { ...task, version: task.version + 1 } : task)
      return { ok: true }
    },
    escalate: async () => { escalations.push('escalate'); return { ok: true } },
    goal: () => goal,
    createGoal: (_projectId, objective, maxGoalRounds) => {
      if (!supervisorPresent) return false
      goals.push('create')
      goalRequests.push({ objective, maxGoalRounds })
      goal = { id: 'g1', revision: 1, phase: 'active', activation: 'armed' }
      return true
    },
    resumeGoal: () => { goals.push('resume'); if (goal !== undefined) goal = { ...goal, phase: 'active', activation: 'armed' } },
    pauseGoal: () => { goals.push('pause'); if (goal !== undefined) goal = { ...goal, phase: 'paused', activation: 'disarmed' } },
    completeGoal: () => { goals.push('complete'); if (goal !== undefined) goal = { ...goal, phase: 'complete', activation: 'disarmed' } },
    disarmGoal: () => { goals.push('disarm') },
    log: () => {},
  }
  return {
    service: new StallService(ports, { scanIntervalMs: 1, ...options.config }),
    prompts, goals, goalRequests, escalations, actions,
    setNow: value => { now = value },
    setActivity: value => { activity = value },
    get tasks() { return tasks },
    set tasks(value: WatchTask[]) { tasks = value },
    get goal() { return goal },
    get supervisorPresent() { return supervisorPresent },
    set supervisorPresent(value: boolean) { supervisorPresent = value },
  }
}

function request(harness: Harness, overrides: Partial<StallActionRequest> = {}): StallActionRequest {
  const view = harness.service.views()[0]
  if (view === undefined) throw new Error('no view')
  return {
    action: 'nudge', projectId: PROJECT, taskId: view.taskId, episodeId: view.episodeId,
    expectedVersion: view.version, actorSessionId: SUP, idempotencyKey: 'k1', ...overrides,
  }
}

async function stalled(): Promise<Harness> {
  const h = harness()
  await h.service.scan()
  await h.service.scan()
  return h
}

describe('stall detection', () => {
  it('flags a silent worker after two samples and notifies the supervisor once', async () => {
    const h = harness()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    await h.service.scan()
    const view = h.service.views()[0]
    expect(view).toMatchObject({ stallState: 'stalled', assigneeName: '小明', nudgeCount: 0 })
    expect(view).toMatchObject({
      elapsedMs: null,
      heartbeatAt: null,
      firstTokenAt: null,
      tokensSoFar: null,
      stallBasis: { kind: 'no_events', stepKind: null, toolName: null, elapsedMs: 15 * MIN },
    })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.sessionId).toBe(SUP)
    expect(h.prompts[0]?.text).toContain('已停摆')
    expect(h.prompts[0]?.text).toContain(view?.episodeId ?? '')
    // A third scan in the same state must not notify again.
    await h.service.scan()
    expect(h.prompts).toHaveLength(1)
  })

  it('never flags delivered or review after 20 minutes of silence', async () => {
    const h = harness({ tasks: [task({ taskId: 't2', status: 'delivered' }), task({ taskId: 't3', status: 'review' })] })
    h.setNow(Date.UTC(2026, 9, 29, 12, 20, 0))
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views().map(view => view.stallState)).toEqual(['normal', 'normal'])
    expect(h.prompts).toEqual([])
  })

  it('does not escalate on a single silent sample (consecutiveSamples=2)', async () => {
    const h = harness()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.prompts).toEqual([])
  })

  it('documents the consecutiveSamples break lever: 1 makes a single scan stall', async () => {
    const h = harness({ config: { consecutiveSamples: 1 } })
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')
    expect(h.prompts).toHaveLength(1)
  })

  it('keeps stale views non-actionable when no activity source exists', async () => {
    const h = harness({ taskEventAt: undefined })
    h.setActivity({ waitingQuestion: false })
    await h.service.scan()
    await h.service.scan()
    const view = h.service.views()[0]
    expect(view).toMatchObject({
      stallState: 'normal',
      stale: true,
      suggestedAction: null,
      capabilities: { nudge: false, reassign: false, cancel: false, escalate: false },
    })
    expect(h.prompts).toEqual([])
  })

  it('notifies once per level and never repeats while the state is unchanged', async () => {
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({ lastActivityAt: base - 5 * MIN, kind: 'tool', waitingQuestion: false })
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('possibly_stalled')
    await h.service.scan()
    expect(h.prompts).toHaveLength(1)

    h.setNow(base + 8 * MIN)
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')
    expect(h.prompts).toHaveLength(2)
    await h.service.scan()
    expect(h.prompts).toHaveLength(2)
  })

  it('treats an unanswered ask_user_question as waiting, not stalled', async () => {
    const h = harness()
    h.setActivity({ lastActivityAt: Date.UTC(2026, 9, 29, 11, 45, 0), kind: 'tool', waitingQuestion: true })
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('waiting_question')
    expect(h.prompts).toEqual([])
    expect(h.goals).toEqual([])
  })

  it('does not flag a 7-minute model generation step, and escalates only past 10 minutes', async () => {
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({
      lastActivityAt: base - 7 * MIN, kind: 'assistant', waitingQuestion: false,
      stepKind: 'model_generation', stepSince: base - 7 * MIN,
    })
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.service.views()[0]).toMatchObject({
      elapsedMs: 7 * MIN,
      heartbeatAt: base,
      firstTokenAt: null,
      tokensSoFar: null,
      inferred: false,
      stallBasis: {
        kind: 'model_generation', stepKind: 'model_generation', toolName: null,
        elapsedMs: 7 * MIN, heartbeatAgeMs: 0,
      },
    })
    expect(h.prompts).toEqual([])

    h.setNow(base + 4 * MIN)
    h.setActivity({
      lastActivityAt: base + 4 * MIN - 11 * MIN, kind: 'assistant', waitingQuestion: false,
      stepKind: 'model_generation', stepSince: base + 4 * MIN - 11 * MIN,
    })
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')
    const nudged = await h.service.act(request(h))
    expect(nudged).toMatchObject({ ok: true, action: 'nudge' })
    expect(h.prompts.at(-1)?.text).toContain('stallBasis')
  })

  it('treats a 3.5-minute tool execution as normal, not stalled', async () => {
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({
      lastActivityAt: base - 3.5 * MIN, kind: 'tool', waitingQuestion: false,
      stepKind: 'tool_execution', stepSince: base - 3.5 * MIN, toolName: 'docx_build',
    })
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.service.views()[0]).toMatchObject({
      elapsedMs: 3.5 * MIN,
      stallBasis: { kind: 'tool_execution', stepKind: 'tool_execution', toolName: 'docx_build' },
    })
    expect(h.prompts).toEqual([])
  })

  it('exposes the same fields as the shared front-end contract fixture', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/stall-view-contract.json', import.meta.url), 'utf8')) as {
      generation: Record<string, unknown>
      tool: Record<string, unknown>
    }
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({
      lastActivityAt: base - 7 * MIN, kind: 'assistant', waitingQuestion: false,
      stepKind: 'model_generation', stepSince: base - 7 * MIN,
    })
    await h.service.scan()
    expect(h.service.views()[0]).toMatchObject(fixture.generation)

    h.setActivity({
      lastActivityAt: base - 3.5 * MIN, kind: 'tool', waitingQuestion: false,
      stepKind: 'tool_execution', stepSince: base - 3.5 * MIN, toolName: 'docx_build',
    })
    await h.service.scan()
    expect(h.service.views()[0]).toMatchObject(fixture.tool)
  })

  it('recovers once a long generation is followed by a normal step', async () => {
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({
      lastActivityAt: base - 7 * MIN, kind: 'assistant', waitingQuestion: false,
      stepKind: 'model_generation', stepSince: base - 7 * MIN,
    })
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
  })

  it('marks an old log without additive events as inferred and leaves lifecycle fields null', async () => {
    const h = harness()
    const base = Date.UTC(2026, 9, 29, 12, 0, 0)
    h.setNow(base)
    h.setActivity({ lastActivityAt: base - 15 * MIN, kind: 'assistant', waitingQuestion: false, inferred: true })
    await h.service.scan()
    expect(h.service.views()[0]).toMatchObject({
      inferred: true, firstTokenAt: null, tokensSoFar: null, heartbeatAt: null,
      stallBasis: { kind: 'no_events', stepKind: null },
    })
  })

  it('recovers only after the activity stays normal for recoverAfterMs', async () => {
    const h = harness()
    await h.service.scan()
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')

    const stalledEpisode = h.service.views()[0]?.episodeId
    const activeAt = Date.UTC(2026, 9, 29, 12, 0, 30)
    h.setNow(activeAt)
    h.setActivity({ lastActivityAt: activeAt, kind: 'assistant', waitingQuestion: false })
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled') // window starts, warning stays
    expect(h.service.views()[0]?.episodeId).toBe(stalledEpisode)
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(0)

    h.setNow(activeAt + 15_000)
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')
    expect(h.service.views()[0]?.episodeId).toBe(stalledEpisode)
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(0)

    h.setNow(activeAt + 30_000)
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.service.views()[0]?.episodeId).not.toBe(stalledEpisode)
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(1)
  })

  it('cancels a recovery window when activity stops again before 30s', async () => {
    const h = harness()
    await h.service.scan()
    await h.service.scan()
    const activeAt = Date.UTC(2026, 9, 29, 12, 0, 30)
    h.setNow(activeAt)
    h.setActivity({ lastActivityAt: activeAt, kind: 'tool', waitingQuestion: false })
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')

    // No new activity; the silence crosses the suspect threshold before the window closes.
    h.setNow(activeAt + 4 * MIN)
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('stalled')
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(0)

    // Fresh activity that stays normal for the full window recovers exactly once.
    const again = activeAt + 5 * MIN
    h.setNow(again)
    h.setActivity({ lastActivityAt: again, kind: 'assistant', waitingQuestion: false })
    await h.service.scan()
    h.setNow(again + 30_000)
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(1)
  })

  it('honors a configured recoverAfterMs of zero', async () => {
    const h = harness({ config: { recoverAfterMs: 0 } })
    await h.service.scan()
    await h.service.scan()
    const activeAt = Date.UTC(2026, 9, 29, 12, 0, 30)
    h.setNow(activeAt)
    h.setActivity({ lastActivityAt: activeAt, kind: 'assistant', waitingQuestion: false })
    await h.service.scan()
    expect(h.service.views()[0]?.stallState).toBe('normal')
    expect(h.prompts.filter(prompt => prompt.text.includes('已恢复'))).toHaveLength(1)
  })
})

describe('goal lifecycle', () => {
  it('creates one project goal when stalled, pauses for delivered/review, completes when empty', async () => {
    const h = harness()
    await h.service.scan()
    await h.service.scan()
    expect(h.goals).toEqual(['create'])

    h.tasks = [task({ status: 'delivered' })]
    await h.service.scan()
    expect(h.goals).toContain('pause')

    h.tasks = []
    await h.service.scan()
    expect(h.goals).toContain('complete')
  })

  it('passes the configured maxGoalRounds into the goal request', async () => {
    const h = harness({ config: { maxGoalRounds: 3 } })
    await h.service.scan()
    await h.service.scan()
    expect(h.goalRequests).toEqual([{
      objective: '推进本项目所有未结任务到 verified；遇到验收、发布授权或外部依赖时停下并在会话里说明。',
      maxGoalRounds: 3,
    }])
  })

  it('never creates a goal without a live supervisor', async () => {
    const h = harness()
    h.supervisorPresent = false
    await h.service.scan()
    await h.service.scan()
    expect(h.prompts).toEqual([])
    expect(h.goals).toEqual([])
  })
})

describe('supervisor actions', () => {
  it('nudges, reports cooldown, and replays the same idempotency key', async () => {
    const h = await stalled()
    const original = request(h)
    const first = await h.service.act(original)
    expect(first).toMatchObject({ ok: true, action: 'nudge' })
    expect(h.prompts.at(-1)?.sessionId).toBe(WORKER)
    const replay = await h.service.act(original)
    expect(replay).toMatchObject({ ok: true, replayed: true })

    const cooldown = await h.service.act(request(h, { idempotencyKey: 'k2', expectedVersion: (first as { version: number }).version }))
    expect(cooldown).toMatchObject({ ok: false, code: 'NUDGE_COOLDOWN' })
  })

  it('rejects stale versions, workers, and unknown episodes', async () => {
    const h = await stalled()
    expect(await h.service.act(request(h, { expectedVersion: 1, idempotencyKey: 'stale' })))
      .toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    expect(await h.service.act(request(h, { actorSessionId: WORKER, idempotencyKey: 'perm' })))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(await h.service.act(request(h, { episodeId: 'other', idempotencyKey: 'ep' })))
      .toMatchObject({ ok: false, code: 'STALL_ALREADY_RECOVERED' })
  })

  it('rejects a supervisor from another project and an unknown project', async () => {
    const h = await stalled()
    expect(await h.service.act(request(h, { actorSessionId: 'sup-other', idempotencyKey: 'cross' })))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(await h.service.act(request(h, { projectId: 'p2', idempotencyKey: 'cross-project' })))
      .toMatchObject({ ok: false, code: 'TASK_NOT_FOUND' })
  })

  it('reassigns only to an active worker and requires a reason', async () => {
    const h = await stalled()
    expect(await h.service.act(request(h, { action: 'reassign', toSessionId: SUP, reason: 'x', idempotencyKey: 'r1' })))
      .toMatchObject({ ok: false, code: 'REASSIGN_TARGET_INVALID' })
    expect(await h.service.act(request(h, { action: 'reassign', toSessionId: WORKER, idempotencyKey: 'r2' })))
      .toMatchObject({ ok: false, code: 'REASSIGN_TARGET_INVALID' })
    expect(await h.service.act(request(h, { action: 'reassign', toSessionId: WORKER, reason: '换人', idempotencyKey: 'r3' })))
      .toMatchObject({ ok: true, action: 'reassign' })
    expect(h.actions).toContain(`reassign:${WORKER}`)
  })

  it('cancels with a reason and escalates after the escalation window', async () => {
    const h = await stalled()
    expect(await h.service.act(request(h, { action: 'cancel', idempotencyKey: 'c1' })))
      .toMatchObject({ ok: false, code: 'CANCEL_NOT_ALLOWED' })
    expect(await h.service.act(request(h, { action: 'cancel', reason: '任务取消', idempotencyKey: 'c2' })))
      .toMatchObject({ ok: true, action: 'cancel' })

    const h2 = await stalled()
    await h2.service.act(request(h2))
    h2.setNow(Date.UTC(2026, 9, 29, 12, 40, 0))
    await h2.service.scan()
    expect(h2.escalations).toEqual(['escalate'])
    await h2.service.scan()
    expect(h2.escalations).toEqual(['escalate'])
  })
})

describe('stall view contract', () => {
  it('exposes the task row version, not an episode-local counter', async () => {
    const h = harness()
    await h.service.scan()
    await h.service.scan()
    const view = h.service.views()[0]
    expect(view?.version).toBe(3)
    expect(view?.version).toBe(h.tasks[0]?.version)
    // State transitions (normal → stalled) must not advance the CAS version.
    expect(view?.stallState).toBe('stalled')
    expect(view?.version).toBe(3)
  })

  it('accepts the current task version, rejects a stale one, and bumps the row on cancel', async () => {
    const h = await stalled()
    const view = h.service.views()[0]
    if (view === undefined) throw new Error('no view')
    expect(await h.service.act(request(h, { expectedVersion: view.version - 1, idempotencyKey: 'stale' })))
      .toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    const nudged = await h.service.act(request(h, { expectedVersion: view.version, idempotencyKey: 'nudge-v' }))
    expect(nudged).toMatchObject({ ok: true, action: 'nudge', version: view.version })
    expect(h.tasks[0]?.version).toBe(view.version)

    const cancelled = await h.service.act(request(h, {
      action: 'cancel', expectedVersion: view.version, reason: '停摆取消', idempotencyKey: 'cancel-v',
    }))
    expect(cancelled).toMatchObject({ ok: true, action: 'cancel', version: view.version + 1 })
    expect(h.tasks[0]?.version).toBe(view.version + 1)
  })
  it('exposes front-end fields with a real activity timestamp', async () => {
    const h = await stalled()
    const view = h.service.views()[0]
    expect(view).toMatchObject({
      stallState: 'stalled',
      lastActivityKind: 'tool',
      capabilities: { nudge: true, reassign: true, cancel: true, escalate: true },
      suggestedAction: 'nudge',
      version: expect.any(Number),
      episodeId: expect.stringContaining('t1:'),
    })
    expect(view?.lastActivityAt).toBe(Date.UTC(2026, 9, 29, 11, 45, 0))
  })
})

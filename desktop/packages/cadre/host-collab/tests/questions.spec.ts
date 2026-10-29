import { describe, expect, it } from 'vitest'
import {
  QuestionRouter,
  DEFAULT_QUESTION_TIMEOUT_MS,
  type QuestionPorts,
  type ResolveRequest,
  type RoutedRequest,
} from '../src/questions.ts'

const MIN = 60_000

function request(overrides: Partial<RoutedRequest> = {}): RoutedRequest {
  return {
    questions: [{
      id: 'q1', question: '选哪个方案？', header: '方案',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
    ...overrides,
  }
}

function answer(value = 'A'): ResolveRequest {
  return { questionId: 'call-1', action: 'answer', answers: [{ id: 'q1', selected: [value] }] }
}

function harness(options: {
  readonly role?: 'worker' | 'supervisor'
  readonly dispatcher?: string
  readonly supervisorPresent?: boolean
  readonly timeoutMs?: number
  readonly maxPending?: number
} = {}) {
  const members = new Map([
    ['w1', { projectId: 'p1', role: 'worker', state: 'available' }],
    ['sup', { projectId: 'p1', role: 'supervisor', state: 'available' }],
    ['sup-p1', { projectId: 'p1', role: 'supervisor', state: 'available' }],
    ['sup2', { projectId: 'p2', role: 'supervisor', state: 'available' }],
  ])
  if (options.role === 'supervisor') members.set('w1', { projectId: 'p1', role: 'supervisor', state: 'available' })
  const prompts: { sessionId: string; text: string }[] = []
  let now = Date.UTC(2026, 10, 2, 9, 0, 0)
  let timerSeq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const ports: QuestionPorts = {
    member: sessionId => members.get(sessionId),
    openTask: () => options.dispatcher === undefined
      ? { taskId: 't1', title: '实现登录' }
      : { taskId: 't1', title: '实现登录', dispatcherSessionId: options.dispatcher },
    supervisor: projectId => (options.supervisorPresent === false ? undefined : `sup-${projectId}`),
    name: (_projectId, sessionId) => sessionId === 'w1' ? '小明' : sessionId,
    prompt: async (sessionId, text) => { prompts.push({ sessionId, text }) },
    log: () => {},
    now: () => now,
    newId: () => `id-${String(++timerSeq)}`,
    setTimer: (callback, delayMs) => {
      const handle = ++timerSeq
      timers.set(handle, { at: now + delayMs, callback })
      return handle
    },
    clearTimer: handle => { timers.delete(handle as number) },
  }
  const router = new QuestionRouter(ports, {
    timeoutMs: options.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
    maxPendingPerWorker: options.maxPending ?? 20,
  })
  const advance = async (ms: number): Promise<void> => {
    now += ms
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle)
        timer.callback()
      }
    }
    await Promise.resolve()
    await Promise.resolve()
  }
  return { router, prompts, advance, timers }
}

function workerRequest(): RoutedRequest {
  return request({ agent: { id: 'w1' }, wait: { callId: 'call-1' } })
}

describe('employee question routing', () => {
  it('intercepts a worker question and routes it to the task dispatcher', async () => {
    const h = harness({ dispatcher: 'sup-p1' })
    const pending = h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.sessionId).toBe('sup-p1')
    expect(h.prompts[0]?.text).toContain('call-1')
    expect(h.prompts[0]?.text).toContain('小明')
    expect((await h.router.resolve(answer(), 'sup-p1')).ok).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('falls back to the project supervisor when there is no dispatcher', async () => {
    const h = harness({ supervisorPresent: true })
    void h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(h.prompts[0]?.sessionId).toBe('sup-p1')
  })

  it('leaves supervisor and unknown sessions on the official path', async () => {
    const h = harness()
    expect(await h.router.intercept(workerRequest(), 'sup')).toBeUndefined()
    expect(await h.router.intercept(workerRequest(), 'stranger')).toBeUndefined()
    expect(h.prompts).toEqual([])
  })

  it('fails visibly when no supervisor can be resolved', async () => {
    const h = harness({ supervisorPresent: false })
    await expect(h.router.intercept(workerRequest(), 'w1')).rejects.toThrow('CADRE_NO_SUPERVISOR')
  })

  it('escalates once after the timeout and still accepts a late answer', async () => {
    const h = harness()
    const pending = h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(h.prompts).toHaveLength(1)
    await h.advance(30 * MIN)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]?.text).toContain('超时升级')
    await h.advance(30 * MIN)
    expect(h.prompts).toHaveLength(2)
    expect((await h.router.resolve(answer(), 'sup-p1')).ok).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
  })

  it('supports an explicit supervisor escalation without dropping the question', async () => {
    const h = harness()
    const pending = h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    const escalated = await h.router.resolve({ questionId: 'call-1', action: 'escalate' }, 'sup-p1')
    expect(escalated).toMatchObject({ ok: true, state: 'escalated' })
    expect(h.prompts.at(-1)?.text).toContain('升级给用户')
    expect((await h.router.resolve(answer(), 'sup-p1')).ok).toBe(true)
    await expect(pending).resolves.toBeDefined()
  })

  it('rejects non-supervisors and cross-project supervisors', async () => {
    const h = harness()
    void h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(await h.router.resolve(answer(), 'w1')).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })
    expect(await h.router.resolve(answer(), 'sup2')).toMatchObject({ ok: false, code: 'CROSS_PROJECT_DENIED' })
  })

  it('requires a complete answer batch with valid option labels', async () => {
    const h = harness()
    void h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(await h.router.resolve({ questionId: 'call-1', action: 'answer', answers: [] }, 'sup-p1'))
      .toMatchObject({ ok: false, code: 'BAD_ANSWER' })
    expect(await h.router.resolve(answer('C'), 'sup-p1'))
      .toMatchObject({ ok: false, code: 'BAD_ANSWER' })
    expect(await h.router.resolve(answer(), 'sup-p1')).toMatchObject({ ok: true, state: 'answered' })
    // Replay of a settled question does not resolve twice.
    expect(await h.router.resolve(answer(), 'sup-p1')).toMatchObject({ ok: true, replayed: true })
  })

  it('rejects with a reason and cancels on abort', async () => {
    const h = harness()
    const pending = h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    expect(await h.router.resolve({ questionId: 'call-1', action: 'reject' }, 'sup-p1'))
      .toMatchObject({ ok: false, code: 'REJECT_REASON_REQUIRED' })
    expect(await h.router.resolve({ questionId: 'call-1', action: 'reject', reason: '自己决定' }, 'sup-p1'))
      .toMatchObject({ ok: true, state: 'rejected' })
    await expect(pending).rejects.toThrow('CADRE_QUESTION_REJECTED')

    const controller = new AbortController()
    const aborted = h.router.intercept(request({ agent: { id: 'w1' }, wait: { callId: 'call-2' }, signal: controller.signal }), 'w1')
    await Promise.resolve()
    controller.abort()
    await expect(aborted).rejects.toThrow('CADRE_QUESTION_CANCELLED')
  })

  it('caps the pending queue per worker', async () => {
    const h = harness({ maxPending: 1 })
    void h.router.intercept(workerRequest(), 'w1')
    await Promise.resolve()
    await expect(h.router.intercept(workerRequest(), 'w1')).rejects.toThrow('CADRE_QUESTION_LIMIT')
  })
})

/**
 * REAL-composition coverage for supervisor cancellation of a current task.
 * A test-only cordis.yml boots host-governance through the vendored Loader;
 * SessionController cancellation and the Session/ledger stores stay real.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createInboxStub,
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionCommandController } from '../../../api/session-controller/src/commands.ts'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import * as HostGovernance from '../src/index.ts'
import type { StallActionResult, StallTaskView } from '../src/types.ts'

type TurnMode = 'target' | 'other' | 'none' | 'multiple' | 'idle'
type CancelSpy = Mock<Agent['cancel']>

interface CompositionOptions {
  readonly turnMode?: TurnMode
  readonly stalled?: boolean
  readonly endBeforeControllerCancel?: boolean
  readonly failControllerCancel?: boolean
  readonly realWorker?: boolean
}

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  execute(args: Record<string, unknown>, run: { agent?: { id: string } }): Promise<unknown>
}

interface Mounted {
  readonly root: string
  readonly databasePath: string
  readonly tools: ReadonlyMap<string, RegisteredTool>
  readonly worker: Session
  readonly otherWorker: Session
  readonly cancel: CancelSpy
  readonly otherCancel: CancelSpy
  readonly inbox: ReturnType<typeof createInboxStub>
  readonly execution: { stopped: boolean }
  readonly realWorker: { readonly agent: Agent; readonly adapter: MockAdapter } | undefined
}

let root: string | undefined
let context: Context | undefined
let runtime: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  await runtime?.fiber.dispose()
  context = undefined
  runtime = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

function dispatch(taskId: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `【主管任务】\n任务号：${taskId}\n标题：任务 ${taskId}` }],
    source: { kind: 'user', rpcId: `dispatch-${taskId}` as never },
  })
}

function queuedDispatch(taskId: string, title: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `【主管任务】\n任务号：${taskId}\n标题：${title}` }],
    source: { kind: 'user', rpcId: `queued-${title}` as never },
  })
}

async function loadComposition(options: CompositionOptions = {}): Promise<Mounted> {
  const turnMode = options.turnMode ?? 'target'
  root = await mkdtemp(join(tmpdir(), 'host-governance-cancel-current-'))
  const databasePath = join(root, 'cadre.sqlite')
  await writeFile(join(root, 'completed-artifact.txt'), 'completed artifact\n')
  initCadreStore(databasePath)
  const at = new Date().toISOString()
  const db = new DatabaseSync(databasePath)
  try {
    const member = db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'available', ?, ?)`)
    member.run('p1', 'sup', 'supervisor', '组长', at, at)
    member.run('p1', 'w1', 'worker', '员工一', at, at)
    member.run('p1', 'w2', 'worker', '员工二', at, at)
    member.run('p2', 'sup-other', 'supervisor', '其他项目组长', at, at)
    const insertTask = db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes,
      body_sha256, status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
      VALUES (?, 'p1', ?, ?, '任务内容', 1, 'sha', 'in_progress', 'sup', ?, ?, ?)`)
    insertTask.run('t1', 1, '当前任务', 'w1', at, at)
    insertTask.run('t2', 2, '无关任务', 'w2', at, at)
    const event = db.prepare(`INSERT INTO task_events
      (event_id, project_id, task_id, to_status, actor_session_id, idempotency_key, at)
      VALUES (?, 'p1', ?, 'in_progress', 'sup', ?, ?)`)
    event.run('e1', 't1', 'dispatch-1', at)
    event.run('e2', 't2', 'dispatch-2', at)
  } finally {
    db.close()
  }
  vi.stubEnv('CADRE_LEDGER_PATH', databasePath)

  const liveRuntime = new Context()
  runtime = liveRuntime
  let realWorker: Mounted['realWorker']
  if (options.realWorker === true) {
    await mountAgentLoopTestDependencies(liveRuntime)
    const adapter = new MockAdapter(['hang', textResponse('unrelated continuation')])
    liveRuntime.llm.registerAdapter(['mock'], adapter)
    const loop = await mountAgentLoopTestHarness(liveRuntime)
    const agent = await loop.create(SessionId('w1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    realWorker = { agent, adapter }
  } else {
    await liveRuntime.plugin(SessionStore)
    await liveRuntime.plugin(AgentRegistry)
  }
  const worker = realWorker?.agent.session
    ?? liveRuntime.sessions.create(SessionId('w1'), { meta: { cwd: root } })
  if (realWorker === undefined) {
    worker.append('turn/start', { turn: 1 })
    if (turnMode === 'target' || turnMode === 'multiple' || turnMode === 'idle') {
      worker.append('user/message', dispatch('t1'), { surfaceOp: 'append' })
    }
    if (turnMode === 'other' || turnMode === 'multiple') {
      worker.append('user/message', dispatch('t2'), { surfaceOp: 'append' })
    }
    if (turnMode === 'idle') worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const otherWorker = liveRuntime.sessions.create(SessionId('w2'), { meta: { cwd: root } })
  otherWorker.append('turn/start', { turn: 1 })
  otherWorker.append('user/message', dispatch('t2'), { surfaceOp: 'append' })
  const supervisor = liveRuntime.sessions.create(SessionId('sup'), { meta: { cwd: root } })
  const inbox = realWorker?.agent.inbox ?? createInboxStub()
  if (realWorker === undefined) {
    inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'unrelated next turn' }], source: { kind: 'user' },
    }))
    inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'unrelated next step' }], source: { kind: 'user' },
    }))
  }
  const execution = { stopped: false }
  const cancel = vi.fn<Agent['cancel']>(() => {
    execution.stopped = true
    if (turnMode !== 'idle') {
      let activeTurn: number | undefined
      for (const event of worker.snapshotEvents()) {
        if (event.type === 'turn/start') activeTurn = event.data.turn
        if (event.type === 'turn/end' && event.data.turn === activeTurn) activeTurn = undefined
      }
      expect(activeTurn).toBeDefined()
      worker.append('turn/end', { turn: activeTurn ?? 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    }
  })
  const otherCancel = vi.fn<Agent['cancel']>()
  const makeAgent = (session: Session, agentInbox: ReturnType<typeof createInboxStub>, agentCancel: CancelSpy): Agent => ({
    id: session.id, session, inbox: agentInbox, status: 'running', ctx: liveRuntime, cancel: agentCancel,
    options: {}, send: vi.fn(), followup: vi.fn(), steer: vi.fn(), inject: vi.fn(), whenIdle: async () => {},
    runMaintenance: <T>(_task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      Promise.reject(new Error('unexpected maintenance')),
  })
  if (realWorker === undefined) await liveRuntime.agents.register(makeAgent(worker, inbox, cancel))
  await liveRuntime.agents.register(makeAgent(otherWorker, createInboxStub(), otherCancel))
  await liveRuntime.agents.register(makeAgent(supervisor, createInboxStub(), vi.fn<Agent['cancel']>()))
  const commands = new SessionCommandController(liveRuntime, {} as never, root)
  let controllerFailures = options.failControllerCancel === true ? 1 : 0

  const tools = new Map<string, RegisteredTool>()
  const dependencies = {
    name: 'test:host-dependencies',
    apply(ctx: Context): void {
      ctx.provide('tools', { register: (registered: RegisteredTool) => {
        tools.set(registered.name, registered)
        return () => { tools.delete(registered.name) }
      } })
      ctx.provide('sessionController', {
        prompt: async () => ({}),
        cancel: (request: { sessionId: SessionId; turn?: number }) => {
          if (options.endBeforeControllerCancel === true) {
            worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          }
          if (controllerFailures > 0) {
            controllerFailures -= 1
            throw new Error('controller unavailable')
          }
          return commands.cancel(request)
        },
      })
      ctx.provide('sessions', liveRuntime.sessions)
      ctx.provide('sessionQuery', { readSession: async () => ({ events: [] }) })
      ctx.provide('agents', liveRuntime.agents)
      ctx.provide('goals', {
        get: () => undefined, create: () => { throw new Error('unexpected goal create') },
        resume: () => { throw new Error('unexpected goal resume') },
        pause: () => { throw new Error('unexpected goal pause') },
        complete: () => { throw new Error('unexpected goal complete') }, disarm: () => {},
      })
      ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0 }) })
      ctx.provide('agentPresets', { serviceFor: () => undefined })
    },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test:host-dependencies'",
    "- name: '@deepseek-ai/dsh-host-governance'",
    '  config:',
    '    scanIntervalMs: 3600000',
    ...(options.stalled === true ? ['    stalledAfterMs: 0', '    stepStalledAfterMs: 0'] : []),
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test:host-dependencies', dependencies],
    ['@deepseek-ai/dsh-host-governance', HostGovernance],
  ])
  Object.defineProperty(context.loader, 'internal', {
    value: {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    },
  })
  await context.loader.create({
    name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { root, databasePath, tools, worker, otherWorker, cancel, otherCancel, inbox, execution, realWorker }
}

function tool(mounted: Mounted, name: string): RegisteredTool {
  const found = mounted.tools.get(name)
  if (found === undefined) throw new Error(`missing composed tool ${name}`)
  return found
}

async function taskView(mounted: Mounted, taskId = 't1'): Promise<StallTaskView> {
  await vi.waitFor(async () => {
    const value = await tool(mounted, 'list_stalled_tasks').execute({}, { agent: { id: 'sup' } }) as { tasks: StallTaskView[] }
    expect(value.tasks.some(task => task.taskId === taskId)).toBe(true)
  })
  const value = await tool(mounted, 'list_stalled_tasks').execute({}, { agent: { id: 'sup' } }) as { tasks: StallTaskView[] }
  const view = value.tasks.find(task => task.taskId === taskId)
  if (view === undefined) throw new Error(`missing task view ${taskId}`)
  return view
}

function cancelArgs(view: StallTaskView, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: view.taskId, episodeId: view.episodeId, expectedVersion: view.version,
    reason: '组长取消当前任务', idempotencyKey: `cancel-${view.taskId}`, ...overrides,
  }
}

async function executeCancel(
  mounted: Mounted, args: Record<string, unknown>, actor = 'sup',
): Promise<StallActionResult> {
  return await tool(mounted, 'cancel_task').execute(args, { agent: { id: actor } }) as StallActionResult
}

function taskRow(mounted: Mounted, taskId: string): { status: string; version: number } {
  const db = new DatabaseSync(mounted.databasePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT status, version FROM tasks WHERE task_id = ?').get(taskId) as
      { status: string; version: number } | undefined
    if (row === undefined) throw new Error(`missing task row ${taskId}`)
    return row
  } finally {
    db.close()
  }
}

function cancellationEventCount(mounted: Mounted, taskId: string): number {
  const db = new DatabaseSync(mounted.databasePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND to_status = \'cancelled\'')
      .get(taskId) as { count: number }
    return row.count
  } finally {
    db.close()
  }
}

describe('host-governance current-task cancellation REAL composition', () => {
  it('cancels only the associated turn, preserves unrelated state, and replays without another cancel', async () => {
    const mounted = await loadComposition()
    const view = await taskView(mounted)
    expect(view).toMatchObject({
      taskStatus: 'in_progress', stallState: 'normal', version: 1, capabilities: { cancel: true, nudge: false },
    })
    expect(tool(mounted, 'cancel_task').description).toContain('可取消非终态任务')
    expect(tool(mounted, 'cancel_task').parameters).toMatchObject({ required: expect.arrayContaining(['reason']) })
    const historyBefore = mounted.worker.snapshotEvents()
    const otherHistoryBefore = mounted.otherWorker.snapshotEvents()
    const queuedBefore = [...mounted.inbox.nextTurn]
    const steeringBefore = [...mounted.inbox.nextStep]
    mounted.inbox.append('next-turn', queuedDispatch('t1', 'stub-target-next-turn'))
    mounted.inbox.append('next-step', queuedDispatch('t1', 'stub-target-next-step'))
    const args = cancelArgs(view)

    const result = await executeCancel(mounted, args)

    expect(result).toEqual({ ok: true, action: 'cancel', version: 2, replayed: false })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(mounted.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(mounted.execution.stopped).toBe(true)
    expect(mounted.worker.snapshotEvents().slice(0, historyBefore.length)).toEqual(historyBefore)
    expect(mounted.worker.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(mounted.inbox.nextTurn).toEqual(queuedBefore)
    expect(mounted.inbox.nextStep).toEqual(steeringBefore)
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    expect(runtime?.sessions.get(SessionId('w1'))).toBe(mounted.worker)
    expect(runtime?.agents.get(SessionId('w1'))?.session).toBe(mounted.worker)
    expect(await readFile(join(mounted.root, 'completed-artifact.txt'), 'utf8')).toBe('completed artifact\n')

    expect(await executeCancel(mounted, args)).toEqual({ ok: true, action: 'cancel', version: 2, replayed: true })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    console.log('ASSOCIATION target=t1 turn=1 runtime_cancel=1 replay_runtime_cancel=0 unrelated_cancel=0 keepInbox=true')
  })

  it('retries a real ReactLoopAgent cancellation without rerunning targeted queued work', async () => {
    const mounted = await loadComposition({ realWorker: true, failControllerCancel: true })
    const real = mounted.realWorker
    if (real === undefined) throw new Error('missing real worker')
    expect(real.agent).toBeInstanceOf(ReactLoopAgent)
    const otherHistoryBefore = mounted.otherWorker.snapshotEvents()

    real.agent.followup(dispatch('t1'))
    await expect.poll(() => real.adapter.requests.length).toBe(1)
    const targetedTurn = queuedDispatch('t1', 'real-target-next-turn')
    const targetedTurnSecond = queuedDispatch('t1', 'real-target-next-turn-second')
    const targetedStep = queuedDispatch('t1', 'real-target-next-step')
    const targetedStepSecond = queuedDispatch('t1', 'real-target-next-step-second')
    const unrelatedTurn = createUserMessage({
      content: [{ type: 'text', text: 'preserved real next turn' }], source: { kind: 'user' },
    })
    const unrelatedStep = createUserMessage({
      content: [{ type: 'text', text: 'preserved real next step' }], source: { kind: 'user' },
    })
    real.agent.inbox.append('next-turn', targetedTurn)
    real.agent.inbox.append('next-turn', targetedTurnSecond)
    real.agent.inbox.append('next-turn', unrelatedTurn)
    real.agent.inbox.append('next-step', targetedStep)
    real.agent.inbox.append('next-step', targetedStepSecond)
    real.agent.inbox.append('next-step', unrelatedStep)
    const historyBefore = mounted.worker.snapshotEvents()
    const splicesBefore = historyBefore.filter(event => event.type === 'agent/inbox/spliced')
    const idle = real.agent.whenIdle()
    const view = await taskView(mounted)
    const args = cancelArgs(view)

    expect(await executeCancel(mounted, args)).toMatchObject({ ok: false, code: 'CANCEL_RUNTIME_FAILED' })
    expect(real.adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(real.agent.status).toBe('running')
    expect(real.agent.inbox.nextTurn).toEqual([unrelatedTurn])
    expect(real.agent.inbox.nextStep).toEqual([unrelatedStep])
    expect(cancellationEventCount(mounted, 't1')).toBe(1)

    expect(await executeCancel(mounted, args)).toEqual({
      ok: true, action: 'cancel', version: 2, replayed: true,
    })
    await idle

    expect(real.adapter.requests).toHaveLength(1)
    expect(real.adapter.requests[0]?.signal?.aborted).toBe(true)
    expect(real.adapter.requests[0]?.signal?.reason).toEqual({ kind: 'user' })
    expect(real.agent.status).toBe('idle')
    const events = mounted.worker.snapshotEvents()
    expect(events.slice(0, historyBefore.length)).toEqual(historyBefore)
    expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        interrupted: true,
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
    })
    expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(real.agent.inbox.nextTurn).toEqual([unrelatedTurn])
    expect(real.agent.inbox.nextStep).toEqual([unrelatedStep])
    expect(events.filter(event => event.type === 'agent/inbox/spliced').length).toBeGreaterThan(splicesBefore.length)
    const replayed = Session.create(SessionId('real-cancel-replay'), events)
    expect(runtime?.sessionProjections.stateOf(replayed, 'inbox')).toEqual({
      'next-turn': [unrelatedTurn],
      'next-step': [unrelatedStep],
    })
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    expect(await readFile(join(mounted.root, 'completed-artifact.txt'), 'utf8')).toBe('completed artifact\n')

    const settledHistory = mounted.worker.snapshotEvents()
    expect(await executeCancel(mounted, args)).toMatchObject({ ok: true, replayed: true })
    expect(mounted.worker.snapshotEvents()).toEqual(settledHistory)
    expect(real.adapter.requests).toHaveLength(1)

    const unrelatedWake = createUserMessage({
      content: [{ type: 'text', text: 'unrelated wake after cancellation' }], source: { kind: 'user' },
    })
    real.agent.steer(unrelatedWake)
    const continuedIdle = real.agent.whenIdle()
    await expect.poll(() => real.adapter.requests.length).toBe(2)
    await continuedIdle

    const continuedText = real.adapter.requests.slice(1).flatMap(request => request.messages)
      .flatMap(message => message.content)
      .flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(continuedText).toContain('preserved real next turn')
    expect(continuedText).toContain('preserved real next step')
    expect(continuedText).toContain('unrelated wake after cancellation')
    expect(continuedText).not.toContain('real-target-next-turn')
    expect(continuedText).not.toContain('real-target-next-turn-second')
    expect(continuedText).not.toContain('real-target-next-step')
    expect(continuedText).not.toContain('real-target-next-step-second')
    const userTexts = mounted.worker.snapshotEvents().flatMap(event => event.type === 'user/message' ? event.data.content : [])
      .flatMap(part => part.type === 'text' ? [part.text] : [])
    expect(userTexts.some(text => text.includes('real-target-next-turn'))).toBe(false)
    expect(userTexts.some(text => text.includes('real-target-next-step'))).toBe(false)
    expect(mounted.worker.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(0)
    expect(mounted.worker.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } },
    })
    expect(real.agent.inbox.nextTurn).toEqual([])
    expect(real.agent.inbox.nextStep).toEqual([])
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    expect(await readFile(join(mounted.root, 'completed-artifact.txt'), 'utf8')).toBe('completed artifact\n')
    console.log('REAL_AGENT ReactLoopAgent=true provider=MockAdapter firstRuntime=failed retry=success ledger_cancel_events=1 requests=2 targetQueuedModelCalls=0 targetQueuedToolCalls=0 unrelatedContinued=true aborted=true interrupted=true durableReplay=true')
  })

  it('retains the existing stalled-task cancellation path', async () => {
    const mounted = await loadComposition({ stalled: true })
    const view = await taskView(mounted)
    expect(view).toMatchObject({ stallState: 'stalled', capabilities: { cancel: true } })

    expect(await executeCancel(mounted, cancelArgs(view))).toMatchObject({ ok: true, version: 2 })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(mounted.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(mounted.execution.stopped).toBe(true)
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    console.log('ASSOCIATION mode=stalled runtime_cancel=1 unrelated_cancel=0 keepInbox=true')
  })

  it.each([
    { turnMode: 'idle' as const, label: 'no open turn' },
    { turnMode: 'other' as const, label: 'an explicitly unrelated open turn' },
  ])('changes only the ledger with $label', async ({ turnMode }) => {
    const mounted = await loadComposition({ turnMode })
    const view = await taskView(mounted)
    const historyBefore = mounted.worker.snapshotEvents()
    const otherHistoryBefore = mounted.otherWorker.snapshotEvents()

    expect(await executeCancel(mounted, cancelArgs(view))).toMatchObject({ ok: true, version: 2 })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.execution.stopped).toBe(false)
    expect(mounted.worker.snapshotEvents()).toEqual(historyBefore)
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    console.log(`ASSOCIATION mode=${turnMode} runtime_cancel=0 unrelated_cancel=0`)
  })

  it.each([
    { turnMode: 'none' as const },
    { turnMode: 'multiple' as const },
  ])('refuses an ambiguous active turn before either mutation: $turnMode', async ({ turnMode }) => {
    const mounted = await loadComposition({ turnMode })
    const view = await taskView(mounted)
    const historyBefore = mounted.worker.snapshotEvents()

    expect(await executeCancel(mounted, cancelArgs(view))).toMatchObject({ ok: false, code: 'TASK_TURN_AMBIGUOUS' })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.execution.stopped).toBe(false)
    expect(mounted.worker.snapshotEvents()).toEqual(historyBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'in_progress', version: 1 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    console.log(`ASSOCIATION mode=${turnMode} refusal=TASK_TURN_AMBIGUOUS ledger_mutation=0 runtime_cancel=0`)
  })

  it('rejects stale identity/version, missing reason, workers, and another project without side effects', async () => {
    const mounted = await loadComposition()
    const view = await taskView(mounted)
    const historyBefore = mounted.worker.snapshotEvents()
    expect(await executeCancel(mounted, cancelArgs(view, { episodeId: 'stale', idempotencyKey: 'stale-episode' })))
      .toMatchObject({ ok: false, code: 'STALL_ALREADY_RECOVERED' })
    expect(await executeCancel(mounted, cancelArgs(view, { expectedVersion: 99, idempotencyKey: 'stale-version' })))
      .toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    const missingReason = cancelArgs(view, { idempotencyKey: 'missing-reason' })
    delete missingReason.reason
    expect(await executeCancel(mounted, missingReason)).toMatchObject({ ok: false, code: 'CANCEL_NOT_ALLOWED' })
    await expect(tool(mounted, 'cancel_task').execute(cancelArgs(view, { idempotencyKey: 'worker' }), { agent: { id: 'w1' } }))
      .rejects.toThrow('FORBIDDEN_ACTOR')
    expect(await executeCancel(mounted, cancelArgs(view, { idempotencyKey: 'cross-project' }), 'sup-other'))
      .toMatchObject({ ok: false, code: 'TASK_NOT_FOUND' })

    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.worker.snapshotEvents()).toEqual(historyBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'in_progress', version: 1 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
  })

  it.each(['verified', 'failed', 'cancelled'])('rejects a concurrently terminal %s task before runtime cancellation', async status => {
    const mounted = await loadComposition()
    const view = await taskView(mounted)
    const db = new DatabaseSync(mounted.databasePath)
    try {
      db.prepare('UPDATE tasks SET status = ? WHERE task_id = \'t1\'').run(status)
    } finally {
      db.close()
    }
    const historyBefore = mounted.worker.snapshotEvents()

    expect(await executeCancel(mounted, cancelArgs(view))).toMatchObject({ ok: false, code: 'CANCEL_NOT_ALLOWED' })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.worker.snapshotEvents()).toEqual(historyBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status, version: 1 })
  })

  it('does not redirect cancellation after the preflighted turn has already ended', async () => {
    const mounted = await loadComposition({ endBeforeControllerCancel: true })
    const view = await taskView(mounted)

    expect(await executeCancel(mounted, cancelArgs(view))).toMatchObject({ ok: true, version: 2 })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.worker.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
  })

  it('retries a failed runtime cancel under one key with one ledger event and no unrelated cancellation', async () => {
    const mounted = await loadComposition({ failControllerCancel: true })
    const view = await taskView(mounted)
    const args = cancelArgs(view)
    const otherHistoryBefore = mounted.otherWorker.snapshotEvents()
    const queuedBefore = [...mounted.inbox.nextTurn]
    const steeringBefore = [...mounted.inbox.nextStep]

    expect(await executeCancel(mounted, args)).toMatchObject({
      ok: false,
      code: 'CANCEL_RUNTIME_FAILED',
      message: expect.stringMatching(/任务台账已取消.*相同参数和 idempotencyKey 重试.*仅补取消原任务轮次和同任务排队输入/),
    })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    expect(cancellationEventCount(mounted, 't1')).toBe(1)

    expect(await executeCancel(mounted, args)).toEqual({
      ok: true, action: 'cancel', version: 2, replayed: true,
    })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(mounted.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(mounted.execution.stopped).toBe(true)
    expect(mounted.inbox.nextTurn).toEqual(queuedBefore)
    expect(mounted.inbox.nextStep).toEqual(steeringBefore)
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(cancellationEventCount(mounted, 't1')).toBe(1)

    expect(await executeCancel(mounted, args)).toMatchObject({ ok: true, replayed: true })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    console.log('COMPENSATION retry=success ledger_cancel_events=1 original_turn=1 runtime_cancel=1 unrelated_cancel=0')
  })

  it('cancels a same-task replacement turn on same-key retry and discards late targeted input', async () => {
    const mounted = await loadComposition({ failControllerCancel: true })
    const view = await taskView(mounted)
    const args = cancelArgs(view)
    expect(await executeCancel(mounted, args)).toMatchObject({ ok: false, code: 'CANCEL_RUNTIME_FAILED' })

    const queuedBefore = [...mounted.inbox.nextTurn]
    const steeringBefore = [...mounted.inbox.nextStep]
    mounted.inbox.append('next-turn', queuedDispatch('t1', 'compensation-target-next-turn'))
    mounted.inbox.append('next-step', queuedDispatch('t1', 'compensation-target-next-step'))
    mounted.worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    mounted.worker.append('turn/start', { turn: 2 })
    mounted.worker.append('user/message', dispatch('t1'), { surfaceOp: 'append' })
    const otherHistoryBefore = mounted.otherWorker.snapshotEvents()

    expect(await executeCancel(mounted, args)).toEqual({
      ok: true, action: 'cancel', version: 2, replayed: true,
    })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(mounted.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(mounted.execution.stopped).toBe(true)
    expect(mounted.inbox.nextTurn).toEqual(queuedBefore)
    expect(mounted.inbox.nextStep).toEqual(steeringBefore)
    expect(mounted.worker.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.otherWorker.snapshotEvents()).toEqual(otherHistoryBefore)
    expect(taskRow(mounted, 't1')).toEqual({ status: 'cancelled', version: 2 })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    expect(cancellationEventCount(mounted, 't1')).toBe(1)

    expect(await executeCancel(mounted, args)).toMatchObject({ ok: true, replayed: true })
    expect(mounted.cancel).toHaveBeenCalledTimes(1)
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    console.log('COMPENSATION same_task_replacement=turn2 retry=success lateTargetInput=removed unrelatedQueue=preserved ledger_cancel_events=1')
  })

  it('completes a retry after the original turn ends without redirecting to its replacement', async () => {
    const mounted = await loadComposition({ failControllerCancel: true })
    const view = await taskView(mounted)
    const args = cancelArgs(view)
    expect(await executeCancel(mounted, args)).toMatchObject({ ok: false, code: 'CANCEL_RUNTIME_FAILED' })

    mounted.worker.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    mounted.worker.append('turn/start', { turn: 2 })
    mounted.worker.append('user/message', dispatch('t2'), { surfaceOp: 'append' })
    const replacementHistory = mounted.worker.snapshotEvents()

    expect(await executeCancel(mounted, args)).toEqual({
      ok: true, action: 'cancel', version: 2, replayed: true,
    })
    expect(mounted.cancel).not.toHaveBeenCalled()
    expect(mounted.otherCancel).not.toHaveBeenCalled()
    expect(mounted.worker.snapshotEvents()).toEqual(replacementHistory)
    expect(mounted.worker.snapshotEvents().at(-1)).toMatchObject({
      type: 'user/message', data: { content: [{ type: 'text', text: expect.stringContaining('任务号：t2') }] },
    })
    expect(taskRow(mounted, 't2')).toEqual({ status: 'in_progress', version: 1 })
    expect(cancellationEventCount(mounted, 't1')).toBe(1)
    console.log('COMPENSATION original_turn=ended replacement_turn=2 replacement_cancel=0 ledger_cancel_events=1')
  })
})

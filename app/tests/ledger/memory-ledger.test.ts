/**
 * 台账内存仓储测试：合法迁移遍历、非法拒绝矩阵、权限矩阵、rework 循环、
 * 取代语义、幂等重复提交、项目隔离与审计事件。
 *
 * 状态组合全部由 `TASK_TRANSITION_RULES` 驱动，测试不另写矩阵。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TASK_STATUSES,
  TASK_TRANSITION_RULES,
  type IdempotencyKey,
  type IsoTimestamp,
  type ProjectId,
  type SessionId,
  type TaskId,
  type TaskStatus,
} from '../../src/collab/protocol/index.ts'
import {
  InMemoryTaskLedger,
  listIllegalTransitionPairs,
  requiresReason,
  type LedgerActor,
  type LedgerResult,
  type TaskRecord,
  type TransitionOutcome,
} from '../../src/collab/ledger/index.ts'

const P1 = 'project-1' as ProjectId
const P2 = 'project-2' as ProjectId
const SUP = 'session-supervisor' as SessionId
const EMP = 'session-employee' as SessionId

const ASSIGNEE: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
const SUPERVISOR: LedgerActor = { kind: 'session', sessionId: SUP, role: 'supervisor' }
const SYSTEM: LedgerActor = { kind: 'system', onBehalfOf: EMP }

const ACTOR_KINDS = ['assignee', 'supervisor', 'system'] as const
type ActorKind = (typeof ACTOR_KINDS)[number]

let taskSeq = 0
let keySeq = 0

function nextTaskId(): TaskId {
  return `task-${++taskSeq}` as TaskId
}

function nextKey(): IdempotencyKey {
  return `key-${++keySeq}` as IdempotencyKey
}

function makeLedger(): InMemoryTaskLedger {
  let tick = 0
  let eventSeq = 0
  return new InMemoryTaskLedger({
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
    newId: () => `event-${++eventSeq}`,
  })
}

function actorFor(kind: ActorKind): LedgerActor {
  if (kind === 'assignee') return ASSIGNEE
  if (kind === 'supervisor') return SUPERVISOR
  return SYSTEM
}

interface CreateOptions {
  readonly projectId?: ProjectId
  readonly taskId?: TaskId
  readonly title?: string
  readonly supersedesTaskId?: TaskId
  readonly idempotencyKey?: IdempotencyKey
}

function createTask(ledger: InMemoryTaskLedger, options: CreateOptions = {}): TaskRecord {
  const result = ledger.createTask({
    projectId: options.projectId ?? P1,
    taskId: options.taskId ?? nextTaskId(),
    title: options.title ?? '测试任务',
    body: '测试正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    ...(options.supersedesTaskId === undefined ? {} : { supersedesTaskId: options.supersedesTaskId }),
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  })
  if (!result.ok) assert.fail(`createTask 失败：${result.error.code} ${result.error.message}`)
  return result.value.task
}

function move(
  ledger: InMemoryTaskLedger,
  taskId: TaskId,
  from: TaskStatus,
  to: TaskStatus,
  actor: LedgerActor,
  options: { readonly projectId?: ProjectId; readonly idempotencyKey?: IdempotencyKey; readonly reason?: string } = {},
): LedgerResult<TransitionOutcome> {
  return ledger.transition({
    projectId: options.projectId ?? P1,
    taskId,
    from,
    to,
    actor,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  })
}

function mustMove(
  ledger: InMemoryTaskLedger,
  taskId: TaskId,
  from: TaskStatus,
  to: TaskStatus,
  actor: LedgerActor,
): TaskRecord {
  const result = move(ledger, taskId, from, to, actor)
  if (!result.ok) assert.fail(`迁移 ${from} → ${to} 失败：${result.error.code} ${result.error.message}`)
  return result.value.task
}

function mustMoveWithReason(
  ledger: InMemoryTaskLedger,
  taskId: TaskId,
  from: TaskStatus,
  to: TaskStatus,
  actor: LedgerActor,
  reason: string,
): TaskRecord {
  const result = move(ledger, taskId, from, to, actor, { reason })
  if (!result.ok) assert.fail(`迁移 ${from} → ${to} 失败：${result.error.code} ${result.error.message}`)
  return result.value.task
}

/** 把新任务驱动到目标状态；每个测试用独立 ledger，避免相互污染。 */
function prepare(status: TaskStatus): { ledger: InMemoryTaskLedger; taskId: TaskId } {
  const ledger = makeLedger()
  const taskId = createTask(ledger).taskId
  const steps: Array<[TaskStatus, TaskStatus, LedgerActor]> = []
  switch (status) {
    case 'dispatched':
      break
    case 'cancelled':
      steps.push(['dispatched', 'cancelled', SUPERVISOR])
      break
    case 'accepted':
      steps.push(['dispatched', 'accepted', ASSIGNEE])
      break
    case 'in_progress':
      steps.push(['dispatched', 'accepted', ASSIGNEE], ['accepted', 'in_progress', ASSIGNEE])
      break
    case 'delivered':
      steps.push(
        ['dispatched', 'accepted', ASSIGNEE],
        ['accepted', 'in_progress', ASSIGNEE],
        ['in_progress', 'delivered', ASSIGNEE],
      )
      break
    case 'review':
      steps.push(
        ['dispatched', 'accepted', ASSIGNEE],
        ['accepted', 'in_progress', ASSIGNEE],
        ['in_progress', 'delivered', ASSIGNEE],
        ['delivered', 'review', SUPERVISOR],
      )
      break
    case 'verified':
      steps.push(
        ['dispatched', 'accepted', ASSIGNEE],
        ['accepted', 'in_progress', ASSIGNEE],
        ['in_progress', 'delivered', ASSIGNEE],
        ['delivered', 'review', SUPERVISOR],
        ['review', 'verified', SUPERVISOR],
      )
      break
    case 'rework':
      steps.push(
        ['dispatched', 'accepted', ASSIGNEE],
        ['accepted', 'in_progress', ASSIGNEE],
        ['in_progress', 'delivered', ASSIGNEE],
        ['delivered', 'review', SUPERVISOR],
        ['review', 'rework', SUPERVISOR],
      )
      break
    case 'failed':
      steps.push(
        ['dispatched', 'accepted', ASSIGNEE],
        ['accepted', 'in_progress', ASSIGNEE],
        ['in_progress', 'delivered', ASSIGNEE],
        ['delivered', 'review', SUPERVISOR],
        ['review', 'failed', SUPERVISOR],
      )
      break
  }
  for (const [from, to, actor] of steps) {
    const result = move(ledger, taskId, from, to, actor, requiresReason(to) ? { reason: '测试准备' } : {})
    if (!result.ok) assert.fail(`准备 ${from} → ${to} 失败：${result.error.code} ${result.error.message}`)
  }
  return { ledger, taskId }
}

function eventsOf(ledger: InMemoryTaskLedger, taskId: TaskId) {
  const result = ledger.listEvents(P1, taskId)
  if (!result.ok) assert.fail(`listEvents 失败：${result.error.code}`)
  return result.value
}

function taskOf(ledger: InMemoryTaskLedger, taskId: TaskId, projectId: ProjectId = P1): TaskRecord {
  const result = ledger.getTask(projectId, taskId)
  if (!result.ok) assert.fail(`getTask 失败：${result.error.code}`)
  return result.value
}

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

// —— 合法迁移遍历 × 权限矩阵 ——
for (const rule of TASK_TRANSITION_RULES) {
  it(`合法迁移 ${rule.from} → ${rule.to}：权限矩阵`, () => {
    for (const kind of ACTOR_KINDS) {
      const { ledger, taskId } = prepare(rule.from)
      const eventsBefore = eventsOf(ledger, taskId).length
      const result = move(ledger, taskId, rule.from, rule.to, actorFor(kind), {
        ...(requiresReason(rule.to) ? { reason: '测试原因' } : {}),
      })

      if (rule.actors.includes(kind)) {
        assert.equal(result.ok, true, `${kind} 应被允许执行 ${rule.from} → ${rule.to}`)
        if (!result.ok) continue
        assert.equal(result.value.replayed, false)
        assert.equal(result.value.task.status, rule.to)
        const events = eventsOf(ledger, taskId)
        assert.equal(events.length, eventsBefore + 1, '每次成功迁移必须写一条审计事件')
        const last = events.at(-1)
        assert.ok(last)
        assert.equal(last.fromStatus, rule.from)
        assert.equal(last.toStatus, rule.to)
        assert.equal(last.actorSessionId, kind === 'system' ? 'system' : kind === 'assignee' ? EMP : SUP)
      } else {
        assert.equal(result.ok, false, `${kind} 不应被允许执行 ${rule.from} → ${rule.to}`)
        if (result.ok) continue
        assert.equal(result.error.code, 'FORBIDDEN_ACTOR')
        assert.equal(taskOf(ledger, taskId).status, rule.from, '拒绝不得改变状态')
        assert.equal(eventsOf(ledger, taskId).length, eventsBefore, '拒绝不得写审计事件')
      }
    }
  })
}

// —— 非法迁移拒绝矩阵（全部其他状态组合） ——
for (const { from, to } of listIllegalTransitionPairs()) {
  it(`非法迁移 ${from} → ${to}：全部执行者必拒`, () => {
    for (const kind of ACTOR_KINDS) {
      const { ledger, taskId } = prepare(from)
      const before = taskOf(ledger, taskId)
      const eventsBefore = eventsOf(ledger, taskId).length
      const result = move(ledger, taskId, from, to, actorFor(kind))
      assert.equal(result.ok, false, `${from} → ${to} 不应被允许`)
      if (result.ok) continue
      assert.equal(result.error.code, 'INVALID_TRANSITION')
      const after = taskOf(ledger, taskId)
      assert.equal(after.status, before.status)
      assert.equal(after.version, before.version)
      assert.equal(eventsOf(ledger, taskId).length, eventsBefore)
    }
  })
}

// —— 终态锁死 ——
for (const terminal of ['verified', 'failed', 'cancelled'] as const) {
  it(`终态锁死：${terminal} 不可再迁移`, () => {
    for (const to of TASK_STATUSES) {
      const { ledger, taskId } = prepare(terminal)
      const result = move(ledger, taskId, terminal, to, ASSIGNEE)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'INVALID_TRANSITION')
      assert.equal(taskOf(ledger, taskId).status, terminal)
    }
  })
}

// —— rework 循环与 attempt ——
it('rework 循环：保留 taskId，每次 rework attempt +1', () => {
  const { ledger, taskId } = prepare('review')

  let task = mustMoveWithReason(ledger, taskId, 'review', 'rework', SUPERVISOR, '返工')
  assert.equal(task.taskId, taskId)
  assert.equal(task.status, 'rework')
  assert.equal(task.attempt, 1)

  task = mustMove(ledger, taskId, 'rework', 'in_progress', ASSIGNEE)
  assert.equal(task.attempt, 1, 'rework → in_progress 不再加 attempt')

  mustMove(ledger, taskId, 'in_progress', 'delivered', ASSIGNEE)
  mustMove(ledger, taskId, 'delivered', 'review', SUPERVISOR)
  task = mustMoveWithReason(ledger, taskId, 'review', 'rework', SUPERVISOR, '再次返工')
  assert.equal(task.taskId, taskId)
  assert.equal(task.attempt, 2)

  assert.equal(ledger.listTasks(P1).length, 1, 'rework 不产生新任务')
  assert.equal(eventsOf(ledger, taskId).at(-1)?.toStatus, 'rework')
})

// —— reason 必填（目标态 rework / failed / cancelled） ——
const REASON_CASES = [
  { from: 'review', to: 'rework', actor: SUPERVISOR },
  { from: 'review', to: 'failed', actor: SUPERVISOR },
  { from: 'dispatched', to: 'cancelled', actor: SUPERVISOR },
] as const satisfies ReadonlyArray<{ from: TaskStatus; to: TaskStatus; actor: LedgerActor }>

for (const reasonCase of REASON_CASES) {
  it(`reason 必填：${reasonCase.from} → ${reasonCase.to} 缺失/空白必拒且不推进`, () => {
    for (const reason of [undefined, '', '   ', '\t\n'] as const) {
      const { ledger, taskId } = prepare(reasonCase.from)
      const before = taskOf(ledger, taskId)
      const eventsBefore = eventsOf(ledger, taskId).length
      const result = move(ledger, taskId, reasonCase.from, reasonCase.to, reasonCase.actor, {
        ...(reason === undefined ? {} : { reason }),
      })
      assert.equal(result.ok, false, `reason=${JSON.stringify(reason)} 应被拒绝`)
      if (result.ok) continue
      assert.equal(result.error.code, 'MISSING_REASON')
      assert.equal(result.error.retryable, false)
      assert.equal(result.error.projectId, P1)
      assert.equal(result.error.taskId, taskId)
      assert.equal(result.error.to, reasonCase.to)
      assert.deepEqual(result.error.requiredFor, ['rework', 'failed', 'cancelled'])
      assert.deepEqual(taskOf(ledger, taskId), before, '状态与 version 均不得变化')
      assert.equal(eventsOf(ledger, taskId).length, eventsBefore, '不得写审计事件')
    }
  })

  it(`reason 必填：${reasonCase.from} → ${reasonCase.to} 提供非空 reason 正常迁移`, () => {
    const { ledger, taskId } = prepare(reasonCase.from)
    const result = move(ledger, taskId, reasonCase.from, reasonCase.to, reasonCase.actor, {
      reason: '验收不通过',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.task.status, reasonCase.to)
    assert.equal(result.value.event.reason, '验收不通过')
    assert.equal(eventsOf(ledger, taskId).at(-1)?.reason, '验收不通过')
  })
}

// —— 取代语义 ——
it('取代：旧任务 cancelled + reason=superseded + supersededBy 指向新任务', () => {
  const ledger = makeLedger()
  const oldTask = createTask(ledger)
  const newTaskId = nextTaskId()
  const supersedeKey = nextKey()
  const result = ledger.createTask({
    projectId: P1,
    taskId: newTaskId,
    title: '新任务',
    body: '新正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    supersedesTaskId: oldTask.taskId,
    idempotencyKey: supersedeKey,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.value.task.supersedesTaskId, oldTask.taskId)
  assert.equal(result.value.superseded?.status, 'cancelled')
  assert.equal(result.value.superseded?.supersededByTaskId, newTaskId)

  const oldAfter = taskOf(ledger, oldTask.taskId)
  assert.equal(oldAfter.status, 'cancelled')
  assert.equal(oldAfter.supersededByTaskId, newTaskId)
  const oldEvents = eventsOf(ledger, oldTask.taskId)
  assert.equal(oldEvents.at(-1)?.toStatus, 'cancelled')
  assert.equal(oldEvents.at(-1)?.reason, 'superseded')
  assert.equal(oldEvents.at(-1)?.idempotencyKey, supersedeKey)
})

it('取代终态任务：拒绝且不改写', () => {
  const { ledger, taskId } = prepare('verified')
  const result = ledger.createTask({
    projectId: P1,
    taskId: nextTaskId(),
    title: '新任务',
    body: '新正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    supersedesTaskId: taskId,
    idempotencyKey: nextKey(),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_TRANSITION')
  assert.equal(taskOf(ledger, taskId).status, 'verified')
})

it('取代跨项目任务：CROSS_PROJECT_DENIED 且不泄露任务字段', () => {
  const ledger = makeLedger()
  const foreign = createTask(ledger, { projectId: P2 })
  const result = ledger.createTask({
    projectId: P1,
    taskId: nextTaskId(),
    title: '新任务',
    body: '新正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    supersedesTaskId: foreign.taskId,
    idempotencyKey: nextKey(),
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'CROSS_PROJECT_DENIED')
    assert.equal(result.error.taskId, undefined)
  }
  assert.equal(taskOf(ledger, foreign.taskId, P2).status, 'dispatched')
})

// —— 幂等 ——
it('幂等：同键同请求的派活重放返回首次结果，不新增任务', () => {
  const ledger = makeLedger()
  const key = nextKey()
  const taskId = nextTaskId()
  const first = ledger.createTask({
    projectId: P1,
    taskId,
    title: '任务',
    body: '正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    idempotencyKey: key,
  })
  const second = ledger.createTask({
    projectId: P1,
    taskId,
    title: '任务',
    body: '正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    idempotencyKey: key,
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(second.value.replayed, true)
  assert.deepEqual(second.value.task, first.value.task)
  assert.equal(ledger.listTasks(P1).length, 1)
})

it('幂等：同键不同请求的派活返回 IDEMPOTENCY_CONFLICT', () => {
  const ledger = makeLedger()
  const key = nextKey()
  createTask(ledger, { idempotencyKey: key, title: '第一次' })
  const result = ledger.createTask({
    projectId: P1,
    taskId: nextTaskId(),
    title: '第二次',
    body: '正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    idempotencyKey: key,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'IDEMPOTENCY_CONFLICT')
})

it('幂等：同键同请求的迁移重放返回首次结果，不重复推进状态', () => {
  const ledger = makeLedger()
  const taskId = createTask(ledger).taskId
  const key = nextKey()
  const first = move(ledger, taskId, 'dispatched', 'accepted', ASSIGNEE, { idempotencyKey: key })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const versionAfterFirst = first.value.task.version
  const eventsAfterFirst = eventsOf(ledger, taskId).length

  const second = move(ledger, taskId, 'dispatched', 'accepted', ASSIGNEE, { idempotencyKey: key })
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.value.replayed, true)
  assert.equal(second.value.task.version, versionAfterFirst)
  assert.equal(eventsOf(ledger, taskId).length, eventsAfterFirst)
  assert.equal(taskOf(ledger, taskId).status, 'accepted')
})

it('幂等：同键不同迁移返回 IDEMPOTENCY_CONFLICT', () => {
  const ledger = makeLedger()
  const taskId = createTask(ledger).taskId
  const key = nextKey()
  assert.equal(move(ledger, taskId, 'dispatched', 'accepted', ASSIGNEE, { idempotencyKey: key }).ok, true)
  const conflict = move(ledger, taskId, 'dispatched', 'cancelled', SUPERVISOR, { idempotencyKey: key })
  assert.equal(conflict.ok, false)
  if (!conflict.ok) assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(taskOf(ledger, taskId).status, 'accepted')
})

it('幂等：同键在不同项目互不干扰', () => {
  const ledger = makeLedger()
  const key = nextKey()
  const first = createTask(ledger, { projectId: P1, idempotencyKey: key })
  const second = createTask(ledger, { projectId: P2, idempotencyKey: key })
  assert.notEqual(first.taskId, second.taskId)
  assert.equal(ledger.listTasks(P1).length, 1)
  assert.equal(ledger.listTasks(P2).length, 1)
})

// —— 其他不变量 ——
it('迁移起点与当前状态不符：拒绝且不改写', () => {
  const { ledger, taskId } = prepare('accepted')
  const before = taskOf(ledger, taskId)
  const result = move(ledger, taskId, 'dispatched', 'accepted', ASSIGNEE)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_TRANSITION')
    assert.equal(result.error.from, 'accepted')
  }
  assert.deepEqual(taskOf(ledger, taskId), before)
})

it('项目隔离：跨项目读取/迁移一律拒绝', () => {
  const { ledger, taskId } = prepare('dispatched')
  const read = ledger.getTask(P2, taskId)
  assert.equal(read.ok, false)
  if (!read.ok) assert.equal(read.error.code, 'CROSS_PROJECT_DENIED')

  const write = move(ledger, taskId, 'dispatched', 'accepted', ASSIGNEE, { projectId: P2 })
  assert.equal(write.ok, false)
  if (!write.ok) assert.equal(write.error.code, 'CROSS_PROJECT_DENIED')
  assert.equal(taskOf(ledger, taskId).status, 'dispatched')
})

it('审计事件：创建写一条 from 为空的事件', () => {
  const ledger = makeLedger()
  const taskId = createTask(ledger).taskId
  const events = eventsOf(ledger, taskId)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.fromStatus, undefined)
  assert.equal(events[0]?.toStatus, 'dispatched')
  assert.equal(events[0]?.actorSessionId, SUP)
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  const expected = TASK_TRANSITION_RULES.length + listIllegalTransitionPairs().length + 22
  assert.equal(registered, expected, `注册用例数 ${registered} ≠ 预期 ${expected}`)
  assert.ok(registered > 0)
})

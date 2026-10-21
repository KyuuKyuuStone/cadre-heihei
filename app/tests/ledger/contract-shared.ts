/**
 * 台账契约测试（实现无关）：内存与 SQLite 各跑一遍。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  CreateTaskCommand,
  LedgerActor,
  TaskLedgerPort,
  TaskRecord,
} from '../../src/collab/ledger/index.ts'
import type {
  IdempotencyKey,
  IsoTimestamp,
  ProjectId,
  SessionId,
  TaskId,
  TaskStatus,
} from '../../src/collab/protocol/index.ts'

export const P1 = 'contract-project-1' as ProjectId
export const P2 = 'contract-project-2' as ProjectId
export const SUP = 'contract-supervisor' as SessionId
export const EMP = 'contract-employee' as SessionId

const ASSIGNEE: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
const SUPERVISOR: LedgerActor = { kind: 'session', sessionId: SUP, role: 'supervisor' }
const SYSTEM: LedgerActor = { kind: 'system', onBehalfOf: EMP }

let taskSeq = 0
let keySeq = 0
function nextTaskId(): TaskId {
  return `contract-task-${++taskSeq}` as TaskId
}
function nextKey(): IdempotencyKey {
  return `contract-key-${++keySeq}` as IdempotencyKey
}
function clock(): () => IsoTimestamp {
  let tick = 0
  return () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
}

export interface LedgerHarness {
  readonly ledger: TaskLedgerPort
  close(): void
}
export type LedgerHarnessFactory = () => LedgerHarness

function run(create: LedgerHarnessFactory, fn: (harness: LedgerHarness) => void): void {
  const harness = create()
  try {
    fn(harness)
  } finally {
    harness.close()
  }
}

function createTask(
  harness: LedgerHarness,
  overrides: Partial<CreateTaskCommand> = {},
): TaskRecord {
  const command: CreateTaskCommand = {
    projectId: P1,
    taskId: nextTaskId(),
    title: '契约任务',
    body: '契约正文',
    dispatcherSessionId: SUP,
    assigneeSessionId: EMP,
    idempotencyKey: nextKey(),
    ...overrides,
  }
  const result = harness.ledger.createTask(command)
  if (!result.ok) assert.fail(`createTask 失败：${result.error.code} ${result.error.message}`)
  return result.value.task
}

function transition(
  harness: LedgerHarness,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
  reason?: string,
) {
  const current = harness.ledger.getTask(P1, taskId)
  if (!current.ok) assert.fail(`getTask 失败：${current.error.code}`)
  return harness.ledger.transition({
    projectId: P1,
    taskId,
    from: current.value.status,
    to,
    actor,
    ...(reason === undefined ? {} : { reason }),
    idempotencyKey: nextKey(),
  })
}

function mustTransition(
  harness: LedgerHarness,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
  reason?: string,
): TaskRecord {
  const result = transition(harness, taskId, to, actor, reason)
  if (!result.ok) assert.fail(`迁移 → ${to} 失败：${result.error.code} ${result.error.message}`)
  return result.value.task
}

function prepare(harness: LedgerHarness, status: TaskStatus): TaskId {
  const taskId = createTask(harness).taskId
  const steps: Array<[TaskStatus, LedgerActor, string?]> = []
  switch (status) {
    case 'dispatched':
      break
    case 'cancelled':
      steps.push(['cancelled', SUPERVISOR, 'superseded-test'])
      break
    case 'accepted':
      steps.push(['accepted', ASSIGNEE])
      break
    case 'in_progress':
      steps.push(['accepted', ASSIGNEE], ['in_progress', ASSIGNEE])
      break
    case 'delivered':
      steps.push(['accepted', ASSIGNEE], ['in_progress', ASSIGNEE], ['delivered', SYSTEM])
      break
    case 'review':
      steps.push(
        ['accepted', ASSIGNEE],
        ['in_progress', ASSIGNEE],
        ['delivered', SYSTEM],
        ['review', SUPERVISOR],
      )
      break
    case 'verified':
      steps.push(
        ['accepted', ASSIGNEE],
        ['in_progress', ASSIGNEE],
        ['delivered', SYSTEM],
        ['review', SUPERVISOR],
        ['verified', SUPERVISOR],
      )
      break
    case 'rework':
      steps.push(
        ['accepted', ASSIGNEE],
        ['in_progress', ASSIGNEE],
        ['delivered', SYSTEM],
        ['review', SUPERVISOR],
        ['rework', SUPERVISOR, '返工'],
      )
      break
    case 'failed':
      steps.push(
        ['accepted', ASSIGNEE],
        ['in_progress', ASSIGNEE],
        ['delivered', SYSTEM],
        ['review', SUPERVISOR],
        ['failed', SUPERVISOR, '验收失败'],
      )
      break
  }
  for (const [to, actor, reason] of steps) mustTransition(harness, taskId, to, actor, reason)
  return taskId
}

export function runLedgerContract(name: string, create: LedgerHarnessFactory): void {
  test(`[${name}] 合法路径 dispatched→verified 与审计事件`, () =>
    run(create, (harness) => {
      const taskId = createTask(harness).taskId
      const path: Array<[TaskStatus, LedgerActor]> = [
        ['accepted', ASSIGNEE],
        ['in_progress', ASSIGNEE],
        ['delivered', SYSTEM],
        ['review', SUPERVISOR],
        ['verified', SUPERVISOR],
      ]
      for (const [to, actor] of path) mustTransition(harness, taskId, to, actor)
      const task = harness.ledger.getTask(P1, taskId)
      assert.equal(task.ok, true)
      if (task.ok) assert.equal(task.value.status, 'verified')
      const events = harness.ledger.listEvents(P1, taskId)
      assert.equal(events.ok, true)
      if (events.ok) {
        assert.equal(events.value.length, 6, '创建 1 + 迁移 5')
        assert.equal(events.value[0]?.toStatus, 'dispatched')
        assert.equal(events.value.at(-1)?.toStatus, 'verified')
      }
    }))

  test(`[${name}] review 必经：delivered 不得直达终态或 rework`, () =>
    run(create, (harness) => {
      const taskId = prepare(harness, 'delivered')
      for (const to of ['verified', 'rework', 'failed'] as const) {
        const result = transition(harness, taskId, to, SUPERVISOR)
        assert.equal(result.ok, false)
        if (!result.ok) assert.equal(result.error.code, 'INVALID_TRANSITION')
      }
      const review = transition(harness, taskId, 'review', SUPERVISOR)
      assert.equal(review.ok, true)
    }))

  test(`[${name}] 终态锁死与非法迁移必拒`, () =>
    run(create, (harness) => {
      for (const terminal of ['verified', 'failed', 'cancelled'] as const) {
        const taskId = prepare(harness, terminal)
        const result = transition(harness, taskId, 'in_progress', ASSIGNEE)
        assert.equal(result.ok, false)
        if (!result.ok) assert.equal(result.error.code, 'INVALID_TRANSITION')
        const after = harness.ledger.getTask(P1, taskId)
        if (after.ok) assert.equal(after.value.status, terminal)
      }
      const dispatched = prepare(harness, 'dispatched')
      const skip = transition(harness, dispatched, 'in_progress', ASSIGNEE)
      assert.equal(skip.ok, false)
      if (!skip.ok) assert.equal(skip.error.code, 'INVALID_TRANSITION')
    }))

  test(`[${name}] 目标态 rework/failed/cancelled 强制 reason`, () =>
    run(create, (harness) => {
      const rework = prepare(harness, 'review')
      const missing = transition(harness, rework, 'rework', SUPERVISOR)
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.error.code, 'MISSING_REASON')
      const withReason = transition(harness, rework, 'rework', SUPERVISOR, '返工')
      assert.equal(withReason.ok, true)

      const failed = prepare(harness, 'review')
      const failedMissing = transition(harness, failed, 'failed', SUPERVISOR)
      assert.equal(failedMissing.ok, false)
      if (!failedMissing.ok) assert.equal(failedMissing.error.code, 'MISSING_REASON')

      const cancelled = prepare(harness, 'dispatched')
      const cancelMissing = transition(harness, cancelled, 'cancelled', SUPERVISOR)
      assert.equal(cancelMissing.ok, false)
      if (!cancelMissing.ok) assert.equal(cancelMissing.error.code, 'MISSING_REASON')
    }))

  test(`[${name}] 权限矩阵：assignee 不得验收，supervisor 不得替员工推进`, () =>
    run(create, (harness) => {
      const review = prepare(harness, 'review')
      const assigneeVerify = transition(harness, review, 'verified', ASSIGNEE)
      assert.equal(assigneeVerify.ok, false)
      if (!assigneeVerify.ok) assert.equal(assigneeVerify.error.code, 'FORBIDDEN_ACTOR')

      const accepted = prepare(harness, 'accepted')
      const supervisorStart = transition(harness, accepted, 'in_progress', SUPERVISOR)
      assert.equal(supervisorStart.ok, false)
      if (!supervisorStart.ok) assert.equal(supervisorStart.error.code, 'FORBIDDEN_ACTOR')
    }))

  test(`[${name}] rework 循环保留 taskId，attempt 每次 +1`, () =>
    run(create, (harness) => {
      const taskId = prepare(harness, 'review')
      let task = mustTransition(harness, taskId, 'rework', SUPERVISOR, '返工一')
      assert.equal(task.taskId, taskId)
      assert.equal(task.attempt, 1)
      task = mustTransition(harness, taskId, 'in_progress', ASSIGNEE)
      assert.equal(task.attempt, 1)
      mustTransition(harness, taskId, 'delivered', SYSTEM)
      mustTransition(harness, taskId, 'review', SUPERVISOR)
      task = mustTransition(harness, taskId, 'rework', SUPERVISOR, '返工二')
      assert.equal(task.taskId, taskId)
      assert.equal(task.attempt, 2)
      assert.equal(harness.ledger.listTasks(P1).length, 1)
    }))

  test(`[${name}] supersedes：旧任务 cancelled + reason + 双向链接`, () =>
    run(create, (harness) => {
      const oldTask = createTask(harness)
      const newTaskId = nextTaskId()
      const result = harness.ledger.createTask({
        projectId: P1,
        taskId: newTaskId,
        title: '新任务',
        body: '新正文',
        dispatcherSessionId: SUP,
        assigneeSessionId: EMP,
        supersedesTaskId: oldTask.taskId,
        idempotencyKey: nextKey(),
      })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.value.task.supersedesTaskId, oldTask.taskId)
      assert.equal(result.value.superseded?.status, 'cancelled')
      const oldAfter = harness.ledger.getTask(P1, oldTask.taskId)
      assert.equal(oldAfter.ok, true)
      if (oldAfter.ok) {
        assert.equal(oldAfter.value.status, 'cancelled')
        assert.equal(oldAfter.value.supersededByTaskId, newTaskId)
      }
      const events = harness.ledger.listEvents(P1, oldTask.taskId)
      assert.equal(events.ok, true)
      if (events.ok) {
        assert.equal(events.value.at(-1)?.reason, 'superseded')
        assert.equal(events.value.at(-1)?.toStatus, 'cancelled')
      }
    }))

  test(`[${name}] 幂等：同键同请求返回首次结果，不同请求冲突`, () =>
    run(create, (harness) => {
      const key = nextKey()
      const taskId = nextTaskId()
      const command: CreateTaskCommand = {
        projectId: P1,
        taskId,
        title: '幂等任务',
        body: '正文',
        dispatcherSessionId: SUP,
        assigneeSessionId: EMP,
        idempotencyKey: key,
      }
      const first = harness.ledger.createTask(command)
      const second = harness.ledger.createTask(command)
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      if (!first.ok || !second.ok) return
      assert.equal(second.value.replayed, true)
      assert.equal(second.value.task.taskId, first.value.task.taskId)
      assert.equal(harness.ledger.listTasks(P1).length, 1)

      const conflict = harness.ledger.createTask({ ...command, taskId: nextTaskId(), title: '另一个' })
      assert.equal(conflict.ok, false)
      if (!conflict.ok) assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
    }))

  test(`[${name}] 迁移幂等：重放不重复推进、不重复写事件`, () =>
    run(create, (harness) => {
      const taskId = createTask(harness).taskId
      const key = nextKey()
      const first = harness.ledger.transition({
        projectId: P1,
        taskId,
        from: 'dispatched',
        to: 'accepted',
        actor: ASSIGNEE,
        idempotencyKey: key,
      })
      const eventsAfterFirst = harness.ledger.listEvents(P1, taskId)
      assert.equal(first.ok, true)
      const second = harness.ledger.transition({
        projectId: P1,
        taskId,
        from: 'dispatched',
        to: 'accepted',
        actor: ASSIGNEE,
        idempotencyKey: key,
      })
      assert.equal(second.ok, true)
      if (!second.ok) return
      assert.equal(second.value.replayed, true)
      const eventsAfterSecond = harness.ledger.listEvents(P1, taskId)
      if (eventsAfterFirst.ok && eventsAfterSecond.ok) {
        assert.equal(eventsAfterSecond.value.length, eventsAfterFirst.value.length)
      }
    }))

  test(`[${name}] 项目隔离：跨项目读取/迁移返回 CROSS_PROJECT_DENIED`, () =>
    run(create, (harness) => {
      const task = createTask(harness)
      const read = harness.ledger.getTask(P2, task.taskId)
      assert.equal(read.ok, false)
      if (!read.ok) assert.equal(read.error.code, 'CROSS_PROJECT_DENIED')
      const write = harness.ledger.transition({
        projectId: P2,
        taskId: task.taskId,
        from: 'dispatched',
        to: 'accepted',
        actor: ASSIGNEE,
        idempotencyKey: nextKey(),
      })
      assert.equal(write.ok, false)
      if (!write.ok) assert.equal(write.error.code, 'CROSS_PROJECT_DENIED')
    }))
}

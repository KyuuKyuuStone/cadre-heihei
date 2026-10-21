/**
 * ADR-0019 supervisor 判定契约测试（内存与 SQLite 各跑一遍）。
 *
 * 六项：双 supervisor / 换届 / 代派 / 跨项目 / resolver 故障 / dispatcher 无影响。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  LedgerActor,
  SupervisorResolver,
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

export const P1 = 'adr-project-1' as ProjectId
export const P2 = 'adr-project-2' as ProjectId
export const SUP_MAIN = 'adr-supervisor-main' as SessionId
export const SUP_SECOND = 'adr-supervisor-second' as SessionId
export const SUP_OLD = 'adr-supervisor-old' as SessionId
export const SUP_NEW = 'adr-supervisor-new' as SessionId
export const EMP = 'adr-employee' as SessionId
export const DISPATCHER_WORKER = 'adr-dispatcher-worker' as SessionId

const ASSIGNEE: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
const SYSTEM: LedgerActor = { kind: 'system', onBehalfOf: EMP }
function supervisor(sessionId: SessionId): LedgerActor {
  return { kind: 'session', sessionId, role: 'supervisor' }
}

let taskSeq = 0
let keySeq = 0
function nextTaskId(): TaskId {
  return `adr-task-${++taskSeq}` as TaskId
}
function nextKey(): IdempotencyKey {
  return `adr-key-${++keySeq}` as IdempotencyKey
}
function clock(): () => IsoTimestamp {
  let tick = 0
  return () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
}

export interface SupervisorHarnessOptions {
  /** 花名册中的 supervisor；SQLite 会写入 members 表。 */
  readonly supervisors: readonly SessionId[]
  /** 故障注入/调用计数用；提供时替换产品 resolver。 */
  readonly supervisorResolver?: SupervisorResolver
}

export interface SupervisorHarness {
  readonly ledger: TaskLedgerPort
  close(): void
}
export type SupervisorHarnessFactory = (options: SupervisorHarnessOptions) => SupervisorHarness

function run(
  create: SupervisorHarnessFactory,
  options: SupervisorHarnessOptions,
  fn: (harness: SupervisorHarness) => void,
): void {
  const harness = create(options)
  try {
    fn(harness)
  } finally {
    harness.close()
  }
}

function createTask(
  harness: SupervisorHarness,
  options: {
    readonly dispatcherSessionId?: SessionId
    readonly assigneeSessionId?: SessionId
    readonly projectId?: ProjectId
  } = {},
): TaskRecord {
  const result = harness.ledger.createTask({
    projectId: options.projectId ?? P1,
    taskId: nextTaskId(),
    title: 'ADR-0019 任务',
    body: '正文',
    dispatcherSessionId: options.dispatcherSessionId ?? SUP_MAIN,
    assigneeSessionId: options.assigneeSessionId ?? EMP,
    idempotencyKey: nextKey(),
  })
  if (!result.ok) assert.fail(`createTask 失败：${result.error.code}`)
  return result.value.task
}

function transition(
  harness: SupervisorHarness,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
  projectId: ProjectId = P1,
) {
  const current = harness.ledger.getTask(projectId, taskId)
  if (!current.ok) assert.fail(`getTask 失败：${current.error.code}`)
  return harness.ledger.transition({
    projectId,
    taskId,
    from: current.value.status,
    to,
    actor,
    ...(to === 'rework' || to === 'failed' || to === 'cancelled' ? { reason: 'ADR 测试' } : {}),
    idempotencyKey: nextKey(),
  })
}

function mustTransition(
  harness: SupervisorHarness,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
): void {
  const result = transition(harness, taskId, to, actor)
  if (!result.ok) assert.fail(`迁移 → ${to} 失败：${result.error.code} ${result.error.message}`)
}

/** 准备到 review：dispatcher/assignee 可定制，review 由 preparer 执行。 */
function prepareReview(
  harness: SupervisorHarness,
  options: {
    readonly dispatcherSessionId?: SessionId
    readonly assigneeSessionId?: SessionId
    readonly preparer?: SessionId
  } = {},
): TaskId {
  const task = createTask(harness, options)
  mustTransition(harness, task.taskId, 'accepted', ASSIGNEE)
  mustTransition(harness, task.taskId, 'in_progress', ASSIGNEE)
  mustTransition(harness, task.taskId, 'delivered', SYSTEM)
  mustTransition(harness, task.taskId, 'review', supervisor(options.preparer ?? SUP_MAIN))
  return task.taskId
}

export function runSupervisorContract(name: string, create: SupervisorHarnessFactory): void {
  test(`[${name}] a. 同项目双 supervisor 均可验收`, () =>
    run(create, { supervisors: [SUP_MAIN, SUP_SECOND] }, (harness) => {
      const first = prepareReview(harness)
      const byMain = transition(harness, first, 'verified', supervisor(SUP_MAIN))
      assert.equal(byMain.ok, true)
      if (byMain.ok) assert.equal(byMain.value.task.status, 'verified')

      const second = prepareReview(harness)
      const bySecond = transition(harness, second, 'verified', supervisor(SUP_SECOND))
      assert.equal(bySecond.ok, true)
      if (bySecond.ok) assert.equal(bySecond.value.task.status, 'verified')
    }))

  test(`[${name}] b. 换届：旧 supervisor 被拒、新 supervisor 通过`, () =>
    run(create, { supervisors: [SUP_NEW] }, (harness) => {
      const taskId = prepareReview(harness, { preparer: SUP_NEW })
      const oldResult = transition(harness, taskId, 'verified', supervisor(SUP_OLD))
      assert.equal(oldResult.ok, false)
      if (!oldResult.ok) {
        assert.equal(oldResult.error.code, 'FORBIDDEN_ACTOR')
        assert.equal(oldResult.error.reasonCategory, 'not-supervisor')
        assert.equal(oldResult.error.requiredActor, 'supervisor')
        assert.equal(oldResult.error.actorSessionId, SUP_OLD)
      }
      const stateAfterOld = harness.ledger.getTask(P1, taskId)
      if (stateAfterOld.ok) assert.equal(stateAfterOld.value.status, 'review')

      const newResult = transition(harness, taskId, 'verified', supervisor(SUP_NEW))
      assert.equal(newResult.ok, true)
    }))

  test(`[${name}] c. 代派：dispatcher 非 supervisor 时被拒（即使它派了活）`, () =>
    run(create, { supervisors: [SUP_MAIN] }, (harness) => {
      const taskId = prepareReview(harness, { dispatcherSessionId: DISPATCHER_WORKER })
      const result = transition(harness, taskId, 'verified', supervisor(DISPATCHER_WORKER))
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.error.code, 'FORBIDDEN_ACTOR')
        assert.equal(result.error.reasonCategory, 'not-supervisor')
        assert.equal(result.error.requiredActor, 'supervisor')
        assert.equal(result.error.actorSessionId, DISPATCHER_WORKER)
      }
      const state = harness.ledger.getTask(P1, taskId)
      if (state.ok) assert.equal(state.value.status, 'review')
    }))

  test(`[${name}] d. 跨项目 supervisor 优先拒绝且不查花名册`, () =>
    run(
      create,
      {
        supervisors: [],
        supervisorResolver: {
          isSupervisor: () => {
            throw new Error('跨项目时不得调用花名册')
          },
        },
      },
      (harness) => {
        const task = createTask(harness)
        // 直接构造跨项目命令；不得先按 P2 读取任务（读取会提前返回，测不到解析顺序）。
        const result = harness.ledger.transition({
          projectId: P2,
          taskId: task.taskId,
          from: 'dispatched',
          to: 'accepted',
          actor: supervisor(SUP_MAIN),
          idempotencyKey: nextKey(),
        })
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.error.code, 'CROSS_PROJECT_DENIED')
          assert.equal(result.error.retryable, false)
          assert.equal('candidates' in result.error, false)
          assert.equal('taskId' in result.error, false)
          assert.equal('taskTitle' in result.error, false)
        }
        const state = harness.ledger.getTask(P1, task.taskId)
        if (state.ok) assert.equal(state.value.status, 'dispatched')
      },
    ))

  test(`[${name}] e. resolver 故障 fail-closed：INTERNAL_ERROR 且状态/事件不变`, () =>
    run(
      create,
      {
        supervisors: [SUP_MAIN],
        supervisorResolver: { isSupervisor: () => 'unavailable' },
      },
      (harness) => {
        // dispatched → cancelled 是 supervisor-only 迁移；resolver 不可用时必须在写库前失败。
        const task = createTask(harness)
        const eventsBefore = harness.ledger.listEvents(P1, task.taskId)
        const result = transition(harness, task.taskId, 'cancelled', supervisor(SUP_MAIN))
        assert.equal(result.ok, false)
        if (!result.ok) {
          assert.equal(result.error.code, 'INTERNAL_ERROR')
          assert.equal(result.error.retryable, false)
          assert.equal(result.error.rawCode, 'SUPERVISOR_RESOLVER_UNAVAILABLE')
        }
        const state = harness.ledger.getTask(P1, task.taskId)
        if (state.ok) assert.equal(state.value.status, 'dispatched')
        const eventsAfter = harness.ledger.listEvents(P1, task.taskId)
        if (eventsBefore.ok && eventsAfter.ok) {
          assert.equal(eventsAfter.value.length, eventsBefore.value.length)
        }
      },
    ))

  test(`[${name}] f. dispatcher/assignee 均非 supervisor：权限只认花名册`, () =>
    run(create, { supervisors: [SUP_MAIN] }, (harness) => {
      const taskId = prepareReview(harness, {
        dispatcherSessionId: DISPATCHER_WORKER,
        assigneeSessionId: EMP,
      })
      for (const sessionId of [DISPATCHER_WORKER, EMP]) {
        const denied = transition(harness, taskId, 'verified', supervisor(sessionId))
        assert.equal(denied.ok, false, `${sessionId} 不应获得 supervisor 权限`)
        if (!denied.ok) {
          assert.equal(denied.error.code, 'FORBIDDEN_ACTOR')
          assert.equal(denied.error.reasonCategory, 'not-supervisor')
        }
      }
      // 非 dispatcher 的在册 supervisor 仍可通过：dispatcher 字段不参与判定。
      const allowed = transition(harness, taskId, 'verified', supervisor(SUP_MAIN))
      assert.equal(allowed.ok, true)
    }))
}

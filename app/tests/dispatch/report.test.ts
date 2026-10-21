/**
 * 汇报内存实现契约测试（W1-06 第 8/9/10 条 + 幂等/跨项目）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskCandidateStatus, TaskId } from '../../src/collab/protocol/index.ts'
import {
  ASSIGNEE_ACTOR,
  SUPERVISOR_ACTOR,
  BINDING_EMP,
  BINDING_SUP,
  EMP,
  EMP2,
  EMP_P2,
  P1,
  P2,
  SUP2,
  assertEmptyList,
  dispatchOk,
  driveToInProgress,
  expectReportError,
  expectReportOk,
  independentReceipt,
  makeService,
  nextKey,
  reportInput,
  transitionTo,
} from './test-support.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

const CROSS_PROJECT_KEYS = ['code', 'message', 'projectId', 'retryable']

// —— 8. 漏 taskId ——
it('漏 taskId：无候选 → MISSING_TASK_ID + 空候选 + hint', () => {
  const { service } = makeService()
  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: undefined })),
  )
  assert.equal(error.error.code, 'MISSING_TASK_ID')
  assert.equal(error.error.retryable, false)
  if (error.error.code !== 'MISSING_TASK_ID') return
  assert.equal(error.error.projectId, P1)
  assert.deepEqual(error.error.candidates, [])
  assert.equal(error.error.candidateCount, 0)
  assert.equal(error.error.truncated, false)
  assert.ok(error.error.hint.length > 0)
  assertEmptyList(service.listMessages(P1), 'no_messages')
})

it('漏 taskId：候选只含同项目+同会话+非终态，按 updatedAt DESC', () => {
  const { service } = makeService()
  const first = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '任务一' })
  const second = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '任务二' })
  transitionTo(service, P1, second.taskId, 'accepted', ASSIGNEE_ACTOR)

  const third = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '任务三' })
  driveToInProgress(service, P1, third.taskId)

  const delivered = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '已交付' })
  driveToInProgress(service, P1, delivered.taskId)
  transitionTo(service, P1, delivered.taskId, 'delivered', ASSIGNEE_ACTOR)

  const verified = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '已验收' })
  driveToInProgress(service, P1, verified.taskId)
  transitionTo(service, P1, verified.taskId, 'delivered', ASSIGNEE_ACTOR)
  transitionTo(service, P1, verified.taskId, 'review', SUPERVISOR_ACTOR)
  transitionTo(service, P1, verified.taskId, 'verified', SUPERVISOR_ACTOR)

  // 其他会话的任务不得进入候选。
  dispatchOk(service, BINDING_SUP, { toSessionId: EMP2, title: '别人的任务' })

  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: undefined })),
  )
  assert.equal(error.error.code, 'MISSING_TASK_ID')
  if (error.error.code !== 'MISSING_TASK_ID') return

  assert.equal(error.error.candidateCount, 3)
  assert.equal(error.error.truncated, false)
  assert.deepEqual(
    error.error.candidates.map((candidate) => candidate.taskId),
    [third.taskId, second.taskId, first.taskId],
  )
  const allowed: readonly TaskCandidateStatus[] = ['dispatched', 'accepted', 'in_progress', 'rework']
  for (const candidate of error.error.candidates) {
    assert.ok(allowed.includes(candidate.status))
    assert.equal(candidate.assigneeSessionId, EMP)
    assert.ok(candidate.title.length > 0)
  }
})

it('漏 taskId：候选上限 10，candidateCount 为真实匹配数且 truncated=true', () => {
  const { service } = makeService()
  for (let i = 0; i < 12; i += 1) {
    dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: `任务-${i}` })
  }
  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: undefined })),
  )
  assert.equal(error.error.code, 'MISSING_TASK_ID')
  if (error.error.code !== 'MISSING_TASK_ID') return
  assert.equal(error.error.candidates.length, 10)
  assert.equal(error.error.candidateCount, 12)
  assert.equal(error.error.truncated, true)
})

it('漏 taskId：不自动挂靠，且不新增投递', () => {
  const { service } = makeService()
  dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  const before = service.listMessages(P1)
  assert.equal(before.empty, false)
  assert.equal(before.items.length, 1, '派活本身有 1 条消息')

  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: undefined })),
  )
  assert.equal(error.error.code, 'MISSING_TASK_ID')
  const after = service.listMessages(P1)
  assert.equal(after.empty, false)
  assert.equal(after.items.length, 1, '漏 taskId 不得投递任何消息')
})

// —— 3. 空正文（汇报同口径） ——
it('汇报空正文：EMPTY_BODY，不推进、不投递', () => {
  const { service } = makeService()
  const receipt = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, receipt.taskId)

  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: receipt.taskId, body: '   ' })),
  )
  assert.equal(error.error.code, 'EMPTY_BODY')
  const task = service.ledger.getTask(P1, receipt.taskId)
  assert.equal(task.ok, true)
  if (task.ok) assert.equal(task.value.status, 'in_progress')
  assert.equal(service.listMessages(P1).items.length, 1, '只有派活消息')
})

// —— 项目隔离与任务存在性 ——
it('汇报跨项目：请求 projectId 不一致 → CROSS_PROJECT_DENIED 且无泄露字段', () => {
  const { service } = makeService()
  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ projectId: P2, taskId: 'x' as TaskId })),
  )
  assert.equal(error.error.code, 'CROSS_PROJECT_DENIED')
  assert.deepEqual(Object.keys(error.error).sort(), CROSS_PROJECT_KEYS)
  assert.equal('candidates' in error.error, false)
  assert.equal('taskId' in error.error, false)
})

it('汇报 taskId 不存在 → TASK_NOT_FOUND，不投递', () => {
  const { service } = makeService()
  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: 'missing' as TaskId })),
  )
  assert.equal(error.error.code, 'TASK_NOT_FOUND')
  if (error.error.code !== 'TASK_NOT_FOUND') return
  assert.equal(error.error.taskId, 'missing')
  assertEmptyList(service.listMessages(P1), 'no_messages')
})

it('汇报 taskId 属于其他项目 → CROSS_PROJECT_DENIED，不泄露 taskId', () => {
  const { service } = makeService()
  const foreign = service.ledger.createTask({
    projectId: P2,
    taskId: 'p2-task' as TaskId,
    title: '他项目任务',
    body: '正文',
    dispatcherSessionId: SUP2,
    assigneeSessionId: EMP_P2,
    idempotencyKey: nextKey(),
  })
  assert.equal(foreign.ok, true)

  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: 'p2-task' as TaskId })),
  )
  assert.equal(error.error.code, 'CROSS_PROJECT_DENIED')
  assert.deepEqual(Object.keys(error.error).sort(), CROSS_PROJECT_KEYS)
  assert.equal('taskId' in error.error, false)
})

// —— 9. 台账推进 ——
it('汇报推进：in_progress → delivered，ledgerUpdated=true', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, dispatched.taskId)

  const body = '完成\r\n😀'
  const receipt = expectReportOk(
    service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body })),
  )
  assert.equal(receipt.ledgerUpdated, true)
  assert.equal(receipt.taskStatusBefore, 'in_progress')
  assert.equal(receipt.taskStatusAfter, 'delivered')
  assert.equal(receipt.bodyBytes, independentReceipt(body).bodyBytes)
  assert.equal(receipt.bodySha256, independentReceipt(body).bodySha256)
  assert.equal(receipt.preview, independentReceipt(body).preview)

  const task = service.ledger.getTask(P1, dispatched.taskId)
  assert.equal(task.ok, true)
  if (task.ok) assert.equal(task.value.status, 'delivered')
})

it('汇报推进失败：非 in_progress → ok=true + ledgerUpdated=false + ledgerError', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  transitionTo(service, P1, dispatched.taskId, 'accepted', ASSIGNEE_ACTOR)

  const receipt = expectReportOk(
    service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId })),
  )
  assert.equal(receipt.ok, true)
  assert.equal(receipt.ledgerUpdated, false)
  if (receipt.ledgerUpdated) return
  assert.match(receipt.ledgerError, /INVALID_TRANSITION/)
  assert.equal(receipt.taskStatusBefore, 'accepted')
  assert.equal(receipt.taskStatusAfter, 'accepted')

  const task = service.ledger.getTask(P1, dispatched.taskId)
  assert.equal(task.ok, true)
  if (task.ok) assert.equal(task.value.status, 'accepted', '台账不得被伪推进')

  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 2, '消息仍应投递')
  assert.equal(messages.items.at(-1)?.direction, 'report')
})

it('汇报推进失败：已 delivered 再汇报同样不伪报成功', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, dispatched.taskId)
  expectReportOk(service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body: '第一次' })))

  const second = expectReportOk(
    service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body: '第二次' })),
  )
  assert.equal(second.ok, true)
  assert.equal(second.ledgerUpdated, false)
  if (!second.ledgerUpdated) assert.match(second.ledgerError, /INVALID_TRANSITION/)
  assert.equal(second.taskStatusBefore, 'delivered')
  assert.equal(second.taskStatusAfter, 'delivered')
})

// —— 幂等 ——
it('汇报幂等：同键同请求返回首次回执，不重复推进/投递', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, dispatched.taskId)

  const key = nextKey()
  const request = reportInput({ taskId: dispatched.taskId, body: '完成', idempotencyKey: key })
  const first = expectReportOk(service.report(BINDING_EMP, request))
  const eventsAfterFirst = service.ledger.listEvents(P1, dispatched.taskId)
  assert.equal(eventsAfterFirst.ok, true)

  const second = expectReportOk(service.report(BINDING_EMP, request))
  assert.deepEqual(second, first)
  assert.equal(second.messageId, first.messageId)
  assert.equal(second.deliveredAt, first.deliveredAt)

  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 2, '派活 1 + 汇报 1，重放不新增')
  const eventsAfterSecond = service.ledger.listEvents(P1, dispatched.taskId)
  assert.equal(eventsAfterSecond.ok, true)
  if (eventsAfterFirst.ok && eventsAfterSecond.ok) {
    assert.equal(eventsAfterSecond.value.length, eventsAfterFirst.value.length)
  }
})

it('汇报幂等：同键不同正文 → IDEMPOTENCY_CONFLICT', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, dispatched.taskId)
  const key = nextKey()
  expectReportOk(service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body: '甲', idempotencyKey: key })))
  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body: '乙', idempotencyKey: key })),
  )
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT')
  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 2)
})

it('幂等：派活与汇报共用键空间，同键跨操作 → IDEMPOTENCY_CONFLICT', () => {
  const { service } = makeService()
  const key = nextKey()
  const dispatched = dispatchOk(service, BINDING_SUP, {
    toSessionId: EMP,
    idempotencyKey: key,
  })
  driveToInProgress(service, P1, dispatched.taskId)

  const error = expectReportError(
    service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, idempotencyKey: key })),
  )
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT')
})

it('汇报幂等：deliverables 不同视为不同请求', () => {
  const { service } = makeService()
  const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  driveToInProgress(service, P1, dispatched.taskId)
  const key = nextKey()
  expectReportOk(
    service.report(
      BINDING_EMP,
      reportInput({ taskId: dispatched.taskId, idempotencyKey: key, deliverables: ['a.ts'] }),
    ),
  )
  const error = expectReportError(
    service.report(
      BINDING_EMP,
      reportInput({ taskId: dispatched.taskId, idempotencyKey: key, deliverables: ['b.ts'] }),
    ),
  )
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT')
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})

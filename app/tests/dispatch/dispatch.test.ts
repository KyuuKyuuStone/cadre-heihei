/**
 * 派活内存实现契约测试（W1-06 第 1/2/3/4/5/6/7/10 条）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskId } from '../../src/collab/protocol/index.ts'
import {
  BINDING_EMP,
  BINDING_EMP2,
  BINDING_SUP,
  BINDING_SUP2,
  EMP,
  EMP2,
  EMP_P2,
  GHOST,
  OFFLINE,
  P1,
  P2,
  STRANGER,
  SUP2,
  assertEmptyList,
  dispatchOk,
  dispatchRequest,
  driveToInProgress,
  expectDispatchError,
  expectDispatchOk,
  independentReceipt,
  makeService,
  nextKey,
  transitionTo,
  ASSIGNEE_ACTOR,
  SUPERVISOR_ACTOR,
} from './test-support.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

const CROSS_PROJECT_KEYS = ['code', 'message', 'projectId', 'retryable']

// —— 1. 会话绑定与跨项目不泄露 ——
it('跨项目：请求 projectId 与绑定不一致 → CROSS_PROJECT_DENIED 且无泄露字段', () => {
  const { service } = makeService()
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ projectId: P2 })),
  )
  assert.equal(error.error.code, 'CROSS_PROJECT_DENIED')
  assert.equal(error.error.retryable, false)
  assert.deepEqual(Object.keys(error.error).sort(), CROSS_PROJECT_KEYS)
  for (const field of ['candidates', 'taskId', 'taskTitle', 'taskExists', 'exists']) {
    assert.equal(field in error.error, false, `跨项目错误不得含 ${field}`)
  }
  assert.equal(service.ledger.listTasks(P1).length, 0)
  assertEmptyList(service.listMessages(P1), 'no_messages')
})

it('跨项目：未知 projectId 与已知他项目返回完全相同的错误形状', () => {
  const { service } = makeService()
  const known = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ projectId: P2 })),
  )
  const unknown = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ projectId: GHOST })),
  )
  assert.deepEqual(unknown.error, known.error, '不得因项目是否存在而改变错误')
  assert.deepEqual(Object.keys(unknown.error).sort(), CROSS_PROJECT_KEYS)
})

// —— 2. 目标成员 ——
it('目标成员：非本项目会话 → FORBIDDEN_ACTOR target-not-member', () => {
  const { service } = makeService()
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: STRANGER })),
  )
  assert.equal(error.error.code, 'FORBIDDEN_ACTOR')
  assert.equal(error.error.retryable, false)
  if (error.error.code !== 'FORBIDDEN_ACTOR') return
  assert.equal(error.error.reasonCategory, 'target-not-member')
  assert.equal(error.error.projectId, P1)
  assert.equal(error.error.targetSessionId, STRANGER)
})

it('目标成员：成员在但 offline → FORBIDDEN_ACTOR target-offline', () => {
  const { service } = makeService()
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: OFFLINE })),
  )
  assert.equal(error.error.code, 'FORBIDDEN_ACTOR')
  if (error.error.code !== 'FORBIDDEN_ACTOR') return
  assert.equal(error.error.reasonCategory, 'target-offline')
})

it('目标成员：他项目会话不可被本项目派活', () => {
  const { service } = makeService()
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP_P2 })),
  )
  assert.equal(error.error.code, 'FORBIDDEN_ACTOR')
  if (error.error.code !== 'FORBIDDEN_ACTOR') return
  assert.equal(error.error.reasonCategory, 'target-not-member')
})

it('目标成员：本项目可用成员可派活', () => {
  const { service } = makeService()
  const receipt = dispatchOk(service, BINDING_SUP, { toSessionId: EMP2 })
  assert.equal(receipt.taskStatus, 'dispatched')
  assert.equal(service.ledger.listTasks(P1).length, 1)
})

// —— 3. 空正文 ——
const EMPTY_BODIES = ['', '   ', '\r\n\t', '\uFEFF   ']
for (const body of EMPTY_BODIES) {
  it(`空正文：${JSON.stringify(body)} → EMPTY_BODY 且不落库不投递`, () => {
    const { service } = makeService()
    const error = expectDispatchError(
      service.dispatch(BINDING_SUP, dispatchRequest({ body })),
    )
    assert.equal(error.error.code, 'EMPTY_BODY')
    assert.equal(error.error.retryable, false)
    if (error.error.code !== 'EMPTY_BODY') return
    assert.equal(error.error.field, 'body')
    assert.equal(service.ledger.listTasks(P1).length, 0)
    assertEmptyList(service.listMessages(P1), 'no_messages')
  })
}

// —— 4. 客户端命令 ——
it('客户端命令：/compact 与 /CLEAR 在派活入口拒绝', () => {
  for (const body of ['/compact', '  /clear now', '/CLEAR']) {
    const { service } = makeService()
    const error = expectDispatchError(
      service.dispatch(BINDING_SUP, dispatchRequest({ body })),
    )
    assert.equal(error.error.code, 'CLIENT_COMMAND_REJECTED')
    assert.equal(error.error.retryable, false)
    assert.equal(service.ledger.listTasks(P1).length, 0)
    assertEmptyList(service.listMessages(P1), 'no_messages')
  }
})

it('客户端命令：代码块内的 /compact 放行（只检查首个 token）', () => {
  const { service } = makeService()
  const receipt = dispatchOk(service, BINDING_SUP, { body: '```\n/compact\n```' })
  assert.equal(receipt.taskStatus, 'dispatched')
})

// —— 5. 回执自证 ——
it('回执自证：bodyBytes/bodySha256/preview 对实收原样正文计算', () => {
  const { service } = makeService()
  const body = `第一行\r\n${'a'.repeat(44)}😀结尾`
  const receipt = dispatchOk(service, BINDING_SUP, { body })
  const expected = independentReceipt(body)

  assert.equal(receipt.bodyBytes, expected.bodyBytes)
  assert.equal(receipt.bodySha256, expected.bodySha256)
  assert.equal(receipt.preview, expected.preview)
  assert.equal([...receipt.preview].length, 50)
  assert.equal(receipt.preview.endsWith('😀'), true)
  assert.equal(receipt.channel, 'http')
  assert.equal(receipt.ledgerUpdated, true)
  assert.equal(receipt.serverVersion, 'test-server')

  const task = service.ledger.getTask(P1, receipt.taskId)
  assert.equal(task.ok, true)
  if (task.ok) assert.equal(task.value.body, body, '正文不得做换行规范化')
})

it('回执自证：BOM 原样进入 bodyBytes 与哈希', () => {
  const { service } = makeService()
  const body = '\uFEFF你好'
  const receipt = dispatchOk(service, BINDING_SUP, { body })
  assert.equal(receipt.bodyBytes, 9)
  assert.equal(receipt.preview.codePointAt(0), 0xfeff)
  assert.equal(receipt.bodySha256, independentReceipt(body).bodySha256)
})

// —— 6. 幂等 ——
it('幂等：同键同请求重放返回首次回执，不重新投递', () => {
  const { service } = makeService()
  const key = nextKey()
  const request = dispatchRequest({ idempotencyKey: key, body: '同一正文' })
  const first = expectDispatchOk(service.dispatch(BINDING_SUP, request))
  const second = expectDispatchOk(service.dispatch(BINDING_SUP, request))

  assert.deepEqual(second, first)
  assert.equal(second.messageId, first.messageId)
  assert.equal(second.deliveredAt, first.deliveredAt)
  assert.equal(service.ledger.listTasks(P1).length, 1)

  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 1, '重放不得新增消息')
})

it('幂等：同键不同正文 → IDEMPOTENCY_CONFLICT，旧消息不受影响', () => {
  const { service } = makeService()
  const key = nextKey()
  expectDispatchOk(service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key, body: '第一次' })))
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key, body: '第二次' })),
  )
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(error.error.retryable, false)
  if (error.error.code !== 'IDEMPOTENCY_CONFLICT') return
  assert.equal(error.error.idempotencyKey, key)
  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 1)
})

it('幂等：同键不同标题/目标同样视为不同请求', () => {
  const { service } = makeService()
  const key = nextKey()
  expectDispatchOk(
    service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key, title: '标题一' })),
  )
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key, title: '标题二' })),
  )
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT')
})

it('幂等：键按项目隔离，同键在另一项目可独立使用', () => {
  const { service } = makeService()
  const key = nextKey()
  const first = expectDispatchOk(
    service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key })),
  )
  const second = expectDispatchOk(
    service.dispatch(BINDING_SUP2, dispatchRequest({ projectId: P2, toSessionId: EMP_P2, idempotencyKey: key })),
  )
  assert.notEqual(first.taskId, second.taskId)
  assert.equal(service.ledger.listTasks(P1).length, 1)
  assert.equal(service.ledger.listTasks(P2).length, 1)
})

// —— 7. supersedes ——
it('取代：旧任务 cancelled + reason=superseded，回执含 supersededTask', () => {
  const { service } = makeService()
  const old = dispatchOk(service, BINDING_SUP, { title: '旧任务' })
  const receipt = dispatchOk(service, BINDING_SUP, {
    title: '新任务',
    supersedesTaskId: old.taskId,
  })

  assert.deepEqual(receipt.supersededTask, {
    taskId: old.taskId,
    status: 'cancelled',
    reason: 'superseded',
  })
  const oldAfter = service.ledger.getTask(P1, old.taskId)
  assert.equal(oldAfter.ok, true)
  if (!oldAfter.ok) return
  assert.equal(oldAfter.value.status, 'cancelled')
  assert.equal(oldAfter.value.supersededByTaskId, receipt.taskId)

  const newAfter = service.ledger.getTask(P1, receipt.taskId)
  assert.equal(newAfter.ok, true)
  if (newAfter.ok) assert.equal(newAfter.value.supersedesTaskId, old.taskId)

  const events = service.ledger.listEvents(P1, old.taskId)
  assert.equal(events.ok, true)
  if (events.ok) {
    assert.equal(events.value.at(-1)?.toStatus, 'cancelled')
    assert.equal(events.value.at(-1)?.reason, 'superseded')
  }
})

it('取代：旧任务不存在 → TASK_NOT_FOUND，不投递不建新任务', () => {
  const { service } = makeService()
  const missing = 'task-missing' as TaskId
  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ supersedesTaskId: missing })),
  )
  assert.equal(error.error.code, 'TASK_NOT_FOUND')
  if (error.error.code !== 'TASK_NOT_FOUND') return
  assert.equal(error.error.taskId, missing)
  assert.equal(service.ledger.listTasks(P1).length, 0)
  assertEmptyList(service.listMessages(P1), 'no_messages')
})

it('取代：旧任务已是终态 → INVALID_TRANSITION，不投递', () => {
  const { service } = makeService()
  const old = dispatchOk(service, BINDING_SUP, { title: '旧任务' })
  driveToInProgress(service, P1, old.taskId)
  transitionTo(service, P1, old.taskId, 'delivered', ASSIGNEE_ACTOR)
  transitionTo(service, P1, old.taskId, 'review', SUPERVISOR_ACTOR)
  transitionTo(service, P1, old.taskId, 'verified', SUPERVISOR_ACTOR)

  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ supersedesTaskId: old.taskId })),
  )
  assert.equal(error.error.code, 'INVALID_TRANSITION')
  assert.equal(service.ledger.listTasks(P1).length, 1, '不得创建新任务')
  assert.equal(service.listMessages(P1).items.length, 1, '只有旧任务那次派活消息')
})

it('取代：旧任务属于其他项目 → CROSS_PROJECT_DENIED 且不泄露 taskId', () => {
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

  const error = expectDispatchError(
    service.dispatch(BINDING_SUP, dispatchRequest({ supersedesTaskId: 'p2-task' as TaskId })),
  )
  assert.equal(error.error.code, 'CROSS_PROJECT_DENIED')
  assert.deepEqual(Object.keys(error.error).sort(), CROSS_PROJECT_KEYS)
  assert.equal('taskId' in error.error, false)
  assert.equal(service.ledger.listTasks(P1).length, 0)
})

// —— 10. 空集合 ——
it('空集合：消息列表为空时 empty+reason+hint，非空时 empty=false', () => {
  const { service } = makeService()
  assertEmptyList(service.listMessages(P1), 'no_messages')

  const receipt = dispatchOk(service, BINDING_SUP)
  const messages = service.listMessages(P1)
  assert.equal(messages.empty, false)
  assert.equal(messages.items.length, 1)
  assert.equal(messages.items[0]?.taskId, receipt.taskId)
  assert.equal(messages.items[0]?.direction, 'dispatch')
  assert.equal(messages.items[0]?.toSessionId, EMP)
})

it('空集合：汇报候选为空时 empty+reason+hint', () => {
  const { service } = makeService()
  assertEmptyList(service.listReportCandidates(BINDING_EMP), 'no_candidates')
  // 派给别人的任务不进入我的候选。
  dispatchOk(service, BINDING_SUP, { toSessionId: EMP2 })
  assertEmptyList(service.listReportCandidates(BINDING_EMP), 'no_candidates')
})

it('空集合：有候选时 empty=false 且只含本会话任务', () => {
  const { service } = makeService()
  const mine = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
  dispatchOk(service, BINDING_SUP, { toSessionId: EMP2 })
  const candidates = service.listReportCandidates(BINDING_EMP)
  assert.equal(candidates.empty, false)
  assert.equal(candidates.items.length, 1)
  assert.equal(candidates.items[0]?.taskId, mine.taskId)
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})

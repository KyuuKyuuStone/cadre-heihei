/**
 * 派活/汇报契约测试（实现无关）：内存与 SQLite 各跑一遍。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DispatchService } from '../../src/collab/dispatch/index.ts'
import type { TaskId } from '../../src/collab/protocol/index.ts'
import {
  ASSIGNEE_ACTOR,
  BINDING_EMP,
  BINDING_SUP,
  EMP,
  EMP2,
  GHOST,
  OFFLINE,
  P1,
  P2,
  STRANGER,
  SYSTEM_ACTOR,
  assertEmptyList,
  dispatchOk,
  dispatchRequest,
  driveToInProgress,
  expectDispatchError,
  expectDispatchOk,
  expectReportError,
  expectReportOk,
  independentReceipt,
  nextKey,
  reportInput,
  transitionTo,
} from './test-support.ts'

export interface DispatchHarness {
  readonly service: DispatchService
  close(): void
}
export type DispatchHarnessFactory = () => DispatchHarness

function run(create: DispatchHarnessFactory, fn: (harness: DispatchHarness) => void): void {
  const harness = create()
  try {
    fn(harness)
  } finally {
    harness.close()
  }
}

const CROSS_PROJECT_KEYS = ['code', 'message', 'projectId', 'retryable']

export function runDispatchContract(name: string, create: DispatchHarnessFactory): void {
  test(`[${name}] 派活成功：回执自证、任务与消息落库`, () =>
    run(create, ({ service }) => {
      const body = '第一行\r\n完成😀'
      const receipt = dispatchOk(service, BINDING_SUP, { body })
      const expected = independentReceipt(body)
      assert.equal(receipt.bodyBytes, expected.bodyBytes)
      assert.equal(receipt.bodySha256, expected.bodySha256)
      assert.equal(receipt.preview, expected.preview)
      assert.equal(receipt.ledgerUpdated, true)
      assert.equal(receipt.taskStatus, 'dispatched')

      const task = service.ledger.getTask(P1, receipt.taskId)
      assert.equal(task.ok, true)
      if (task.ok) assert.equal(task.value.body, body)
      const messages = service.listMessages(P1)
      assert.equal(messages.empty, false)
      assert.equal(messages.items.length, 1)
      assert.equal(messages.items[0]?.messageId, receipt.messageId)
    }))

  test(`[${name}] 跨项目：拒绝且不泄露存在性`, () =>
    run(create, ({ service }) => {
      const known = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ projectId: P2 })),
      )
      const unknown = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ projectId: GHOST })),
      )
      assert.equal(known.error.code, 'CROSS_PROJECT_DENIED')
      assert.deepEqual(Object.keys(known.error).sort(), CROSS_PROJECT_KEYS)
      assert.deepEqual(unknown.error, known.error)
      for (const field of ['candidates', 'taskId', 'taskTitle', 'taskExists']) {
        assert.equal(field in known.error, false)
      }
    }))

  test(`[${name}] 目标成员：offline 与非成员均 FORBIDDEN_ACTOR`, () =>
    run(create, ({ service }) => {
      const offline = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: OFFLINE })),
      )
      assert.equal(offline.error.code, 'FORBIDDEN_ACTOR')
      if (offline.error.code === 'FORBIDDEN_ACTOR') {
        assert.equal(offline.error.reasonCategory, 'target-offline')
      }
      const stranger = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: STRANGER })),
      )
      assert.equal(stranger.error.code, 'FORBIDDEN_ACTOR')
      if (stranger.error.code === 'FORBIDDEN_ACTOR') {
        assert.equal(stranger.error.reasonCategory, 'target-not-member')
      }
    }))

  test(`[${name}] 空正文与客户端命令：拒绝且不投递`, () =>
    run(create, ({ service }) => {
      const empty = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ body: '   ' })),
      )
      assert.equal(empty.error.code, 'EMPTY_BODY')
      const command = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ body: '  /CLEAR now' })),
      )
      assert.equal(command.error.code, 'CLIENT_COMMAND_REJECTED')
      assertEmptyList(service.listMessages(P1), 'no_messages')
      assert.equal(service.ledger.listTasks(P1).length, 0)
    }))

  test(`[${name}] 派活幂等：重放回执全等、不重复投递；不同正文冲突`, () =>
    run(create, ({ service }) => {
      const key = nextKey()
      const request = dispatchRequest({ idempotencyKey: key, body: '同一正文' })
      const first = expectDispatchOk(service.dispatch(BINDING_SUP, request))
      const second = expectDispatchOk(service.dispatch(BINDING_SUP, request))
      assert.deepEqual(second, first)
      assert.equal(service.ledger.listTasks(P1).length, 1)
      const messages = service.listMessages(P1)
      assert.equal(messages.empty, false)
      assert.equal(messages.items.length, 1)

      const conflict = expectDispatchError(
        service.dispatch(BINDING_SUP, dispatchRequest({ idempotencyKey: key, body: '不同正文' })),
      )
      assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
    }))

  test(`[${name}] supersedes：回执带旧任务且旧任务已取消`, () =>
    run(create, ({ service }) => {
      const oldTask = dispatchOk(service, BINDING_SUP, { title: '旧任务' })
      const receipt = dispatchOk(service, BINDING_SUP, {
        title: '新任务',
        supersedesTaskId: oldTask.taskId,
      })
      assert.deepEqual(receipt.supersededTask, {
        taskId: oldTask.taskId,
        status: 'cancelled',
        reason: 'superseded',
      })
      const oldAfter = service.ledger.getTask(P1, oldTask.taskId)
      assert.equal(oldAfter.ok, true)
      if (oldAfter.ok) {
        assert.equal(oldAfter.value.status, 'cancelled')
        assert.equal(oldAfter.value.supersededByTaskId, receipt.taskId)
      }
    }))

  test(`[${name}] 漏 taskId：候选范围、排序与 delivered 排除`, () =>
    run(create, ({ service }) => {
      const first = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '一' })
      const second = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '二' })
      transitionTo(service, P1, second.taskId, 'accepted', ASSIGNEE_ACTOR)
      const third = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '三' })
      driveToInProgress(service, P1, third.taskId)

      const delivered = dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: '已交付' })
      driveToInProgress(service, P1, delivered.taskId)
      transitionTo(service, P1, delivered.taskId, 'delivered', SYSTEM_ACTOR)
      dispatchOk(service, BINDING_SUP, { toSessionId: EMP2, title: '别人的' })

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
      assert.ok(error.error.hint.length > 0)
      const messages = service.listMessages(P1)
      assert.equal(messages.empty, false)
      assert.equal(
        messages.items.length,
        5,
        '5 次派活各 1 条；漏 taskId 不得新增汇报消息',
      )
    }))

  test(`[${name}] 漏 taskId：候选上限 10 且 candidateCount 为真实总数`, () =>
    run(create, ({ service }) => {
      for (let index = 0; index < 12; index += 1) {
        dispatchOk(service, BINDING_SUP, { toSessionId: EMP, title: `任务-${index}` })
      }
      const error = expectReportError(
        service.report(BINDING_EMP, reportInput({ taskId: undefined })),
      )
      assert.equal(error.error.code, 'MISSING_TASK_ID')
      if (error.error.code !== 'MISSING_TASK_ID') return
      assert.equal(error.error.candidates.length, 10)
      assert.equal(error.error.candidateCount, 12)
      assert.equal(error.error.truncated, true)
    }))

  test(`[${name}] 汇报推进：in_progress→delivered，ledgerUpdated=true`, () =>
    run(create, ({ service }) => {
      const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
      driveToInProgress(service, P1, dispatched.taskId)
      const receipt = expectReportOk(
        service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId, body: '完成' })),
      )
      assert.equal(receipt.ledgerUpdated, true)
      assert.equal(receipt.taskStatusBefore, 'in_progress')
      assert.equal(receipt.taskStatusAfter, 'delivered')
      const task = service.ledger.getTask(P1, dispatched.taskId)
      if (task.ok) assert.equal(task.value.status, 'delivered')
    }))

  test(`[${name}] 汇报推进失败：ok=true + ledgerUpdated=false + ledgerError`, () =>
    run(create, ({ service }) => {
      const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
      transitionTo(service, P1, dispatched.taskId, 'accepted', ASSIGNEE_ACTOR)
      const receipt = expectReportOk(
        service.report(BINDING_EMP, reportInput({ taskId: dispatched.taskId })),
      )
      assert.equal(receipt.ok, true)
      assert.equal(receipt.ledgerUpdated, false)
      if (!receipt.ledgerUpdated) assert.match(receipt.ledgerError, /INVALID_TRANSITION/)
      assert.equal(receipt.taskStatusBefore, 'accepted')
      assert.equal(receipt.taskStatusAfter, 'accepted')
      const task = service.ledger.getTask(P1, dispatched.taskId)
      if (task.ok) assert.equal(task.value.status, 'accepted')
    }))

  test(`[${name}] 汇报幂等：重放回执全等且不重复推进`, () =>
    run(create, ({ service }) => {
      const dispatched = dispatchOk(service, BINDING_SUP, { toSessionId: EMP })
      driveToInProgress(service, P1, dispatched.taskId)
      const key = nextKey()
      const request = reportInput({ taskId: dispatched.taskId, body: '完成', idempotencyKey: key })
      const first = expectReportOk(service.report(BINDING_EMP, request))
      const second = expectReportOk(service.report(BINDING_EMP, request))
      assert.deepEqual(second, first)
      const messages = service.listMessages(P1)
      assert.equal(messages.empty, false)
      assert.equal(messages.items.length, 2, '派活 1 + 汇报 1')
    }))

  test(`[${name}] 汇报错误：任务不存在与跨项目`, () =>
    run(create, ({ service }) => {
      const missing = expectReportError(
        service.report(BINDING_EMP, reportInput({ taskId: 'missing' as TaskId })),
      )
      assert.equal(missing.error.code, 'TASK_NOT_FOUND')
      const cross = expectReportError(
        service.report(BINDING_EMP, reportInput({ projectId: P2, taskId: 'x' as TaskId })),
      )
      assert.equal(cross.error.code, 'CROSS_PROJECT_DENIED')
      assert.deepEqual(Object.keys(cross.error).sort(), CROSS_PROJECT_KEYS)
    }))

  test(`[${name}] 空集合：消息与候选均带 reason/hint`, () =>
    run(create, ({ service }) => {
      assertEmptyList(service.listMessages(P1), 'no_messages')
      assertEmptyList(service.listReportCandidates(BINDING_EMP), 'no_candidates')
    }))
}

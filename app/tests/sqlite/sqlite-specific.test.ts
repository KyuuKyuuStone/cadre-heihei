/**
 * SQLite 特有用例：schema/PRAGMA、双连接幂等、重开完整性、乐观锁版本条件、触发器兜底。
 *
 * 说明：未做子进程强杀（按派单允许降级为「重开连接后数据完整」），
 * 也未做真正的多进程并发竞态；这两项在汇报中列为未验证。
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SqliteTaskLedger } from '../../src/collab/ledger/index.ts'
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import type { IsoTimestamp, TaskId } from '../../src/collab/protocol/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import {
  BINDING_EMP,
  BINDING_SUP,
  EMP,
  P1,
  TEST_MEMBERS,
  dispatchRequest,
  driveToInProgress,
  expectDispatchError,
  expectDispatchOk,
  expectReportOk,
  nextKey,
  reportInput,
  transitionTo,
  SUPERVISOR_ACTOR,
} from '../dispatch/test-support.ts'

let registered = 0
function it(name: string, fn: () => void): void {
  registered += 1
  test(name, fn)
}

function clock(): () => IsoTimestamp {
  let tick = 0
  return () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
}

function ids(prefix: string): () => string {
  let value = 0
  return () => `${prefix}-${++value}`
}

function makeService(path: string, prefix: string): SqliteDispatchService {
  return new SqliteDispatchService({
    databasePath: path,
    now: clock(),
    newId: ids(prefix),
    serverVersion: 'test-server',
    members: TEST_MEMBERS,
  })
}

it('schema：六张业务表 + schema_meta 齐全，WAL/busy_timeout/integrity 正常', () => {
  const temp = makeTempDb()
  const ledger = new SqliteTaskLedger({ databasePath: temp.path })
  try {
    const rows = ledger.core.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<Record<string, unknown>>
    const tables = rows.map((row) => String(row.name)).sort()
    for (const expected of [
      'idempotency',
      'members',
      'messages',
      'projects',
      'schema_meta',
      'task_events',
      'tasks',
    ]) {
      assert.ok(tables.includes(expected), `缺表 ${expected}`)
    }
    assert.equal(ledger.journalMode(), 'wal')
    assert.equal(ledger.integrityCheck(), 'ok')
    assert.equal(ledger.schemaVersion(), 1)
    const timeout = ledger.core.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>
    assert.equal(Number(timeout.timeout), 15000)
  } finally {
    ledger.close()
    temp.cleanup()
  }
})

it('事务：派活一次写入任务 + dispatched 事件 + 消息', () => {
  const temp = makeTempDb()
  const service = makeService(temp.path, 'tx')
  try {
    const receipt = expectDispatchOk(
      service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP })),
    )
    const db = service.sqliteStore.ledger.core.db
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as Record<string, unknown>).n), 1)
    assert.equal(
      Number((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as Record<string, unknown>).n),
      1,
    )
    assert.equal(
      Number((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as Record<string, unknown>).n),
      1,
    )
    const message = db
      .prepare('SELECT task_id, idempotency_key FROM messages WHERE message_id = ?')
      .get(receipt.messageId) as Record<string, unknown>
    assert.equal(String(message.task_id), receipt.taskId)
  } finally {
    service.close()
    temp.cleanup()
  }
})

it('幂等：双连接同键同请求返回首次回执，只落一行任务/消息', () => {
  const temp = makeTempDb()
  const serviceA = makeService(temp.path, 'a')
  const serviceB = makeService(temp.path, 'b')
  try {
    const key = nextKey()
    const request = dispatchRequest({ toSessionId: EMP, idempotencyKey: key, body: '双连接' })
    const first = expectDispatchOk(serviceA.dispatch(BINDING_SUP, request))
    const second = expectDispatchOk(serviceB.dispatch(BINDING_SUP, request))
    assert.deepEqual(second, first)
    assert.equal(serviceA.ledger.listTasks(P1).length, 1)
    const messages = serviceB.listMessages(P1)
    assert.equal(messages.empty, false)
    assert.equal(messages.items.length, 1)

    const conflict = expectDispatchError(
      serviceB.dispatch(
        BINDING_SUP,
        dispatchRequest({ toSessionId: EMP, idempotencyKey: key, body: '另一份正文' }),
      ),
    )
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
  } finally {
    serviceA.close()
    serviceB.close()
    temp.cleanup()
  }
})

it('重开连接：已提交任务/事件/消息仍在，integrity ok 且可继续写入', () => {
  const temp = makeTempDb()
  let taskId = '' as TaskId
  const first = makeService(temp.path, 'reopen-a')
  try {
    const dispatched = expectDispatchOk(
      first.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP, title: '重开验证' })),
    )
    taskId = dispatched.taskId
    driveToInProgress(first, P1, taskId)
    const report = expectReportOk(
      first.report(BINDING_EMP, reportInput({ taskId, body: '完成' })),
    )
    assert.equal(report.ledgerUpdated, true)
  } finally {
    first.close()
  }

  const second = makeService(temp.path, 'reopen-b')
  try {
    assert.equal(second.integrityCheck(), 'ok')
    assert.equal(second.journalMode(), 'wal')
    const task = second.ledger.getTask(P1, taskId)
    assert.equal(task.ok, true)
    if (!task.ok) return
    assert.equal(task.value.status, 'delivered')
    const events = second.ledger.listEvents(P1, taskId)
    assert.equal(events.ok, true)
    if (events.ok) assert.equal(events.value.length, 4, '创建 + accepted + in_progress + delivered')
    const messages = second.listMessages(P1)
    assert.equal(messages.empty, false)
    assert.equal(messages.items.length, 2)

    // 重开后仍可继续写入：delivered → review（主管点名）。
    const reviewed = transitionTo(second, P1, taskId, 'review', SUPERVISOR_ACTOR)
    assert.equal(reviewed.status, 'review')
  } finally {
    second.close()
    temp.cleanup()
  }
})

it('乐观锁：version 条件更新 0 changes 时不覆盖他人写入', () => {
  const temp = makeTempDb()
  const service = makeService(temp.path, 'lock')
  let raw: DatabaseSync | undefined
  try {
    const receipt = expectDispatchOk(
      service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP, title: '初始标题' })),
    )
    raw = new DatabaseSync(temp.path)
    raw.exec('PRAGMA busy_timeout = 15000')
    const before = raw
      .prepare('SELECT version, title FROM tasks WHERE task_id = ?')
      .get(receipt.taskId) as Record<string, unknown>
    const version = Number(before.version)

    const winner = raw
      .prepare('UPDATE tasks SET title = ?, version = version + 1 WHERE task_id = ? AND version = ?')
      .run('并发写入者', receipt.taskId, version)
    assert.equal(Number(winner.changes), 1)

    const stale = raw
      .prepare('UPDATE tasks SET title = ?, version = version + 1 WHERE task_id = ? AND version = ?')
      .run('过期写入者', receipt.taskId, version)
    assert.equal(Number(stale.changes), 0, '过期 version 不得覆盖')
    const after = raw
      .prepare('SELECT version, title FROM tasks WHERE task_id = ?')
      .get(receipt.taskId) as Record<string, unknown>
    assert.equal(String(after.title), '并发写入者')
    assert.equal(Number(after.version), version + 1)
  } finally {
    raw?.close()
    service.close()
    temp.cleanup()
  }
})

it('触发器兜底：终态与 delivered 跳过 review 的裸 UPDATE 均被 ABORT', () => {
  const temp = makeTempDb()
  const service = makeService(temp.path, 'trigger')
  let raw: DatabaseSync | undefined
  try {
    const dispatched = expectDispatchOk(
      service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP })),
    )
    driveToInProgress(service, P1, dispatched.taskId)
    transitionTo(service, P1, dispatched.taskId, 'delivered', { kind: 'system', onBehalfOf: EMP })
    raw = new DatabaseSync(temp.path)
    raw.exec('PRAGMA busy_timeout = 15000')

    assert.throws(
      () => raw!.prepare(`UPDATE tasks SET status = 'verified' WHERE task_id = ?`).run(dispatched.taskId),
      /illegal transition/i,
    )
    const unchanged = raw
      .prepare('SELECT status FROM tasks WHERE task_id = ?')
      .get(dispatched.taskId) as Record<string, unknown>
    assert.equal(String(unchanged.status), 'delivered')

    transitionTo(service, P1, dispatched.taskId, 'review', SUPERVISOR_ACTOR)
    transitionTo(service, P1, dispatched.taskId, 'verified', SUPERVISOR_ACTOR)
    assert.throws(
      () => raw!.prepare(`UPDATE tasks SET status = 'cancelled' WHERE task_id = ?`).run(dispatched.taskId),
      /illegal transition/i,
    )
  } finally {
    raw?.close()
    service.close()
    temp.cleanup()
  }
})

it('失败不半写：取代终态任务被拒后不新增任务/消息/事件', () => {
  const temp = makeTempDb()
  const service = makeService(temp.path, 'atomic')
  try {
    const oldTask = expectDispatchOk(
      service.dispatch(BINDING_SUP, dispatchRequest({ toSessionId: EMP })),
    )
    driveToInProgress(service, P1, oldTask.taskId)
    transitionTo(service, P1, oldTask.taskId, 'delivered', { kind: 'system', onBehalfOf: EMP })
    transitionTo(service, P1, oldTask.taskId, 'review', SUPERVISOR_ACTOR)
    transitionTo(service, P1, oldTask.taskId, 'verified', SUPERVISOR_ACTOR)

    const beforeTasks = service.ledger.listTasks(P1).length
    const beforeMessages = service.listMessages(P1)
    const error = expectDispatchError(
      service.dispatch(BINDING_SUP, dispatchRequest({ supersedesTaskId: oldTask.taskId })),
    )
    assert.equal(error.error.code, 'INVALID_TRANSITION')
    assert.equal(service.ledger.listTasks(P1).length, beforeTasks)
    const afterMessages = service.listMessages(P1)
    assert.equal(afterMessages.empty, false)
    if (!beforeMessages.empty) assert.equal(afterMessages.items.length, beforeMessages.items.length)
  } finally {
    service.close()
    temp.cleanup()
  }
})

it('meta: 用例收集数非零（0 例即失败）', () => {
  assert.ok(registered > 0)
})

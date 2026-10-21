/** 单库多项目：任务按 project_id 隔离，重开库持久化。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import { makeTempDb } from '../support/temp-db.ts'

const P1 = 'proj-1' as never
const P2 = 'proj-2' as never

function service(path: string): SqliteDispatchService {
  const svc = new SqliteDispatchService({ databasePath: path, busyTimeoutMs: 10_000 })
  svc.addMember({ projectId: P1, sessionId: 'sup-1' as never, role: 'supervisor', state: 'available' })
  svc.addMember({ projectId: P1, sessionId: 'emp-1' as never, role: 'worker', state: 'available' })
  svc.addMember({ projectId: P2, sessionId: 'sup-2' as never, role: 'supervisor', state: 'available' })
  return svc
}

test('SQLite 单库多项目：任务隔离且跨项目读取拒绝，重启保留', () => {
  const temp = makeTempDb('cadre-m4-db-')
  try {
    const first = service(temp.path)
    try {
      assert.equal(first.journalMode().toLowerCase(), 'wal')
      assert.equal(first.integrityCheck(), 'ok')
      const receipt = first.dispatch(
        { projectId: P1, sessionId: 'sup-1' as never },
        {
          projectId: P1,
          toSessionId: 'emp-1' as never,
          title: 'p1 task',
          body: 'hello',
          idempotencyKey: 'iso-1' as never,
        },
      )
      assert.equal(receipt.ok, true)
      const taskId = receipt.ok ? receipt.taskId : ('' as never)

      assert.equal(first.ledger.listTasks(P1).length, 1)
      assert.equal(first.ledger.listTasks(P2).length, 0)
      const denied = first.ledger.getTask(P2, taskId)
      assert.equal(denied.ok, false)
      if (!denied.ok) assert.equal(denied.error.code, 'CROSS_PROJECT_DENIED')
    } finally {
      first.close()
    }

    const reopened = service(temp.path)
    try {
      assert.equal(reopened.ledger.listTasks(P1).length, 1)
      assert.equal(reopened.ledger.listTasks(P2).length, 0)
    } finally {
      reopened.close()
    }
  } finally {
    temp.cleanup()
  }
})

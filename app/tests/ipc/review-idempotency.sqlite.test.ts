/** review 幂等跨“进程重启”：关闭服务后重开同一 SQLite，同键仍返回首次回执。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import { InMemoryIdentityBinding } from '../../src/main/identity.ts'
import { InMemoryPreferencesStore } from '../../src/main/preferences.ts'
import { createIpcHandlers } from '../../src/main/ipc-handlers.ts'
import { seedSqliteDatabase } from '../mcp/fixture-sqlite.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { P1, SUP, TASK } from '../mcp/seed.ts'

test('SQLite：review 同键重放跨服务重启返回首次回执，版本不增', () => {
  const temp = makeTempDb('cadre-ipc-idem-')
  const binding = new InMemoryIdentityBinding()
  binding.bind('win-1', { projectId: P1, sessionId: SUP, role: 'supervisor' })
  const request = {
    taskId: TASK.review,
    action: 'verify',
    idempotencyKey: 'sqlite-review-idem',
  } as const

  try {
    seedSqliteDatabase(temp.path)

    const firstService = new SqliteDispatchService({
      databasePath: temp.path,
      serverVersion: 'ipc-idem-1',
    })
    const firstHandlers = createIpcHandlers({
      binding,
      backend: firstService,
      preferences: new InMemoryPreferencesStore(),
    })
    const first = firstHandlers.handle('win-1', 'collab:reviewTask', request) as any
    assert.equal(first.ok, true)
    const version = first.version
    const statusAfter = firstService.ledger.getTask(P1, TASK.review)
    assert.equal(statusAfter.ok, true)
    firstService.close()

    // 模拟主进程重启：新 service + 新 handler，无任何模块级缓存。
    const secondService = new SqliteDispatchService({
      databasePath: temp.path,
      serverVersion: 'ipc-idem-2',
    })
    try {
      const secondHandlers = createIpcHandlers({
        binding,
        backend: secondService,
        preferences: new InMemoryPreferencesStore(),
      })
      const replay = secondHandlers.handle('win-1', 'collab:reviewTask', request) as any
      assert.deepEqual(replay, first)
      assert.equal(replay.version, version)

      const status = secondService.ledger.getTask(P1, TASK.review)
      assert.equal(status.ok, true)
      if (status.ok) {
        assert.equal(status.value.status, 'verified')
        assert.equal(status.value.version, version, '重放不得二次迁移')
      }
    } finally {
      secondService.close()
    }
  } finally {
    temp.cleanup()
  }
})

/** 派活/汇报契约：SQLite 实现（临时目录，结束关闭并清理）。 */
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { runDispatchContract } from './contract-shared.ts'
import { TEST_MEMBERS } from './test-support.ts'

runDispatchContract('sqlite', () => {
  const temp = makeTempDb()
  let tick = 0
  let id = 0
  const now = (): IsoTimestamp =>
    new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
  const newId = (): string => `sqlite-dispatch-${++id}`
  try {
    const service = new SqliteDispatchService({
      databasePath: temp.path,
      now,
      newId,
      serverVersion: 'test-server',
      members: TEST_MEMBERS,
    })
    return {
      service,
      close() {
        service.close()
        temp.cleanup()
      },
    }
  } catch (error) {
    temp.cleanup()
    throw error
  }
})

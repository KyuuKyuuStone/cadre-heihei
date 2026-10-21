/** 台账契约：SQLite 实现（临时目录，结束关闭并清理）。 */
import { SqliteTaskLedger } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { runLedgerContract } from './contract-shared.ts'

runLedgerContract('sqlite', () => {
  const temp = makeTempDb()
  let tick = 0
  let id = 0
  try {
    const ledger = new SqliteTaskLedger({
      databasePath: temp.path,
      now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
      newId: () => `sqlite-id-${++id}`,
    })
    return {
      ledger,
      close() {
        ledger.close()
        temp.cleanup()
      },
    }
  } catch (error) {
    temp.cleanup()
    throw error
  }
})

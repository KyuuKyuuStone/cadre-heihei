/** 台账契约：SQLite 实现（临时目录，结束关闭并清理）。 */
import { SqliteTaskLedger } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { runLedgerContract, P1, P2, SUP } from './contract-shared.ts'

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
    // ADR-0019：supervisor 权威来自 members 表，显式登记。
    const at = new Date(Date.UTC(2026, 9, 21)).toISOString()
    for (const projectId of [P1, P2]) {
      ledger.core.db
        .prepare(
          `INSERT INTO members(project_id, session_id, role, state, created_at, updated_at)
           VALUES (?, ?, 'supervisor', 'available', ?, ?)`,
        )
        .run(projectId, SUP, at, at)
    }
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

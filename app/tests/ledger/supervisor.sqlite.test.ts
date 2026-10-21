/** ADR-0019 supervisor 判定：SQLite 实现（members 表为权威）。 */
import { SqliteTaskLedger } from '../../src/collab/ledger/index.ts'
import type { IsoTimestamp } from '../../src/collab/protocol/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { runSupervisorContract, P1 } from './supervisor-shared.ts'

runSupervisorContract('sqlite', (options) => {
  const temp = makeTempDb()
  let tick = 0
  let id = 0
  try {
    const ledger = new SqliteTaskLedger({
      databasePath: temp.path,
      now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
      newId: () => `adr-sqlite-${++id}`,
      ...(options.supervisorResolver === undefined
        ? {}
        : { supervisorResolver: options.supervisorResolver }),
    })
    // 未注入故障 resolver 时，按 ADR 用 members 表登记 supervisor。
    if (options.supervisorResolver === undefined) {
      const at = new Date(Date.UTC(2026, 9, 21)).toISOString()
      for (const sessionId of options.supervisors) {
        ledger.core.db
          .prepare(
            `INSERT INTO members(project_id, session_id, role, state, created_at, updated_at)
             VALUES (?, ?, 'supervisor', 'available', ?, ?)`,
          )
          .run(P1, sessionId, at, at)
      }
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

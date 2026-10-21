/** IPC handler 契约：临时 SQLite。 */
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import { seedSqliteDatabase } from '../mcp/fixture-sqlite.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { runIpcContract } from './handlers.shared.ts'

runIpcContract('sqlite', () => {
  const temp = makeTempDb('cadre-ipc-')
  seedSqliteDatabase(temp.path)
  const service = new SqliteDispatchService({
    databasePath: temp.path,
    serverVersion: 'ipc-test-sqlite',
  })
  return {
    service,
    close: () => {
      service.close()
      temp.cleanup()
    },
  }
})

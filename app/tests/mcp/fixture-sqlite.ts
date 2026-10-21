/** SQLite 测试种子：在临时库中登记成员与固定任务。 */
import { SqliteDispatchService } from '../../src/collab/dispatch/index.ts'
import { MCP_MEMBERS, seedTasks } from './seed.ts'

export function seedSqliteDatabase(databasePath: string): void {
  const service = new SqliteDispatchService({
    databasePath,
    serverVersion: 'test-sqlite',
    members: MCP_MEMBERS,
  })
  try {
    seedTasks(service)
  } finally {
    service.close()
  }
}

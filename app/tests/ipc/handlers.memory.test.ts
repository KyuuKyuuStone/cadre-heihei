/** IPC handler 契约：内存后端。 */
import { InMemoryDispatchService } from '../../src/collab/dispatch/index.ts'
import { MCP_MEMBERS, seedTasks } from '../mcp/seed.ts'
import { runIpcContract } from './handlers.shared.ts'

runIpcContract('memory', () => {
  const service = new InMemoryDispatchService({
    members: MCP_MEMBERS,
    serverVersion: 'ipc-test-memory',
  })
  seedTasks(service)
  return { service, close: () => {} }
})

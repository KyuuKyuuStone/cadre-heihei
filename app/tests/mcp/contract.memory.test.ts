/** MCP 工具层契约：内存后端（spawn stdio fixture）。 */
import { fileURLToPath } from 'node:url'
import { McpClient } from './client.ts'
import { runMcpContract } from './contract-shared.ts'
import { P1 } from './seed.ts'

const memoryServerPath = fileURLToPath(new URL('./fixtures/memory-server.ts', import.meta.url))

runMcpContract('memory', async (sessionId) => {
  const client = new McpClient(
    memoryServerPath,
    ['--project-id', P1, '--session-id', sessionId],
    { CADRE_SESSION_ID: '', CADRE_PROJECT_ID: '' },
  )
  return {
    client,
    close: () => client.close(),
  }
})

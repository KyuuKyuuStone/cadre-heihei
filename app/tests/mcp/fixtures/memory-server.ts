/**
 * 测试 fixture：内存后端的 MCP stdio server。
 * 与 `src/mcp/server.ts` 走同一 server-core，仅替换后端。
 */
import { InMemoryDispatchService } from '../../../src/collab/dispatch/index.ts'
import { parseIdentity, runStdioServer } from '../../../src/mcp/server-core.ts'
import { MCP_MEMBERS, seedTasks } from '../seed.ts'

const parsed = parseIdentity(process.argv.slice(2), process.env)
if (!parsed.ok) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      apiVersion: 'cadre-heihei/1',
      error: { code: 'INVALID_ARGUMENT', message: parsed.message, retryable: false, field: 'identity' },
    })}\n`,
  )
  process.exit(2)
}

const service = new InMemoryDispatchService({
  members: MCP_MEMBERS,
  serverVersion: 'test-memory',
})
seedTasks(service)

runStdioServer({
  identity: parsed.identity,
  backend: service,
  onEnd: () => {
    setTimeout(() => process.exit(0), 150)
  },
})

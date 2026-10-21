/** MCP 工具层契约：真实 src/mcp/server.ts + 临时 SQLite。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SqliteTaskLedger } from '../../src/collab/ledger/index.ts'
import { makeTempDb } from '../support/temp-db.ts'
import { McpClient, waitForExit } from './client.ts'
import { runMcpContract } from './contract-shared.ts'
import { seedSqliteDatabase } from './fixture-sqlite.ts'
import { EMP, P1, SUP } from './seed.ts'

const serverPath = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url))

runMcpContract('sqlite', async (sessionId) => {
  const temp = makeTempDb('cadre-mcp-')
  try {
    seedSqliteDatabase(temp.path)
    const client = new McpClient(
      serverPath,
      ['--project-id', P1, '--session-id', sessionId, '--database-path', temp.path],
      { CADRE_SESSION_ID: '', CADRE_PROJECT_ID: '' },
    )
    return {
      client,
      close: async () => {
        await client.close()
        temp.cleanup()
      },
    }
  } catch (error) {
    temp.cleanup()
    throw error
  }
})

test('[sqlite] 身份缺失：server 启动失败（exit 2，结构化错误）', async () => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CADRE_SESSION_ID: '', CADRE_PROJECT_ID: '' },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exit = await waitForExit(child)
  assert.equal(exit.code, 2)
  assert.match(stderr, /INVALID_ARGUMENT/)
  assert.match(stderr, /identity/)
})

test('[sqlite] MCP 调用落库：关闭 server 后任务/事件/消息仍在', async () => {
  const temp = makeTempDb('cadre-mcp-persist-')
  seedSqliteDatabase(temp.path)
  const client = new McpClient(
    serverPath,
    ['--project-id', P1, '--session-id', SUP, '--database-path', temp.path],
    { CADRE_SESSION_ID: '', CADRE_PROJECT_ID: '' },
  )
  try {
    await client.initialize()
    const response = await client.callTool('dispatch_task', {
      toSessionId: EMP,
      title: '落库验证',
      body: '写入正文',
      idempotencyKey: 'persist-1',
    })
    assert.equal((response.payload as any).ok, true)
    const taskId = (response.payload as any).taskId as string
    await client.close()

    const ledger = new SqliteTaskLedger({ databasePath: temp.path })
    try {
      const task = ledger.getTask(P1, taskId as never)
      assert.equal(task.ok, true)
      const events = ledger.listEvents(P1, taskId as never)
      assert.equal(events.ok, true)
      if (events.ok) assert.equal(events.value.length, 1)
      assert.equal(ledger.integrityCheck(), 'ok')
    } finally {
      ledger.close()
    }
  } finally {
    await client.close()
    temp.cleanup()
  }
})

#!/usr/bin/env node
/**
 * MCP stdio server 可执行入口。
 *
 * 用法：
 *   node src/mcp/server.ts --project-id <p> --session-id <s> --database-path <db>
 * 身份亦可用 CADRE_PROJECT_ID / CADRE_SESSION_ID 注入；数据库可用 CADRE_DB_PATH。
 * 身份缺失 → 启动失败（exit 2），不得匿名运行。
 */
import { pathToFileURL } from 'node:url'
import { SqliteDispatchService } from '../collab/dispatch/index.ts'
import { argValue, parseIdentity, runStdioServer } from './server-core.ts'

const SERVER_VERSION = '0.1.0'

function startupFailure(message: string, field: string): never {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      apiVersion: 'cadre-heihei/1',
      error: { code: 'INVALID_ARGUMENT', message, retryable: false, field, reason: message },
    })}\n`,
  )
  process.exit(2)
}

export function startServer(
  args: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): void {
  const parsed = parseIdentity(args, env)
  if (!parsed.ok) startupFailure(parsed.message, 'identity')
  const databasePath = argValue(args, 'database-path') ?? env.CADRE_DB_PATH
  if (databasePath === undefined || databasePath === '') {
    startupFailure('missing --database-path / CADRE_DB_PATH', 'databasePath')
  }
  const busyTimeoutRaw = argValue(args, 'busy-timeout-ms')
  const busyTimeoutMs = busyTimeoutRaw === undefined ? undefined : Number(busyTimeoutRaw)
  if (busyTimeoutMs !== undefined && (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0)) {
    startupFailure('--busy-timeout-ms must be a non-negative number', 'busyTimeoutMs')
  }

  const service = new SqliteDispatchService({
    databasePath: databasePath as string,
    serverVersion: SERVER_VERSION,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  })
  runStdioServer({
    identity: parsed.identity,
    backend: service,
    onEnd: () => {
      // 给 stdout 留 flush 时间，避免最后一个应答被截断（S5b 踩坑）。
      setTimeout(() => {
        service.close()
        process.exit(0)
      }, 150)
    },
  })
}

const invokedPath = process.argv[1]
const isMain =
  invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href
if (isMain) startServer()

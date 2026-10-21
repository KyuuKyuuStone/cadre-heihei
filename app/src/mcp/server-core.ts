/**
 * MCP stdio server 核心：newline-delimited JSON-RPC 2.0 最小集。
 *
 * 只实现 initialize / tools/list / tools/call / ping / notifications；
 * 工具逻辑委托 `collab/tools`，本文件不含业务规则。
 * 协议口径依据 S5b 直调证据与官方 MCP stdio transport。
 */
import { handleToolCall } from '../collab/tools/handlers.ts'
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../collab/tools/schemas.ts'
import type { ToolBackend, ToolIdentity } from '../collab/tools/types.ts'
import { API_VERSION, type ApiFailure } from '../collab/protocol/index.ts'
import { failure } from '../collab/tools/errors.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_SERVER_NAME = 'cadre'

export type IdentityParseResult =
  | { readonly ok: true; readonly identity: ToolIdentity }
  | { readonly ok: false; readonly message: string }

export function argValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === `--${name}`) return args[index + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

/**
 * 身份只来自启动参数或 env；工具调用参数不参与。
 * 缺失/空值 → 调用方必须启动失败（不得匿名运行）。
 */
export function parseIdentity(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): IdentityParseResult {
  const sessionId = argValue(args, 'session-id') ?? env.CADRE_SESSION_ID
  const projectId = argValue(args, 'project-id') ?? env.CADRE_PROJECT_ID
  if (sessionId === undefined || sessionId === '') {
    return { ok: false, message: 'missing --session-id / CADRE_SESSION_ID' }
  }
  if (projectId === undefined || projectId === '') {
    return { ok: false, message: 'missing --project-id / CADRE_PROJECT_ID' }
  }
  return { ok: true, identity: { sessionId: sessionId as never, projectId: projectId as never } }
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

export interface McpCore {
  /** 处理一条 JSON-RPC 消息；通知返回 undefined。 */
  handle(message: JsonRpcRequest): unknown | undefined
  /** 处理一行原始文本（含解析错误映射）。 */
  handleLine(line: string): unknown | undefined
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function textResult(payload: unknown, isError: boolean): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  }
}

function invalidArgsFailure(field: string, reason: string): ApiFailure {
  return failure('INVALID_ARGUMENT', `参数非法：${field}`, { field, reason })
}

export function createMcpCore(options: {
  readonly identity: ToolIdentity
  readonly backend: ToolBackend
}): McpCore {
  const toolSet = new Set<string>(TOOL_NAMES)

  return {
    handle(message) {
      if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
        return rpcError((message as { id?: unknown })?.id, -32600, 'invalid request')
      }
      const id = message.id
      const method = message.method

      if (method === 'initialize') {
        const params = (message.params ?? {}) as Record<string, unknown>
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion:
              typeof params.protocolVersion === 'string'
                ? params.protocolVersion
                : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: API_VERSION },
          },
        }
      }
      if (method === 'ping') return { jsonrpc: '2.0', id: id ?? null, result: {} }
      if (method.startsWith('notifications/')) return undefined

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { tools: TOOL_DEFINITIONS },
        }
      }

      if (method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        const name = params.name
        if (typeof name !== 'string') {
          return rpcError(id, -32602, 'tools/call requires params.name')
        }
        if (!toolSet.has(name)) {
          return rpcError(id, -32601, `unknown tool: ${name}`)
        }
        const rawArgs = params.arguments
        if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: textResult(invalidArgsFailure('arguments', '必须是对象'), true),
          }
        }
        const toolResult = handleToolCall(
          { identity: options.identity, backend: options.backend },
          name,
          (rawArgs ?? {}) as Record<string, unknown>,
        )
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: textResult(toolResult.payload, toolResult.isError),
        }
      }

      if (id === undefined) return undefined
      return rpcError(id, -32601, `unknown method: ${method}`)
    },

    handleLine(line) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return rpcError(null, -32700, 'parse error')
      }
      return this.handle(parsed as JsonRpcRequest)
    },
  }
}

export interface StdioServerOptions {
  readonly identity: ToolIdentity
  readonly backend: ToolBackend
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  /** stdin 结束后回调（CLI 用它关闭数据库并退出）。 */
  readonly onEnd?: () => void
}

/** 行长上限，避免异常输入无限占用内存。 */
const MAX_LINE_BYTES = 8 * 1024 * 1024

export function runStdioServer(options: StdioServerOptions): McpCore {
  const core = createMcpCore({ identity: options.identity, backend: options.backend })
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  let buffer = ''

  const send = (response: unknown): void => {
    if (response === undefined) return
    output.write(`${JSON.stringify(response)}\n`)
  }

  input.setEncoding?.('utf8')
  input.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = ''
      send(rpcError(null, -32700, 'line too long'))
      return
    }
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      send(core.handleLine(line))
    }
  })
  input.on('end', () => {
    const line = buffer.trim()
    if (line !== '') send(core.handleLine(line))
    options.onEnd?.()
  })

  return core
}

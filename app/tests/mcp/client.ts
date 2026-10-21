/** 直调 MCP stdio server 的测试客户端（换行分隔 JSON-RPC 2.0）。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface ToolPayloadResult {
  readonly payload: Record<string, unknown>
  readonly isError: boolean
  readonly raw: Record<string, unknown>
}

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private nextId = 1
  private closed = false
  private stderrText = ''

  constructor(scriptPath: string, args: readonly string[], env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk
    })
    this.child.on('exit', (code, signal) => {
      const error = new Error(`MCP server exited (code=${code}, signal=${signal}): ${this.stderrText}`)
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()
    })
  }

  get stderr(): string {
    return this.stderrText
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const id = message.id
      if (typeof id !== 'number') continue
      const entry = this.pending.get(id)
      if (!entry) continue
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(message)
    }
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cadre-test', version: '1.0.0' },
    })
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request('tools/list')
    const result = response.result as { tools?: Array<Record<string, unknown>> } | undefined
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolPayloadResult> {
    const response = await this.request('tools/call', { name, arguments: args })
    if (response.error !== undefined) {
      throw new Error(`tools/call error: ${JSON.stringify(response.error)}`)
    }
    const result = response.result as {
      content?: Array<{ type?: string; text?: string }>
      isError?: boolean
    }
    const text = result.content?.[0]?.text
    if (typeof text !== 'string') throw new Error('tools/call missing text content')
    return {
      payload: JSON.parse(text) as Record<string, unknown>,
      isError: result.isError === true,
      raw: response,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => this.child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    if (!exited) {
      this.child.kill('SIGKILL')
      await new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('client closed'))
    }
    this.pending.clear()
  }
}

export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
      setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs),
    ),
  ])
}

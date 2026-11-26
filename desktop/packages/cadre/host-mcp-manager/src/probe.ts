/**
 * The `test` route's one-shot connectivity probe.
 *
 * A dedicated root context carries a capture-only `tools` service and one
 * `mcp-client` fiber, so the probe reuses the shipped transport, credential
 * scrubbing, and tool-discovery path instead of a second protocol client. The
 * fiber activates only after the initial connection and tool list settle, which
 * is what makes the observed tool set trustworthy; disposal tears the transport
 * down before the route answers.
 * @module
 */
import { Context } from '@deepseek-ai/cordis'
import * as McpClientPlugin from '@deepseek-ai/dsh-mcp-client'
import { McpError } from './errors.ts'
import { resolveServer } from './mount.ts'
import type { McpProbe, McpProbeOutcome, McpServerManifest } from './types.ts'

/** Default probe deadline: one connection plus one tool list. */
export const PROBE_TIMEOUT_MS = 15_000

/** One tool as the probe records it for the instruction-size estimate. */
interface CapturedTool {
  readonly name: string
  readonly description: string
}

/** Probe settings; the deadline is overridable so a spec can force the timeout path. */
export interface ProbeOptions {
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

function timedOut(timeoutMs: number): McpError {
  return new McpError('MCP_TIMEOUT', 504, `探测超时（${timeoutMs}ms）`, '增大超时或检查服务器')
}

function connectFailed(error: unknown): McpError {
  const detail = error instanceof Error ? error.message : String(error)
  return new McpError('MCP_CONNECT_FAILED', 502, `无法连接：${detail}`, '检查命令/URL 与网络')
}

/**
 * Byte size of the tool list a server contributes, as the step would render it.
 * A UTF-8 byte count keeps multibyte descriptions honest.
 * @param tools - captured tool names and descriptions.
 * @returns the JSON-encoded byte length of the captured list.
 */
export function instructionBytesOf(tools: readonly CapturedTool[]): number {
  return Buffer.byteLength(JSON.stringify(tools), 'utf8')
}

/**
 * Build the probe the `test` route runs.
 * @param options - probe deadline and the environment references resolve against.
 * @returns a probe that connects once, reads the tool list, and disposes.
 */
export function createMcpProbe(options: ProbeOptions = {}): McpProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const env = options.env ?? process.env
  return async (manifest: McpServerManifest): Promise<McpProbeOutcome> => {
    const captured: CapturedTool[] = []
    const context = new Context()
    // Capture-only: the probe needs the registered names and descriptions, never
    // an executable definition, so every call is a no-op registration.
    context.provide('tools', {
      register(definition: { readonly name: string; readonly description?: string }): () => void {
        captured.push({ name: definition.name, description: definition.description ?? '' })
        return () => {}
      },
    })
    const resolved = resolveServer(manifest, undefined, env)
    const fiber = context.plugin(McpClientPlugin, { ...resolved.config, failOnStartupError: true })
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(timedOut(timeoutMs)) }, timeoutMs)
    })
    try {
      await Promise.race([fiber.await(), deadline])
    } catch (error) {
      throw error instanceof McpError ? error : connectFailed(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      await fiber.dispose()
    }
    return { tools: captured.map(tool => tool.name), instructionBytes: instructionBytesOf(captured) }
  }
}

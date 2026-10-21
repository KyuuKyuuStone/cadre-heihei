/**
 * Harness 事件 → 端口事件的**纯映射**（无 I/O、无 mock）。
 *
 * 选择：
 * - `assistant/message`：按 `data.stream` 的 text chunks 产出 `message.delta`；
 *   再用消息正文的 text 产出 `message.complete`。reasoning 不映射（非产品事件）。
 * - `tool/call` / `tool/result`：映射工具名/callId/summary；tool.result 的名称从
 *   同一批事件的前序 tool.call 补齐。
 * - `compaction/start|summary|end`：raw 保留原始 data。
 * - 未知事件：产出 `unknown-event` 诊断（adapter 负责记日志），绝不伪装成成功。
 * - 已知但无端口语义的生命周期事件：显式列入 IGNORED_EVENT_TYPES。
 * - `assistant/attempt`（失败/重试尝试）：产出 `assistant-attempt` 诊断，不产出成功事件。
 *
 * 依赖仅限端口类型；不 import harness 包，便于独立单测。
 */
import {
  ENGINE_ERROR_CODES,
  type EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type EngineToolResult,
} from '../../../ports/engine.ts'
import type { IsoTimestamp, SessionId } from '../../../collab/protocol/ids.ts'

/** 结构性事件类型：只依赖 SDK 公开的 type/time/seq/data 字段。 */
export interface HarnessEventLike {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

export type HarnessDiagnosticKind = 'unknown-event' | 'unmapped-event' | 'assistant-attempt'

export interface HarnessMappingDiagnostic {
  readonly kind: HarnessDiagnosticKind
  readonly eventType: string
  readonly seq?: number
  readonly detail: string
}

export interface HarnessMappingResult {
  readonly events: EngineEvent[]
  readonly diagnostics: HarnessMappingDiagnostic[]
}

export interface HarnessMappingOptions {
  readonly sessionId: SessionId
  /** 事件缺 time 时的确定性回退值。 */
  readonly fallbackAt?: IsoTimestamp
}

export class HarnessEngineError extends Error implements EngineError {
  readonly code: EngineErrorCode
  readonly retryable: boolean
  readonly rawCode?: string

  constructor(code: EngineErrorCode, message: string, retryable: boolean, rawCode?: string) {
    super(message)
    this.name = 'HarnessEngineError'
    this.code = code
    this.retryable = retryable
    if (rawCode !== undefined) this.rawCode = rawCode
  }
}

/** 已知但当前没有端口语义的生命周期/日志事件；显式忽略，避免误判为未知。 */
const IGNORED_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'system/message',
  'developer/message',
  'request/header',
  'request/context',
  'agent/inbox/spliced',
  'session/title',
  'session/end-seed',
  'session-log-deepseek/delivery-accepted',
  'compaction/prune',
  'workspace/changes',
])

const DEFAULT_AT = new Date(0).toISOString() as IsoTimestamp

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toIso(time: unknown, fallback: IsoTimestamp = DEFAULT_AT): IsoTimestamp {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return new Date(time).toISOString() as IsoTimestamp
  }
  return fallback
}

function truncate(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function textOfContent(content: unknown): string {
  return asArray(content)
    .map((block) => {
      const record = asRecord(block)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && (ENGINE_ERROR_CODES as readonly string[]).includes(code)
}

function rawCodeOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as { code?: unknown; name?: unknown }
    if (typeof record.code === 'string' && record.code) return record.code
    if (typeof record.code === 'number') return String(record.code)
    if (typeof record.name === 'string' && record.name) return record.name
  }
  return 'UNKNOWN'
}

/** 异常 → EngineError。未映射错误一律 ENGINE_UNKNOWN + rawCode。纯函数。 */
export function mapHarnessError(error: unknown, context: string): EngineError {
  if (isEngineError(error)) return error
  const record = typeof error === 'object' && error !== null
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : undefined
  const name = typeof record?.name === 'string' ? record.name : ''
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string' ? record.message : String(error)
  const rawCode = rawCodeOf(error)

  if (name === 'TransportClosedError') {
    return new HarnessEngineError('TRANSPORT_CLOSED', `${context}: ${message}`, false, rawCode)
  }
  if (name === 'RequestTimeoutError') {
    return new HarnessEngineError('ENGINE_TIMEOUT', `${context}: ${message}`, true, rawCode)
  }
  if (name === 'JsonRpcResponseError' || name === 'SdkProtocolError') {
    return new HarnessEngineError('ENGINE_PROTOCOL', `${context}: ${message}`, false, rawCode)
  }
  return new HarnessEngineError('ENGINE_UNKNOWN', `${context}: ${message}`, false, rawCode)
}

function mapAssistantMessage(
  event: HarnessEventLike,
  sessionId: SessionId,
  at: IsoTimestamp,
): EngineEvent[] {
  const data = asRecord(event.data)
  const message = asRecord(data?.message)
  const contentText = textOfContent(message?.content)
  const events: EngineEvent[] = []
  let streamedText = ''

  for (const record of asArray(data?.stream)) {
    const item = asRecord(record)
    if (item === undefined) continue
    if (item.type === 'text-chunks') {
      for (const text of asArray(item.texts)) {
        if (typeof text !== 'string' || text.length === 0) continue
        streamedText += text
        events.push({ kind: 'message.delta', sessionId, at, text })
      }
    } else if (item.type === 'chunk') {
      const chunk = asRecord(item.chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        streamedText += chunk.text
        events.push({ kind: 'message.delta', sessionId, at, text: chunk.text })
      }
    }
  }

  const completeText = contentText.length > 0 ? contentText : streamedText
  if (events.length === 0 && completeText.length > 0) {
    events.push({ kind: 'message.delta', sessionId, at, text: completeText })
  }
  if (completeText.length > 0) {
    events.push({ kind: 'message.complete', sessionId, at, text: completeText })
  }
  return events
}

function mapToolResult(
  event: HarnessEventLike,
  sessionId: SessionId,
  at: IsoTimestamp,
  callNames: Map<string, string>,
): EngineEvent {
  const data = asRecord(event.data)
  const message = asRecord(data?.message)
  const callId = asString(message?.toolCallId) ?? asString(data?.callId) ?? `call-${event.seq ?? 'unknown'}`
  const toolName = callNames.get(callId) ?? 'tool'
  const isError = message?.isError === true
  const error = asRecord(data?.error)
  const text = textOfContent(message?.content)
  const meta = asRecord(data?.meta)
  const outputFile = asString(meta?.outputFile)
  const summarySource = asString(error?.reason) ?? text
  const result: EngineToolResult = {
    kind: 'tool.result',
    sessionId,
    at,
    toolName,
    callId,
    ok: !isError,
    summary: truncate(summarySource.length > 0 ? summarySource : (isError ? 'tool error' : 'ok')),
    ...(outputFile === undefined ? {} : { outputFile }),
  }
  return result
}

/**
 * 映射一批 harness SessionEvent。纯函数：同样输入必得同样输出；
 * 不读取环境、不发网络请求、不写日志（诊断由调用方落地）。
 */
export function mapHarnessEvents(
  events: readonly HarnessEventLike[],
  options: HarnessMappingOptions,
): HarnessMappingResult {
  const { sessionId } = options
  const fallbackAt = options.fallbackAt ?? DEFAULT_AT
  const mapped: EngineEvent[] = []
  const diagnostics: HarnessMappingDiagnostic[] = []
  const callNames = new Map<string, string>()

  for (const event of events) {
    const at = toIso(event.time, fallbackAt)
    switch (event.type) {
      case 'assistant/message':
        mapped.push(...mapAssistantMessage(event, sessionId, at))
        break
      case 'tool/call': {
        const data = asRecord(event.data)
        const callId = asString(data?.callId) ?? `call-${event.seq ?? 'unknown'}`
        const toolName = asString(data?.name) ?? 'tool'
        const args = asString(data?.arguments) ?? ''
        callNames.set(callId, toolName)
        mapped.push({
          kind: 'tool.call',
          sessionId,
          at,
          toolName,
          callId,
          summary: truncate(args),
        })
        break
      }
      case 'tool/result':
        mapped.push(mapToolResult(event, sessionId, at, callNames))
        break
      case 'compaction/start':
        mapped.push({ kind: 'compaction.start', sessionId, at, raw: event.data })
        break
      case 'compaction/summary':
        mapped.push({ kind: 'compaction.summary', sessionId, at, raw: event.data })
        break
      case 'compaction/end':
        mapped.push({ kind: 'compaction.end', sessionId, at, raw: event.data })
        break
      case 'session.error': {
        const data = asRecord(event.data)
        const rawError = data?.error ?? event.data
        mapped.push({
          kind: 'session.error',
          sessionId,
          at,
          error: mapHarnessError(rawError, 'harness session.error'),
        })
        break
      }
      case 'session.closed': {
        const data = asRecord(event.data)
        const reason = asString(data?.reason)
        mapped.push({
          kind: 'session.closed',
          sessionId,
          at,
          reason: reason === 'requested' || reason === 'crashed' ? reason : 'unknown',
        })
        break
      }
      case 'assistant/attempt':
        diagnostics.push({
          kind: 'assistant-attempt',
          eventType: event.type,
          ...(event.seq === undefined ? {} : { seq: event.seq }),
          detail: '失败/重试尝试，不映射为成功事件',
        })
        break
      default:
        if (!IGNORED_EVENT_TYPES.has(event.type)) {
          diagnostics.push({
            kind: 'unknown-event',
            eventType: event.type,
            ...(event.seq === undefined ? {} : { seq: event.seq }),
            detail: '无端口映射；已记诊断，未伪装成成功',
          })
        }
    }
  }

  return { events: mapped, diagnostics }
}

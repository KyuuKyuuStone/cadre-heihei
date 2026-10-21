/**
 * FakeEngine —— EnginePort 的内存实现（W1-08）。
 *
 * 约束：
 * - 只 import 产品端口/契约类型；不得 import `@deepseek-ai/dsh-*` 或 `vendor/`；
 * - 每会话独立 runtimeId（ADR-0014 语义），但只在本进程内模拟；
 * - 不发真实模型请求、不读 harness 内部文件、不依赖 SDK 枚举（N7）；
 * - stop 是终态：不自动恢复，重启由上层重建 FakeEngine（N6/N15/N16）。
 *
 * 测试注入口：`setSessionScript(sessionId, events)` 可替换某会话下一次/每次
 * send 的事件序列；事件中的 sessionId/at 会被 FakeEngine 覆盖，保证双会话隔离。
 */
import { randomUUID } from 'node:crypto'
import {
  ENGINE_ERROR_CODES,
  type CreateSessionInput,
  type EngineCapabilities,
  type EngineError,
  type EngineErrorCode,
  type EngineEvent,
  type EngineHealth,
  type EnginePort,
  type EngineSession,
  type EngineSessionSummary,
  type ResumeSessionInput,
  type SendOptions,
} from '../../../ports/engine.ts'
import type { IsoTimestamp, SessionId } from '../../../collab/protocol/ids.ts'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 脚本化事件：由 FakeEngine 补齐 sessionId/at。 */
export type FakeScriptEvent = DistributiveOmit<EngineEvent, 'sessionId' | 'at'>

export interface FakeEngineOptions {
  /** 事件之间等待的毫秒数；默认 0。>0 便于在消费端触发 abort。 */
  eventDelayMs?: number
}

/** 结构化错误；结构满足 EngineError，便于上层按 code 分支。 */
export class FakeEngineError extends Error implements EngineError {
  readonly code: EngineErrorCode
  readonly retryable: boolean
  readonly rawCode?: string

  constructor(code: EngineErrorCode, message: string, retryable: boolean, rawCode?: string) {
    super(message)
    this.name = 'FakeEngineError'
    this.code = code
    this.retryable = retryable
    if (rawCode !== undefined) this.rawCode = rawCode
  }
}

type SessionState = EngineSessionSummary['state']

interface SessionRecord {
  readonly sessionId: SessionId
  readonly runtimeId: string
  workingDirectory: string
  readonly title?: string
  state: SessionState
  readonly createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

function now(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp
}

function makeSessionId(): SessionId {
  return `fake-session-${randomUUID()}` as SessionId
}

function makeRuntimeId(): string {
  return `fake-runtime-${randomUUID()}`
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
    if (typeof record.name === 'string' && record.name) return record.name
  }
  return 'UNKNOWN'
}

/** 未映射错误 → ENGINE_UNKNOWN + 原始 rawCode。 */
function mapError(error: unknown, context: string): EngineError {
  if (isEngineError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new FakeEngineError('ENGINE_UNKNOWN', `${context}: ${message}`, false, rawCodeOf(error))
}

class FakeSession implements EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId: string
  private readonly engine: FakeEngine
  private readonly record: SessionRecord

  constructor(engine: FakeEngine, record: SessionRecord) {
    this.engine = engine
    this.record = record
    this.sessionId = record.sessionId
    this.runtimeId = record.runtimeId
  }

  send(prompt: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    return this.engine.sendForSession(this.record, prompt, options)
  }

  async setWorkingDirectory(path: string): Promise<void> {
    this.engine.ensureSessionActive(this.record)
    if (typeof path !== 'string' || path.trim() === '') {
      throw new FakeEngineError('ENGINE_PROTOCOL', 'workingDirectory must not be empty', false)
    }
    this.record.workingDirectory = path
    this.record.updatedAt = now()
  }

  async getWorkingDirectory(): Promise<string> {
    return this.record.workingDirectory
  }

  async close(): Promise<void> {
    if (this.record.state !== 'closed') {
      this.record.state = 'closed'
      this.record.updatedAt = now()
    }
  }
}

export class FakeEngine implements EnginePort {
  readonly engineId = 'fake' as const
  private readonly sessions = new Map<SessionId, SessionRecord>()
  private readonly scripts = new Map<SessionId, readonly FakeScriptEvent[]>()
  private readonly eventDelayMs: number
  private status: 'idle' | 'running' | 'stopped' = 'idle'

  constructor(options: FakeEngineOptions = {}) {
    this.eventDelayMs = Math.max(0, options.eventDelayMs ?? 0)
  }

  async start(): Promise<void> {
    if (this.status === 'running') return
    if (this.status === 'stopped') {
      // N6/N15/N16：停止是终态，不自动恢复；重启由上层重建实例。
      throw new FakeEngineError(
        'ENGINE_UNAVAILABLE',
        'FakeEngine is stopped; create and start a new instance instead of restarting this one',
        false,
      )
    }
    this.status = 'running'
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    this.status = 'stopped'
    const at = now()
    for (const record of this.sessions.values()) {
      record.state = 'closed'
      record.updatedAt = at
    }
    this.scripts.clear()
  }

  capabilities(): EngineCapabilities {
    // 与 S1-S5b/A1 v2 实测一致：compaction 事件与稳定 ID 可观测；注入仅 user-role。
    return {
      manualCompact: false,
      tokenUsage: false,
      mcpTools: true,
      compactionEvents: 'available',
      sessionEnumeration: false,
      crashRecovery: 'structured-error-only',
    }
  }

  async health(): Promise<EngineHealth> {
    const checkedAt = now()
    if (this.status === 'stopped') return { state: 'stopped', checkedAt }
    if (this.status === 'idle') return { state: 'unknown', checkedAt, detail: 'not started' }
    const degraded = [...this.sessions.values()].some((record) => record.state === 'failed')
    return { state: degraded ? 'degraded' : 'ready', checkedAt }
  }

  async createSession(input: CreateSessionInput): Promise<EngineSession> {
    this.ensureRunning()
    if (typeof input?.workingDirectory !== 'string' || input.workingDirectory.trim() === '') {
      throw new FakeEngineError('ENGINE_PROTOCOL', 'createSession requires a non-empty workingDirectory', false)
    }
    const at = now()
    const record: SessionRecord = {
      sessionId: makeSessionId(),
      runtimeId: makeRuntimeId(),
      workingDirectory: input.workingDirectory,
      ...(input.title === undefined ? {} : { title: input.title }),
      state: 'ready',
      createdAt: at,
      updatedAt: at,
    }
    this.sessions.set(record.sessionId, record)
    return new FakeSession(this, record)
  }

  /**
   * 只恢复产品自建台账内的会话（N7：无 SDK 枚举）。
   * 不存在 → ENGINE_UNAVAILABLE；不臆造会话。
   */
  async resumeSession(sessionId: SessionId, input?: ResumeSessionInput): Promise<EngineSession> {
    this.ensureRunning()
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      throw new FakeEngineError(
        'ENGINE_UNAVAILABLE',
        `session ${String(sessionId)} not found in product ledger; refusing to fabricate it`,
        false,
      )
    }
    if (input?.workingDirectory !== undefined) {
      if (typeof input.workingDirectory !== 'string' || input.workingDirectory.trim() === '') {
        throw new FakeEngineError('ENGINE_PROTOCOL', 'resume workingDirectory must not be empty', false)
      }
      record.workingDirectory = input.workingDirectory
    }
    // 显式 resume 允许把 closed/failed 会话重新置为 ready；这不是 stop 后的自动恢复。
    record.state = 'ready'
    record.updatedAt = now()
    return new FakeSession(this, record)
  }

  /**
   * 返回产品自建台账摘要；不调用任何外部枚举 API。
   * stop() 后保留记录并标记 closed，便于上层对账；不会自动重启。
   */
  async listSessions(): Promise<readonly EngineSessionSummary[]> {
    return [...this.sessions.values()].map((record) => ({
      sessionId: record.sessionId,
      runtimeId: record.runtimeId,
      workingDirectory: record.workingDirectory,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  /** 测试注入：设置某会话的事件序列；sessionId/at 由引擎补齐。 */
  setSessionScript(sessionId: SessionId, events: readonly FakeScriptEvent[]): void {
    if (!this.sessions.has(sessionId)) {
      throw new FakeEngineError(
        'ENGINE_UNAVAILABLE',
        `session ${String(sessionId)} not found in product ledger`,
        false,
      )
    }
    this.scripts.set(sessionId, [...events])
  }

  /** @internal 供 FakeSession 调用；保证未启动/已停止时显式失败。 */
  sendForSession(record: SessionRecord, prompt: string, options?: SendOptions): AsyncIterable<EngineEvent> {
    this.ensureRunning()
    this.ensureSessionActive(record)
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new FakeEngineError('ENGINE_PROTOCOL', 'send requires a non-empty prompt', false)
    }
    return this.streamEvents(record, prompt, options)
  }

  /** @internal */
  ensureRunning(): void {
    if (this.status !== 'running') {
      throw new FakeEngineError(
        'TRANSPORT_CLOSED',
        `engine is ${this.status}; only explicit errors after stop (N6/N15/N16)`,
        false,
      )
    }
  }

  /** @internal */
  ensureSessionActive(record: SessionRecord): void {
    this.ensureRunning()
    if (record.state === 'closed') {
      throw new FakeEngineError('TRANSPORT_CLOSED', 'session is closed; resume or recreate it explicitly', false)
    }
    if (record.state === 'failed') {
      throw new FakeEngineError('TRANSPORT_CLOSED', 'session failed; resume explicitly to reactivate it', false)
    }
  }

  private scriptFor(record: SessionRecord, prompt: string): readonly FakeScriptEvent[] {
    const scripted = this.scripts.get(record.sessionId)
    if (scripted !== undefined) return scripted
    // 默认脚本：一个 delta + 一个 complete；不产生模型请求。
    return [
      { kind: 'message.delta', text: `fake:${prompt}` },
      { kind: 'message.complete', text: `fake:${prompt}` },
    ]
  }

  private delay(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, this.eventDelayMs)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async *streamEvents(
    record: SessionRecord,
    prompt: string,
    options?: SendOptions,
  ): AsyncGenerator<EngineEvent> {
    if (options?.signal?.aborted) return
    const events = this.scriptFor(record, prompt)
    try {
      for (const event of events) {
        this.ensureSessionActive(record)
        if (options?.signal?.aborted) return
        await this.delay(options?.signal)
        if (options?.signal?.aborted) return

        // 覆盖 sessionId/at：脚本不得跨会话串事件。
        const merged = { ...event, sessionId: record.sessionId, at: now() } as EngineEvent
        yield merged

        if (merged.kind === 'session.closed') {
          record.state = 'closed'
          record.updatedAt = now()
          return
        }
        if (merged.kind === 'session.error') {
          record.state = 'failed'
          record.updatedAt = now()
          return
        }
      }
    } catch (error) {
      if (isEngineError(error)) throw error
      if (options?.signal?.aborted) return
      const mapped = mapError(error, 'fake send failed')
      record.state = 'failed'
      record.updatedAt = now()
      yield {
        kind: 'session.error',
        sessionId: record.sessionId,
        at: now(),
        error: mapped,
      }
    }
  }
}

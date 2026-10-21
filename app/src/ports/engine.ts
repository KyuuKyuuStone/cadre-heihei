/**
 * EnginePort：产品与引擎之间的唯一接缝（ADR-0003、implementation/01 §1.6）。
 *
 * W1-04 类型草案，**零 harness 类型**：
 * - 本文件不得 import `@deepseek-ai/dsh-*` 或 `vendor/` 下任何路径；
 * - harness 特有能力只能经 `EngineCapabilities` 以「已证/未证」形式暴露；
 * - 未映射的引擎错误由 adapter 映射为 `EngineError`，产品层不感知原始协议。
 *
 * 会话形态：ADR-0014 已裁定「每会话独立实例」；端口不规定实现形态，
 * `EngineSession.runtimeId` 用于表达会话与运行时的对应关系。
 */
import type { IsoTimestamp, SessionId } from '../collab/protocol/ids.ts'

export const ENGINE_IDS = ['harness', 'fake'] as const
export type EngineId = (typeof ENGINE_IDS)[number]

export const CAPABILITY_STATUSES = ['available', 'unavailable', 'unverified'] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

/**
 * 引擎能力位。
 *
 * 当前取值是**实测结论或其缺席**，不是愿望：
 * - `manualCompact: false` —— N8：SDK 形态 `/compact` 触发 0 事件（S3）；
 * - `tokenUsage: false` —— N9：usage/shadowedTokenCount 未暴露（S3）；
 * - `mcpTools: true` —— S5b B1-B4：工具发现/调用/错误可见；
 * - `compactionEvents: 'available'` —— A1 判据层已通过（2026-10-21）：事件与稳定 ID
 *   （`data.compactionId`）窗口内外可观测；注入仅 user-role，system 不可（证据 a1 v2）；
 * - `sessionEnumeration: false` —— N7：SDK 无会话枚举 API；
 * - `crashRecovery: 'structured-error-only'` —— N15/N16：崩溃后结构化失败，需重建会话。
 *
 * `compactionEvents` 的类型仍为 `CapabilityStatus`，用于表达
 * available / unavailable / unverified 三态，不因 A1 通过而收窄。
 */
export interface EngineCapabilities {
  readonly manualCompact: false
  readonly tokenUsage: false
  readonly mcpTools: true
  /** A1 v2（2026-10-21）：当前实现返回 `'available'`；注入仅 user-role，system 不可。 */
  readonly compactionEvents: CapabilityStatus
  readonly sessionEnumeration: false
  readonly crashRecovery: 'structured-error-only'
}

export interface EngineError {
  readonly code: EngineErrorCode
  readonly message: string
  /** 引擎原始错误码/错误名；仅用于诊断与 INTERNAL_ERROR 映射（backend/01 §6）。 */
  readonly rawCode?: string
  readonly retryable: boolean
}

export const ENGINE_ERROR_CODES = [
  'ENGINE_UNAVAILABLE',
  'TRANSPORT_CLOSED',
  'ENGINE_PROTOCOL',
  'ENGINE_TIMEOUT',
  'ENGINE_UNKNOWN',
] as const
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number]

export interface EngineHealth {
  readonly state: 'unknown' | 'starting' | 'ready' | 'degraded' | 'stopped'
  readonly checkedAt: IsoTimestamp
  readonly detail?: string
}

export interface CreateSessionInput {
  /** 会话工作目录；S1 已验证 set/get 2/2。 */
  readonly workingDirectory: string
  readonly title?: string
}

export interface ResumeSessionInput {
  /** 恢复时可覆盖工作目录；未提供则沿用会话记录。 */
  readonly workingDirectory?: string
}

export interface SendOptions {
  readonly signal?: AbortSignal
}

export interface EngineSessionSummary {
  readonly sessionId: SessionId
  readonly runtimeId: string
  readonly workingDirectory: string
  readonly state: 'starting' | 'ready' | 'closed' | 'failed'
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

interface EngineEventBase {
  readonly sessionId: SessionId
  readonly at: IsoTimestamp
}

export interface EngineMessageDelta extends EngineEventBase {
  readonly kind: 'message.delta'
  readonly text: string
}

export interface EngineMessageComplete extends EngineEventBase {
  readonly kind: 'message.complete'
  readonly text: string
}

export interface EngineToolCall extends EngineEventBase {
  readonly kind: 'tool.call'
  readonly toolName: string
  readonly callId: string
  readonly summary: string
}

export interface EngineToolResult extends EngineEventBase {
  readonly kind: 'tool.result'
  readonly toolName: string
  readonly callId: string
  readonly ok: boolean
  readonly summary: string
  /** 大输出落盘后的文件路径；产品层按需展开（省 token 纪律）。 */
  readonly outputFile?: string
}

/**
 * 压缩事件：S3 已证三类事件出现在 `RunResult.events`；A1 补测 v2（2026-10-21）
 * 证实窗口内外均可观测、稳定 ID `data.compactionId`，以及 `turn` /
 * `shadowedTokenCount` / `usage` 等字段形态；注入仅 user-role，system 不可。
 * `raw` 仅允许 adapter/诊断使用，产品逻辑不得依赖。
 */
export interface EngineCompactionEvent extends EngineEventBase {
  readonly kind: 'compaction.start' | 'compaction.summary' | 'compaction.end'
  readonly raw: unknown
}

export interface EngineSessionErrorEvent extends EngineEventBase {
  readonly kind: 'session.error'
  readonly error: EngineError
}

export interface EngineSessionClosedEvent extends EngineEventBase {
  readonly kind: 'session.closed'
  readonly reason: 'requested' | 'crashed' | 'unknown'
}

export type EngineEvent =
  | EngineMessageDelta
  | EngineMessageComplete
  | EngineToolCall
  | EngineToolResult
  | EngineCompactionEvent
  | EngineSessionErrorEvent
  | EngineSessionClosedEvent

/** 一次会话句柄；`send` 以异步事件流返回增量。 */
export interface EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId: string
  send(prompt: string, options?: SendOptions): AsyncIterable<EngineEvent>
  setWorkingDirectory(path: string): Promise<void>
  getWorkingDirectory(): Promise<string>
  close(): Promise<void>
}

/**
 * 引擎管理器端口。
 *
 * 生命周期：`start` → `createSession`/`resumeSession` → … → `stop`。
 * 进程级 kill 后不会自动恢复（N6）：实现只承诺显式错误事件，重启策略由上层负责。
 * `listSessions` 的语义是「产品自建会话台账」，不得依赖 SDK 枚举（N7）。
 */
export interface EnginePort {
  readonly engineId: EngineId
  start(): Promise<void>
  stop(): Promise<void>
  createSession(input: CreateSessionInput): Promise<EngineSession>
  resumeSession(sessionId: SessionId, input?: ResumeSessionInput): Promise<EngineSession>
  listSessions(): Promise<readonly EngineSessionSummary[]>
  capabilities(): EngineCapabilities
  health(): Promise<EngineHealth>
}

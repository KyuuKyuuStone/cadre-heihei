/**
 * 通道层错误码与错误结构。
 *
 * W1-04 类型草案；契约来源 `docs/product/backend/01` §2.4/§2.5/§3。
 * 成功一律 `{ ok: true, ... }`；失败一律 `{ ok: false, error: {...} }`，
 * 无「HTTP 200 = 成功」的隐含语义（03 篇 E1）。
 */
import type { ApiVersion, IdempotencyKey, IsoTimestamp, ProjectId, SessionId, TaskId } from './ids.ts'
import type { Channel } from './common.ts'
import type { TaskStatus } from './task-status.ts'

export const ERROR_CODES = [
  'MISSING_TASK_ID',
  'TASK_NOT_FOUND',
  'CROSS_PROJECT_DENIED',
  'INVALID_TRANSITION',
  'MISSING_REASON',
  'FORBIDDEN_ACTOR',
  'EMPTY_BODY',
  'CLIENT_COMMAND_REJECTED',
  'IDEMPOTENCY_CONFLICT',
  'DELIVERY_FAILED',
  'INTERNAL_ERROR',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * 可重试性（前端错误条分层用）。U-08 已裁决：
 * `INTERNAL_ERROR` 为未知错误，**不自动重试**（retryable=false），是否重试由上层决定。
 */
export const ERROR_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  MISSING_TASK_ID: false,
  TASK_NOT_FOUND: false,
  CROSS_PROJECT_DENIED: false,
  INVALID_TRANSITION: false,
  MISSING_REASON: false,
  FORBIDDEN_ACTOR: false,
  EMPTY_BODY: false,
  CLIENT_COMMAND_REJECTED: false,
  IDEMPOTENCY_CONFLICT: false,
  DELIVERY_FAILED: true,
  INTERNAL_ERROR: false,
}

export interface ErrorDetail<C extends ErrorCode = ErrorCode> {
  readonly code: C
  readonly message: string
  readonly retryable: boolean
  /** harness/引擎原始错误码；仅 `INTERNAL_ERROR` 等映射失败时附带（backend/01 §6）。 */
  readonly rawCode?: string
}

export interface ApiFailure<C extends ErrorCode = ErrorCode> {
  readonly ok: false
  readonly apiVersion: ApiVersion
  readonly error: ErrorDetail<C>
}

/**
 * 漏 taskId 的汇报候选（backend/01 §2.4）：
 * 同项目 + 同汇报会话 + 非终态（不含 delivered/review），按 updatedAt DESC，上限 10。
 */
export type TaskCandidateStatus = Extract<TaskStatus, 'dispatched' | 'accepted' | 'in_progress' | 'rework'>

export interface TaskCandidate {
  readonly taskId: TaskId
  readonly title: string
  readonly status: TaskCandidateStatus
  readonly updatedAt: IsoTimestamp
  readonly assigneeSessionId: SessionId
}

export const CANDIDATE_LIMIT = 10 as const
export const CANDIDATE_SCOPE = 'same-project-and-same-assignee-non-terminal' as const

export interface MissingTaskIdDetail extends ErrorDetail<'MISSING_TASK_ID'> {
  readonly projectId: ProjectId
  readonly candidates: readonly TaskCandidate[]
  readonly candidateCount: number
  readonly truncated: boolean
  /** 无候选时也必须给出下一步（铁律 11：空是合法态）。 */
  readonly hint: string
}

export interface MissingTaskIdFailure extends ApiFailure<'MISSING_TASK_ID'> {
  readonly error: MissingTaskIdDetail
}

export interface TaskNotFoundDetail extends ErrorDetail<'TASK_NOT_FOUND'> {
  readonly projectId: ProjectId
  readonly taskId: TaskId
}

export interface TaskNotFoundFailure extends ApiFailure<'TASK_NOT_FOUND'> {
  readonly error: TaskNotFoundDetail
}

/**
 * 跨项目拒绝：不区分「不存在」与「无权」，不返回候选、不回显任务字段，
 * 避免调用方探测其他项目是否存在（backend/01 §3）。
 */
export interface CrossProjectDeniedDetail extends ErrorDetail<'CROSS_PROJECT_DENIED'> {
  /** 调用方会话绑定的项目；忽略请求体中的 project_id。 */
  readonly projectId: ProjectId
  readonly candidates?: never
  readonly taskId?: never
  readonly taskTitle?: never
  readonly taskExists?: never
}

export interface CrossProjectDeniedFailure extends ApiFailure<'CROSS_PROJECT_DENIED'> {
  readonly error: CrossProjectDeniedDetail
}

export interface InvalidTransitionDetail extends ErrorDetail<'INVALID_TRANSITION'> {
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly from: TaskStatus
  readonly to: TaskStatus
}

export interface InvalidTransitionFailure extends ApiFailure<'INVALID_TRANSITION'> {
  readonly error: InvalidTransitionDetail
}

/** 目标态要求 reason 的状态（backend/01 §1.2：rework/failed/cancelled 必填）。 */
export type ReasonRequiredStatus = Extract<TaskStatus, 'rework' | 'failed' | 'cancelled'>

/**
 * 需要 reason 的迁移未提供 reason。
 * 适用：目标态为 `rework` / `failed` / `cancelled` 的迁移（`task_events.reason` 必填）。
 */
export interface MissingReasonDetail extends ErrorDetail<'MISSING_REASON'> {
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly to: ReasonRequiredStatus
  readonly requiredFor: readonly ReasonRequiredStatus[]
}

export interface MissingReasonFailure extends ApiFailure<'MISSING_REASON'> {
  readonly error: MissingReasonDetail
}

export type ForbiddenActorReason =
  | 'not-assignee'
  | 'not-supervisor'
  | 'target-not-member'
  | 'target-offline'
  | 'role-mismatch'

export interface ForbiddenActorDetail extends ErrorDetail<'FORBIDDEN_ACTOR'> {
  readonly projectId: ProjectId
  readonly taskId?: TaskId
  readonly actorSessionId?: SessionId
  readonly targetSessionId?: SessionId
  readonly requiredActor?: 'assignee' | 'supervisor'
  readonly reasonCategory: ForbiddenActorReason
}

export interface ForbiddenActorFailure extends ApiFailure<'FORBIDDEN_ACTOR'> {
  readonly error: ForbiddenActorDetail
}

export interface EmptyBodyDetail extends ErrorDetail<'EMPTY_BODY'> {
  readonly field: 'body'
}

export interface EmptyBodyFailure extends ApiFailure<'EMPTY_BODY'> {
  readonly error: EmptyBodyDetail
}

/** 派活前置校验：客户端命令（如 `/compact`）必须在入口拒绝（`05` 第 8 条）。 */
export interface ClientCommandRejectedDetail extends ErrorDetail<'CLIENT_COMMAND_REJECTED'> {
  readonly command: string
}

export interface ClientCommandRejectedFailure extends ApiFailure<'CLIENT_COMMAND_REJECTED'> {
  readonly error: ClientCommandRejectedDetail
}

/** 同 idempotencyKey 不同正文；同正文重复提交应返回首次回执而非报错。 */
export interface IdempotencyConflictDetail extends ErrorDetail<'IDEMPOTENCY_CONFLICT'> {
  readonly idempotencyKey: IdempotencyKey
}

export interface IdempotencyConflictFailure extends ApiFailure<'IDEMPOTENCY_CONFLICT'> {
  readonly error: IdempotencyConflictDetail
}

/** 通道投递失败：显式报错，不静默改道；HTTP 不可达时提示降级路径。 */
export interface DeliveryFailedDetail extends ErrorDetail<'DELIVERY_FAILED'> {
  readonly channel: Channel
  readonly attemptedChannels: readonly Channel[]
}

export interface DeliveryFailedFailure extends ApiFailure<'DELIVERY_FAILED'> {
  readonly error: DeliveryFailedDetail
}

export type ApiError =
  | MissingTaskIdFailure
  | TaskNotFoundFailure
  | CrossProjectDeniedFailure
  | InvalidTransitionFailure
  | MissingReasonFailure
  | ForbiddenActorFailure
  | EmptyBodyFailure
  | ClientCommandRejectedFailure
  | IdempotencyConflictFailure
  | DeliveryFailedFailure
  | ApiFailure<'INTERNAL_ERROR'>

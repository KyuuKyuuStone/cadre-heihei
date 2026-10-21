/**
 * 台账公共类型：命令、记录、事件、错误与结果。
 *
 * 内存实现与 SQLite 实现共享本文件的语义；状态迁移规则仍以 `rules.ts` 为单一事实源。
 */
import type {
  ErrorCode,
  EventId,
  ForbiddenActorReason,
  IdempotencyKey,
  IsoTimestamp,
  ProjectId,
  ReasonRequiredStatus,
  SessionId,
  TaskId,
  TaskStatus,
} from '../protocol/index.ts'

export type LedgerActor =
  | {
      readonly kind: 'session'
      readonly sessionId: SessionId
      readonly role: 'assignee' | 'supervisor'
    }
  | {
      readonly kind: 'system'
      readonly onBehalfOf: SessionId
    }

export interface CreateTaskCommand {
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly title: string
  readonly body: string
  readonly dispatcherSessionId: SessionId
  readonly assigneeSessionId: SessionId
  readonly supersedesTaskId?: TaskId
  readonly idempotencyKey: IdempotencyKey
}

export interface TransitionCommand {
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly actor: LedgerActor
  readonly reason?: string
  readonly idempotencyKey: IdempotencyKey
}

export interface TaskRecord {
  readonly taskId: TaskId
  readonly projectId: ProjectId
  readonly seq: number
  readonly title: string
  readonly body: string
  readonly status: TaskStatus
  readonly dispatcherSessionId: SessionId
  readonly assigneeSessionId: SessionId
  readonly attempt: number
  readonly supersedesTaskId?: TaskId
  readonly supersededByTaskId?: TaskId
  readonly version: number
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly acceptedAt?: IsoTimestamp
  readonly startedAt?: IsoTimestamp
  readonly deliveredAt?: IsoTimestamp
  readonly reviewStartedAt?: IsoTimestamp
  readonly closedAt?: IsoTimestamp
}

export interface TaskEvent {
  readonly eventId: EventId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly fromStatus?: TaskStatus
  readonly toStatus: TaskStatus
  /** 系统自动推进填 'system'（契约 task_events.actor_session_id 口径）。 */
  readonly actorSessionId: SessionId | 'system'
  readonly reason?: string
  readonly idempotencyKey: IdempotencyKey
  readonly at: IsoTimestamp
}

export interface LedgerError {
  readonly code: ErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly projectId: ProjectId
  readonly taskId?: TaskId
  readonly from?: TaskStatus
  readonly to?: TaskStatus
  readonly reasonCategory?: ForbiddenActorReason
  readonly requiredActor?: 'assignee' | 'supervisor'
  readonly requiredFor?: readonly ReasonRequiredStatus[]
}

export type LedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LedgerError }

export interface CreateTaskOutcomeBase {
  readonly task: TaskRecord
  /** 被取代并置 cancelled 的旧任务（无取代时缺省）。 */
  readonly superseded?: TaskRecord
}

export interface TransitionOutcomeBase {
  readonly task: TaskRecord
  readonly event: TaskEvent
}

export type CreateTaskOutcome = CreateTaskOutcomeBase & { readonly replayed: boolean }
export type TransitionOutcome = TransitionOutcomeBase & { readonly replayed: boolean }

export interface LedgerDeps {
  readonly now?: () => IsoTimestamp
  readonly newId?: () => string
}

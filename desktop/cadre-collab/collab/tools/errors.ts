/**
 * 工具层结构化错误。拒绝一律先于业务写；不返回「等待审批」中间态。
 * 错误对象形状复用 protocol/errors.ts，不新增契约字段。
 */
import {
  API_VERSION,
  ERROR_RETRYABLE,
  type ApiFailure,
  type ErrorCode,
  type ProjectId,
  type SessionId,
  type TaskId,
  type TaskStatus,
} from '../protocol/index.ts'
import type { LedgerError } from '../ledger/index.ts'

export function failure(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): ApiFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: { ...extra, code, message, retryable: ERROR_RETRYABLE[code] },
  } as ApiFailure
}

export function invalidArgument(field: string, reason: string): ApiFailure {
  return failure('INVALID_ARGUMENT', `参数非法：${field}`, { field, reason })
}

export function crossProjectDenied(projectId: ProjectId): ApiFailure {
  return failure('CROSS_PROJECT_DENIED', '跨项目请求已拒绝', { projectId })
}

export function taskNotFound(projectId: ProjectId, taskId: TaskId): ApiFailure {
  return failure('TASK_NOT_FOUND', `任务不存在：${taskId}`, { projectId, taskId })
}

export function forbiddenNotSupervisor(
  projectId: ProjectId,
  actorSessionId: SessionId,
  taskId?: TaskId,
): ApiFailure {
  return failure('FORBIDDEN_ACTOR', '执行者不是本项目在册 supervisor', {
    projectId,
    actorSessionId,
    ...(taskId === undefined ? {} : { taskId }),
    reasonCategory: 'not-supervisor',
    requiredActor: 'supervisor',
  })
}

export function forbiddenNotAssignee(
  projectId: ProjectId,
  actorSessionId: SessionId,
  taskId: TaskId,
): ApiFailure {
  return failure('FORBIDDEN_ACTOR', '调用方不是该任务的 assignee', {
    projectId,
    actorSessionId,
    taskId,
    reasonCategory: 'not-assignee',
    requiredActor: 'assignee',
  })
}

/** 台账错误 → 工具层 ApiFailure（保留既有错误码，不吞错）。 */
export function mapLedgerError(error: LedgerError): ApiFailure {
  switch (error.code) {
    case 'CROSS_PROJECT_DENIED':
      return crossProjectDenied(error.projectId)
    case 'TASK_NOT_FOUND':
      return failure('TASK_NOT_FOUND', error.message, {
        projectId: error.projectId,
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
      })
    case 'FORBIDDEN_ACTOR':
      return failure('FORBIDDEN_ACTOR', error.message, {
        projectId: error.projectId,
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.actorSessionId === undefined ? {} : { actorSessionId: error.actorSessionId }),
        ...(error.reasonCategory === undefined ? {} : { reasonCategory: error.reasonCategory }),
        ...(error.requiredActor === undefined ? {} : { requiredActor: error.requiredActor }),
      })
    case 'INVALID_TRANSITION':
      return failure('INVALID_TRANSITION', error.message, {
        projectId: error.projectId,
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.from === undefined ? {} : { from: error.from }),
        ...(error.to === undefined ? {} : { to: error.to }),
      })
    case 'MISSING_REASON':
      return failure('MISSING_REASON', error.message, {
        projectId: error.projectId,
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.to === undefined ? {} : { to: error.to }),
        ...(error.requiredFor === undefined ? {} : { requiredFor: error.requiredFor }),
      })
    case 'IDEMPOTENCY_CONFLICT':
      return failure('IDEMPOTENCY_CONFLICT', error.message, { projectId: error.projectId })
    default:
      return failure('INTERNAL_ERROR', error.message, {
        rawCode: error.rawCode ?? error.code,
      })
  }
}

export type TransitionTo = TaskStatus

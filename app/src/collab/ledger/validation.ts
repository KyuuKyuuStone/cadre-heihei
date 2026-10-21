/**
 * 台账共享校验与迁移效果。
 *
 * 内存实现与 SQLite 实现都必须调用这里，避免两份业务规则漂移；
 * 迁移合法性（from → to 与允许执行者）只查 `rules.ts` / `TASK_TRANSITION_RULES`。
 *
 * supervisor 判定（ADR-0019）：只信 `SupervisorResolver` 的解析结果，
 * **禁止**用 `dispatcherSessionId` 推断；跨项目在解析前先拒绝。
 */
import {
  ERROR_RETRYABLE,
  type IsoTimestamp,
  type TaskStatus,
  type TransitionActorKind,
} from '../protocol/index.ts'
import {
  REASON_REQUIRED_STATUSES,
  findTransitionRule,
  isTerminalStatus,
  requiresReason,
} from './rules.ts'
import type { SupervisorResolver } from './supervisor-resolver.ts'
import type {
  CreateTaskCommand,
  LedgerActor,
  LedgerError,
  TaskRecord,
  TransitionCommand,
} from './types.ts'

export function makeError(error: Omit<LedgerError, 'retryable'>): LedgerError {
  return { ...error, retryable: ERROR_RETRYABLE[error.code] }
}

export function createTaskFingerprint(command: CreateTaskCommand): string {
  return [
    'create',
    command.taskId,
    command.title,
    command.body,
    command.dispatcherSessionId,
    command.assigneeSessionId,
    command.supersedesTaskId ?? '',
  ].join('\u0000')
}

function actorFingerprint(actor: LedgerActor): string {
  return actor.kind === 'system'
    ? `system:${actor.onBehalfOf}`
    : `session:${actor.role}:${actor.sessionId}`
}

export function transitionFingerprint(command: TransitionCommand): string {
  return [
    'transition',
    command.taskId,
    command.from,
    command.to,
    actorFingerprint(command.actor),
    command.reason ?? '',
  ].join('\u0000')
}

/**
 * 解析执行者类型。supervisor 分支只调用 resolver（ADR-0019），
 * 不读取 task.dispatcherSessionId；resolver 故障返回 INTERNAL_ERROR（fail-closed）。
 */
export function resolveActorKind(
  task: TaskRecord,
  command: TransitionCommand,
  resolver: SupervisorResolver,
): TransitionActorKind | LedgerError {
  const actor = command.actor
  const actorSessionId = actor.kind === 'system' ? actor.onBehalfOf : actor.sessionId

  if (actor.kind === 'system') {
    if (actor.onBehalfOf === task.assigneeSessionId) return 'system'
    return makeError({
      code: 'FORBIDDEN_ACTOR',
      message: '系统推进必须代表该任务的 assignee',
      projectId: command.projectId,
      taskId: task.taskId,
      actorSessionId,
      reasonCategory: 'not-assignee',
      requiredActor: 'assignee',
    })
  }

  if (actor.role === 'assignee') {
    if (actor.sessionId === task.assigneeSessionId) return 'assignee'
    return makeError({
      code: 'FORBIDDEN_ACTOR',
      message: '执行者不是该任务的 assignee',
      projectId: command.projectId,
      taskId: task.taskId,
      actorSessionId,
      reasonCategory: 'not-assignee',
      requiredActor: 'assignee',
    })
  }

  let resolved: boolean | 'unavailable'
  try {
    resolved = resolver.isSupervisor(command.projectId, actor.sessionId)
  } catch {
    resolved = 'unavailable'
  }
  if (resolved === 'unavailable') {
    return makeError({
      code: 'INTERNAL_ERROR',
      message: 'supervisor 花名册解析不可用',
      projectId: command.projectId,
      taskId: task.taskId,
      actorSessionId,
      rawCode: 'SUPERVISOR_RESOLVER_UNAVAILABLE',
    })
  }
  if (!resolved) {
    return makeError({
      code: 'FORBIDDEN_ACTOR',
      message: '执行者不是本项目在册 supervisor',
      projectId: command.projectId,
      taskId: task.taskId,
      actorSessionId,
      reasonCategory: 'not-supervisor',
      requiredActor: 'supervisor',
    })
  }
  return 'supervisor'
}

/** 迁移校验（任务已按 taskId 取出）；返回 null 表示允许。 */
export function validateTransition(
  task: TaskRecord,
  command: TransitionCommand,
  resolver: SupervisorResolver,
): LedgerError | null {
  // 跨项目优先：不查花名册、不泄露存在性。
  if (task.projectId !== command.projectId) {
    return makeError({
      code: 'CROSS_PROJECT_DENIED',
      message: '任务属于其他项目',
      projectId: command.projectId,
    })
  }
  if (task.status !== command.from) {
    return makeError({
      code: 'INVALID_TRANSITION',
      message: `迁移起点与当前状态不符：期望 ${task.status}，收到 ${command.from}`,
      projectId: command.projectId,
      taskId: command.taskId,
      from: task.status,
      to: command.to,
    })
  }
  const rule = findTransitionRule(command.from, command.to)
  if (!rule) {
    return makeError({
      code: 'INVALID_TRANSITION',
      message: isTerminalStatus(task.status)
        ? `终态不可迁移：${task.status}`
        : `不允许的迁移：${command.from} → ${command.to}`,
      projectId: command.projectId,
      taskId: command.taskId,
      from: command.from,
      to: command.to,
    })
  }
  if (requiresReason(command.to) && (command.reason === undefined || command.reason.trim() === '')) {
    return makeError({
      code: 'MISSING_REASON',
      message: `目标态 ${command.to} 的迁移必须提供非空 reason`,
      projectId: command.projectId,
      taskId: command.taskId,
      to: command.to,
      requiredFor: REASON_REQUIRED_STATUSES,
    })
  }

  const actorKind = resolveActorKind(task, command, resolver)
  if (typeof actorKind !== 'string') return actorKind
  if (!rule.actors.includes(actorKind)) {
    return makeError(forbiddenActor(command, task, rule.actors))
  }
  return null
}

export interface TransitionEffects {
  readonly status: TaskStatus
  readonly attempt: number
  readonly acceptedAt?: IsoTimestamp
  readonly startedAt?: IsoTimestamp
  readonly deliveredAt?: IsoTimestamp
  readonly reviewStartedAt?: IsoTimestamp
  readonly closedAt?: IsoTimestamp
}

/** 迁移对任务字段的影响；时间字段只在首次进入对应状态时写。 */
export function transitionEffects(task: TaskRecord, to: TaskStatus, at: IsoTimestamp): TransitionEffects {
  return {
    status: to,
    attempt: to === 'rework' ? task.attempt + 1 : task.attempt,
    acceptedAt: to === 'accepted' ? at : task.acceptedAt,
    startedAt: to === 'in_progress' ? (task.startedAt ?? at) : task.startedAt,
    deliveredAt: to === 'delivered' ? at : task.deliveredAt,
    reviewStartedAt: to === 'review' ? at : task.reviewStartedAt,
    closedAt: isTerminalStatus(to) ? at : task.closedAt,
  }
}

/** 取代目标校验；`old` 为 undefined 表示同项目内不存在。 */
export function validateSupersedeTarget(
  projectId: CreateTaskCommand['projectId'],
  newTaskId: CreateTaskCommand['taskId'],
  requestedId: CreateTaskCommand['taskId'],
  old: TaskRecord | undefined,
): LedgerError | null {
  if (requestedId === newTaskId) {
    return makeError({
      code: 'INVALID_TRANSITION',
      message: '任务不得取代自身',
      projectId,
      taskId: newTaskId,
      to: 'cancelled',
    })
  }
  if (!old) {
    return makeError({
      code: 'TASK_NOT_FOUND',
      message: `被取代任务不存在：${requestedId}`,
      projectId,
      taskId: requestedId,
    })
  }
  if (old.projectId !== projectId) {
    return makeError({
      code: 'CROSS_PROJECT_DENIED',
      message: '被取代任务属于其他项目',
      projectId,
    })
  }
  if (isTerminalStatus(old.status)) {
    return makeError({
      code: 'INVALID_TRANSITION',
      message: `终态任务不可取代：${old.status}`,
      projectId,
      taskId: old.taskId,
      from: old.status,
      to: 'cancelled',
    })
  }
  return null
}

function forbiddenActor(
  command: TransitionCommand,
  task: TaskRecord,
  allowed: readonly TransitionActorKind[],
): Omit<LedgerError, 'retryable'> {
  const actorSessionId =
    command.actor.kind === 'system' ? command.actor.onBehalfOf : command.actor.sessionId
  const required = allowed.find((kind): kind is 'assignee' | 'supervisor' => kind !== 'system')
  return {
    code: 'FORBIDDEN_ACTOR',
    message: '执行者与迁移权限不符',
    projectId: command.projectId,
    taskId: task.taskId,
    actorSessionId,
    from: command.from,
    to: command.to,
    reasonCategory: 'role-mismatch',
    ...(required ? { requiredActor: required } : {}),
  }
}

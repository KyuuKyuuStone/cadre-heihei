/**
 * 台账内存仓储：状态机迁移、权限矩阵、审计事件、幂等键、取代语义。
 *
 * 设计约束（W1-05）：
 * - 不接 SQLite；持久化属后续任务（B5 已过，但落库另行派单）。
 * - 迁移合法性只查 `TASK_TRANSITION_RULES`（rules.ts），不另写矩阵。
 * - 所有变更同步完成，天然原子；拒绝路径不得修改任何状态。
 * - 项目隔离：任务按 taskId 全局索引，但读写必须校验 `projectId`。
 */
import { randomUUID } from 'node:crypto'
import {
  type ErrorCode,
  type EventId,
  type ForbiddenActorReason,
  type IdempotencyKey,
  type IsoTimestamp,
  type ProjectId,
  type SessionId,
  type TaskId,
  type TaskStatus,
  type TransitionActorKind,
} from '../protocol/index.ts'
import { findTransitionRule, isTerminalStatus } from './rules.ts'

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
  readonly projectId: ProjectId
  readonly taskId?: TaskId
  readonly from?: TaskStatus
  readonly to?: TaskStatus
  readonly reasonCategory?: ForbiddenActorReason
  readonly requiredActor?: 'assignee' | 'supervisor'
}

export type LedgerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: LedgerError }

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

type MutableTask = { -readonly [K in keyof TaskRecord]: TaskRecord[K] }

interface StoredIdempotent {
  readonly kind: 'create' | 'transition'
  readonly fingerprint: string
  readonly value: unknown
}

const DEFAULT_NOW = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp
const DEFAULT_NEW_ID = (): string => randomUUID()

function actorFingerprint(actor: LedgerActor): string {
  return actor.kind === 'system'
    ? `system:${actor.onBehalfOf}`
    : `session:${actor.role}:${actor.sessionId}`
}

function actorSessionId(actor: LedgerActor): SessionId | 'system' {
  return actor.kind === 'system' ? 'system' : actor.sessionId
}

function copyTask(task: MutableTask): TaskRecord {
  return { ...task }
}

function fail(error: LedgerError): LedgerResult<never> {
  return { ok: false, error }
}

export class InMemoryTaskLedger {
  private readonly tasks = new Map<string, MutableTask>()
  private readonly events = new Map<string, TaskEvent[]>()
  private readonly seqByProject = new Map<string, number>()
  private readonly idempotency = new Map<string, StoredIdempotent>()
  private readonly now: () => IsoTimestamp
  private readonly newId: () => string

  constructor(deps: LedgerDeps = {}) {
    this.now = deps.now ?? DEFAULT_NOW
    this.newId = deps.newId ?? DEFAULT_NEW_ID
  }

  createTask(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome> {
    const fingerprint = [
      'create',
      command.taskId,
      command.title,
      command.body,
      command.dispatcherSessionId,
      command.assigneeSessionId,
      command.supersedesTaskId ?? '',
    ].join('\u0000')

    const replay = this.lookupIdempotent<CreateTaskOutcomeBase>(
      command.projectId,
      command.idempotencyKey,
      'create',
      fingerprint,
    )
    if (replay.status === 'conflict') return fail(this.idempotencyConflict(command.projectId, command.idempotencyKey))
    if (replay.status === 'hit') {
      return { ok: true, value: { ...replay.value, replayed: true } }
    }

    if (this.tasks.has(command.taskId)) {
      return fail({
        code: 'INTERNAL_ERROR',
        message: `taskId 已存在：${command.taskId}`,
        projectId: command.projectId,
        taskId: command.taskId,
      })
    }

    let oldTask: MutableTask | undefined
    if (command.supersedesTaskId !== undefined) {
      if (command.supersedesTaskId === command.taskId) {
        return fail({
          code: 'INVALID_TRANSITION',
          message: '任务不得取代自身',
          projectId: command.projectId,
          taskId: command.taskId,
          to: 'cancelled',
        })
      }
      const found = this.tasks.get(command.supersedesTaskId)
      if (!found) {
        return fail({
          code: 'TASK_NOT_FOUND',
          message: `被取代任务不存在：${command.supersedesTaskId}`,
          projectId: command.projectId,
          taskId: command.supersedesTaskId,
        })
      }
      if (found.projectId !== command.projectId) {
        return fail({
          code: 'CROSS_PROJECT_DENIED',
          message: '被取代任务属于其他项目',
          projectId: command.projectId,
        })
      }
      if (isTerminalStatus(found.status)) {
        return fail({
          code: 'INVALID_TRANSITION',
          message: `终态任务不可取代：${found.status}`,
          projectId: command.projectId,
          taskId: found.taskId,
          from: found.status,
          to: 'cancelled',
        })
      }
      oldTask = found
    }

    const at = this.now()
    const seq = (this.seqByProject.get(command.projectId) ?? 0) + 1
    this.seqByProject.set(command.projectId, seq)

    const task: MutableTask = {
      taskId: command.taskId,
      projectId: command.projectId,
      seq,
      title: command.title,
      body: command.body,
      status: 'dispatched',
      dispatcherSessionId: command.dispatcherSessionId,
      assigneeSessionId: command.assigneeSessionId,
      attempt: 0,
      supersedesTaskId: command.supersedesTaskId,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }
    this.tasks.set(command.taskId, task)
    this.pushEvent({
      projectId: command.projectId,
      taskId: command.taskId,
      toStatus: 'dispatched',
      actorSessionId: command.dispatcherSessionId,
      idempotencyKey: command.idempotencyKey,
      at,
    })

    let superseded: TaskRecord | undefined
    if (oldTask) {
      const fromStatus = oldTask.status
      oldTask.status = 'cancelled'
      oldTask.supersededByTaskId = command.taskId
      oldTask.version += 1
      oldTask.updatedAt = at
      oldTask.closedAt = at
      this.pushEvent({
        projectId: oldTask.projectId,
        taskId: oldTask.taskId,
        fromStatus,
        toStatus: 'cancelled',
        actorSessionId: command.dispatcherSessionId,
        reason: 'superseded',
        idempotencyKey: command.idempotencyKey,
        at,
      })
      superseded = copyTask(oldTask)
    }

    const value: CreateTaskOutcomeBase = superseded
      ? { task: copyTask(task), superseded }
      : { task: copyTask(task) }
    this.storeIdempotent(command.projectId, command.idempotencyKey, 'create', fingerprint, value)
    return { ok: true, value: { ...value, replayed: false } }
  }

  transition(command: TransitionCommand): LedgerResult<TransitionOutcome> {
    const fingerprint = [
      'transition',
      command.taskId,
      command.from,
      command.to,
      actorFingerprint(command.actor),
      command.reason ?? '',
    ].join('\u0000')

    const replay = this.lookupIdempotent<TransitionOutcomeBase>(
      command.projectId,
      command.idempotencyKey,
      'transition',
      fingerprint,
    )
    if (replay.status === 'conflict') return fail(this.idempotencyConflict(command.projectId, command.idempotencyKey))
    if (replay.status === 'hit') {
      return { ok: true, value: { ...replay.value, replayed: true } }
    }

    const task = this.tasks.get(command.taskId)
    if (!task) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${command.taskId}`,
        projectId: command.projectId,
        taskId: command.taskId,
      })
    }
    if (task.projectId !== command.projectId) {
      return fail({
        code: 'CROSS_PROJECT_DENIED',
        message: '任务属于其他项目',
        projectId: command.projectId,
      })
    }

    if (task.status !== command.from) {
      return fail({
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
      return fail({
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

    const actorKind = this.resolveActorKind(task, command.actor)
    if (actorKind === null || !rule.actors.includes(actorKind)) {
      return fail(this.forbiddenActor(command, task, rule.actors, actorKind))
    }

    const at = this.now()
    const fromStatus = task.status
    task.status = command.to
    task.version += 1
    task.updatedAt = at
    if (command.to === 'accepted') task.acceptedAt = at
    if (command.to === 'in_progress') task.startedAt ??= at
    if (command.to === 'delivered') task.deliveredAt = at
    if (command.to === 'review') task.reviewStartedAt = at
    if (command.to === 'rework') task.attempt += 1
    if (isTerminalStatus(command.to)) task.closedAt = at

    const event = this.pushEvent({
      projectId: command.projectId,
      taskId: command.taskId,
      fromStatus,
      toStatus: command.to,
      actorSessionId: actorSessionId(command.actor),
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      at,
    })

    const value: TransitionOutcomeBase = { task: copyTask(task), event }
    this.storeIdempotent(command.projectId, command.idempotencyKey, 'transition', fingerprint, value)
    return { ok: true, value: { ...value, replayed: false } }
  }

  getTask(projectId: ProjectId, taskId: TaskId): LedgerResult<TaskRecord> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${taskId}`,
        projectId,
        taskId,
      })
    }
    if (task.projectId !== projectId) {
      return fail({
        code: 'CROSS_PROJECT_DENIED',
        message: '任务属于其他项目',
        projectId,
      })
    }
    return { ok: true, value: copyTask(task) }
  }

  listTasks(projectId: ProjectId): readonly TaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId).map(copyTask)
  }

  listEvents(projectId: ProjectId, taskId: TaskId): LedgerResult<readonly TaskEvent[]> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${taskId}`,
        projectId,
        taskId,
      })
    }
    if (task.projectId !== projectId) {
      return fail({
        code: 'CROSS_PROJECT_DENIED',
        message: '任务属于其他项目',
        projectId,
      })
    }
    return { ok: true, value: [...(this.events.get(taskId) ?? [])] }
  }

  private resolveActorKind(task: MutableTask, actor: LedgerActor): TransitionActorKind | null {
    if (actor.kind === 'system') {
      return actor.onBehalfOf === task.assigneeSessionId ? 'system' : null
    }
    if (actor.role === 'assignee') {
      return actor.sessionId === task.assigneeSessionId ? 'assignee' : null
    }
    return actor.sessionId === task.dispatcherSessionId ? 'supervisor' : null
  }

  private forbiddenActor(
    command: TransitionCommand,
    task: MutableTask,
    allowed: readonly TransitionActorKind[],
    actorKind: TransitionActorKind | null,
  ): LedgerError {
    const reasonCategory: ForbiddenActorReason =
      actorKind !== null
        ? 'role-mismatch'
        : command.actor.kind === 'system'
          ? 'not-assignee'
          : command.actor.role === 'assignee'
            ? 'not-assignee'
            : 'not-supervisor'
    const required = allowed.find((kind): kind is 'assignee' | 'supervisor' => kind !== 'system')
    return {
      code: 'FORBIDDEN_ACTOR',
      message: '执行者与迁移权限不符',
      projectId: command.projectId,
      taskId: task.taskId,
      from: command.from,
      to: command.to,
      reasonCategory,
      ...(required ? { requiredActor: required } : {}),
    }
  }

  private pushEvent(input: {
    projectId: ProjectId
    taskId: TaskId
    fromStatus?: TaskStatus
    toStatus: TaskStatus
    actorSessionId: SessionId | 'system'
    reason?: string
    idempotencyKey: IdempotencyKey
    at: IsoTimestamp
  }): TaskEvent {
    const event: TaskEvent = {
      eventId: this.newId() as EventId,
      projectId: input.projectId,
      taskId: input.taskId,
      ...(input.fromStatus === undefined ? {} : { fromStatus: input.fromStatus }),
      toStatus: input.toStatus,
      actorSessionId: input.actorSessionId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      idempotencyKey: input.idempotencyKey,
      at: input.at,
    }
    const list = this.events.get(input.taskId) ?? []
    list.push(event)
    this.events.set(input.taskId, list)
    return event
  }

  private idempotencyConflict(projectId: ProjectId, key: IdempotencyKey): LedgerError {
    return {
      code: 'IDEMPOTENCY_CONFLICT',
      message: `幂等键已被不同请求占用：${key}`,
      projectId,
    }
  }

  /**
   * 三种结果：`hit` 同键同请求取回首次结果；`conflict` 同键不同请求；
   * `miss` 首次出现。只缓存成功结果，拒绝路径不写幂等表。
   */
  private lookupIdempotent<T>(
    projectId: ProjectId,
    key: IdempotencyKey,
    kind: 'create' | 'transition',
    fingerprint: string,
  ): { status: 'miss' } | { status: 'conflict' } | { status: 'hit'; value: T } {
    const stored = this.idempotency.get(this.idemKey(projectId, key))
    if (!stored) return { status: 'miss' }
    if (stored.kind !== kind || stored.fingerprint !== fingerprint) return { status: 'conflict' }
    return { status: 'hit', value: stored.value as T }
  }

  private storeIdempotent(
    projectId: ProjectId,
    key: IdempotencyKey,
    kind: 'create' | 'transition',
    fingerprint: string,
    value: unknown,
  ): void {
    this.idempotency.set(this.idemKey(projectId, key), { kind, fingerprint, value })
  }

  private idemKey(projectId: ProjectId, key: IdempotencyKey): string {
    return `${projectId}\u0000${key}`
  }
}

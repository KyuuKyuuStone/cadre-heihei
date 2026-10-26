/**
 * 台账内存仓储：状态机迁移、权限矩阵、审计事件、幂等键、取代语义。
 *
 * - 迁移合法性只查 `rules.ts` 的 `TASK_TRANSITION_RULES`，校验复用 `validation.ts`；
 * - 所有变更同步完成，天然原子；拒绝路径不得修改任何状态；
 * - `transaction()` 供派活/汇报在同一逻辑事务内组合任务、消息与审计事件；
 * - 持久化实现见 `sqlite-ledger.ts`，两者实现同一 `TaskLedgerPort`。
 */
import { randomUUID } from 'node:crypto'
import {
  type EventId,
  type IdempotencyKey,
  type IsoTimestamp,
  type ProjectId,
  type SessionId,
  type TaskId,
  type TaskStatus,
} from '../protocol/index.ts'
import type { LedgerTransaction, TaskLedgerPort } from './port.ts'
import {
  UnavailableSupervisorResolver,
  type SupervisorResolver,
} from './supervisor-resolver.ts'
import type {
  CreateTaskCommand,
  CreateTaskOutcome,
  LedgerDeps,
  LedgerError,
  LedgerResult,
  TaskEvent,
  TaskRecord,
  TransitionCommand,
  TransitionOutcome,
} from './types.ts'
import {
  createTaskFingerprint,
  makeError,
  transitionEffects,
  transitionFingerprint,
  validateSupersedeTarget,
  validateTransition,
} from './validation.ts'

export type * from './types.ts'

type MutableTask = { -readonly [K in keyof TaskRecord]: TaskRecord[K] }

interface StoredIdempotent {
  readonly kind: 'create' | 'transition'
  readonly fingerprint: string
  readonly value: CreateTaskOutcome | TransitionOutcome
}

const DEFAULT_NOW = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp
const DEFAULT_NEW_ID = (): string => randomUUID()

function actorSessionId(actor: TransitionCommand['actor']): SessionId | 'system' {
  return actor.kind === 'system' ? 'system' : actor.sessionId
}

function copyTask(task: MutableTask): TaskRecord {
  return { ...task }
}

function fail(error: Omit<LedgerError, 'retryable'>): LedgerResult<never> {
  return { ok: false, error: makeError(error) }
}

export class InMemoryTaskLedger implements TaskLedgerPort {
  private readonly tasks = new Map<string, MutableTask>()
  private readonly events = new Map<string, TaskEvent[]>()
  private readonly seqByProject = new Map<string, number>()
  private readonly idempotency = new Map<string, StoredIdempotent>()
  private readonly now: () => IsoTimestamp
  private readonly newId: () => string
  private readonly supervisorResolver: SupervisorResolver
  private readonly tx: LedgerTransaction

  constructor(deps: LedgerDeps = {}) {
    this.now = deps.now ?? DEFAULT_NOW
    this.newId = deps.newId ?? DEFAULT_NEW_ID
    this.supervisorResolver = deps.supervisorResolver ?? new UnavailableSupervisorResolver()
    this.tx = {
      createTask: (command) => this.createTaskTx(command),
      transition: (command) => this.transitionTx(command),
      getTask: (projectId, taskId) => this.getTask(projectId, taskId),
      listTasks: (projectId) => this.listTasks(projectId),
      listEvents: (projectId, taskId) => this.listEvents(projectId, taskId),
    }
  }

  /** 事务内操作：不再读写台账级幂等表（由上层组合操作负责）。 */
  transaction<T>(fn: (tx: LedgerTransaction) => T): T {
    return fn(this.tx)
  }

  createTask(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome> {
    const fingerprint = createTaskFingerprint(command)

    const replay = this.lookupIdempotent(command.projectId, command.idempotencyKey, 'create', fingerprint)
    if (replay.status === 'conflict') return fail(this.idempotencyConflict(command.projectId, command.idempotencyKey))
    if (replay.status === 'hit') {
      return { ok: true, value: { ...(replay.value as CreateTaskOutcome), replayed: true } }
    }

    const result = this.createTaskTx(command)
    if (result.ok) {
      this.storeIdempotent(command.projectId, command.idempotencyKey, 'create', fingerprint, result.value)
    }
    return result
  }

  transition(command: TransitionCommand): LedgerResult<TransitionOutcome> {
    const fingerprint = transitionFingerprint(command)

    const replay = this.lookupIdempotent(command.projectId, command.idempotencyKey, 'transition', fingerprint)
    if (replay.status === 'conflict') return fail(this.idempotencyConflict(command.projectId, command.idempotencyKey))
    if (replay.status === 'hit') {
      return { ok: true, value: { ...(replay.value as TransitionOutcome), replayed: true } }
    }

    const result = this.transitionTx(command)
    if (result.ok) {
      this.storeIdempotent(command.projectId, command.idempotencyKey, 'transition', fingerprint, result.value)
    }
    return result
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
    const found = this.getTask(projectId, taskId)
    if (!found.ok) return found
    return { ok: true, value: [...(this.events.get(taskId) ?? [])] }
  }

  private createTaskTx(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome> {
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
      const found = this.tasks.get(command.supersedesTaskId)
      const invalid = validateSupersedeTarget(
        command.projectId,
        command.taskId,
        command.supersedesTaskId,
        found ? copyTask(found) : undefined,
      )
      if (invalid) return { ok: false, error: invalid }
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
      ...(command.supersedesTaskId === undefined ? {} : { supersedesTaskId: command.supersedesTaskId }),
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

    const value = superseded
      ? { task: copyTask(task), superseded, replayed: false }
      : { task: copyTask(task), replayed: false }
    return { ok: true, value }
  }

  private transitionTx(command: TransitionCommand): LedgerResult<TransitionOutcome> {
    const task = this.tasks.get(command.taskId)
    if (!task) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${command.taskId}`,
        projectId: command.projectId,
        taskId: command.taskId,
      })
    }

    const invalid = validateTransition(copyTask(task), command, this.supervisorResolver)
    if (invalid) return { ok: false, error: invalid }

    const at = this.now()
    const fromStatus = task.status
    const effects = transitionEffects(copyTask(task), command.to, at)
    task.status = effects.status
    task.attempt = effects.attempt
    if (effects.acceptedAt !== undefined) task.acceptedAt = effects.acceptedAt
    if (effects.startedAt !== undefined) task.startedAt = effects.startedAt
    if (effects.deliveredAt !== undefined) task.deliveredAt = effects.deliveredAt
    if (effects.reviewStartedAt !== undefined) task.reviewStartedAt = effects.reviewStartedAt
    if (effects.closedAt !== undefined) task.closedAt = effects.closedAt
    task.version += 1
    task.updatedAt = at

    const event = this.pushEvent({
      projectId: command.projectId,
      taskId: command.taskId,
      fromStatus,
      toStatus: command.to,
      actorSessionId: actorSessionId(command.actor),
      ...(command.reason === undefined ? {} : { reason: command.reason }),
      idempotencyKey: command.idempotencyKey,
      at,
    })

    return { ok: true, value: { task: copyTask(task), event, replayed: false } }
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

  private idempotencyConflict(projectId: ProjectId, key: IdempotencyKey): Omit<LedgerError, 'retryable'> {
    return {
      code: 'IDEMPOTENCY_CONFLICT',
      message: `幂等键已被不同请求占用：${key}`,
      projectId,
    }
  }

  private lookupIdempotent(
    projectId: ProjectId,
    key: IdempotencyKey,
    kind: 'create' | 'transition',
    fingerprint: string,
  ): { status: 'miss' } | { status: 'conflict' } | { status: 'hit'; value: CreateTaskOutcome | TransitionOutcome } {
    const stored = this.idempotency.get(this.idemKey(projectId, key))
    if (!stored) return { status: 'miss' }
    if (stored.kind !== kind || stored.fingerprint !== fingerprint) return { status: 'conflict' }
    return { status: 'hit', value: stored.value }
  }

  private storeIdempotent(
    projectId: ProjectId,
    key: IdempotencyKey,
    kind: 'create' | 'transition',
    fingerprint: string,
    value: CreateTaskOutcome | TransitionOutcome,
  ): void {
    this.idempotency.set(this.idemKey(projectId, key), { kind, fingerprint, value })
  }

  private idemKey(projectId: ProjectId, key: IdempotencyKey): string {
    return `${projectId}\u0000${key}`
  }
}

/**
 * SQLite 台账实现（Node 内置 `node:sqlite`，无 npm 依赖、无原生编译）。
 *
 * 设计对齐 B5 原型（WAL、busy_timeout=15000、幂等 ON CONFLICT、version 乐观锁）：
 * - `withTransaction` 用 BEGIN IMMEDIATE，写事务串行化；busy 错误有界重试；
 * - 建任务 + 审计事件 + 取代更新同一事务；
 * - 迁移校验复用 `validation.ts`，状态机规则仍以 `rules.ts` 为准；
 * - 幂等键 `PRIMARY KEY(project_id, idempotency_key)`，顺序/并发重复返回首次结果。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
import { initSchema } from './sqlite-schema.ts'
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

export interface SqliteLedgerOptions extends LedgerDeps {
  readonly databasePath: string
  readonly busyTimeoutMs?: number
}

type Row = Record<string, unknown>

const DEFAULT_NOW = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp
const DEFAULT_NEW_ID = (): string => crypto.randomUUID()
const BUSY_RETRIES = 40
const BUSY_SLEEP_MS = 25

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function numberValue(value: unknown): number {
  return Number(value ?? 0)
}

function fail(error: Omit<LedgerError, 'retryable'>): LedgerResult<never> {
  return { ok: false, error: makeError(error) }
}

function isBusy(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error)
  return /busy|locked/i.test(message)
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function taskFromRow(row: Row): TaskRecord {
  return {
    taskId: text(row.task_id) as TaskId,
    projectId: text(row.project_id) as ProjectId,
    seq: numberValue(row.seq),
    title: text(row.title),
    body: text(row.body),
    status: text(row.status) as TaskStatus,
    dispatcherSessionId: text(row.dispatcher_session_id) as SessionId,
    assigneeSessionId: text(row.assignee_session_id) as SessionId,
    attempt: numberValue(row.attempt),
    ...(row.supersedes_task_id == null ? {} : { supersedesTaskId: text(row.supersedes_task_id) as TaskId }),
    ...(row.superseded_by_task_id == null
      ? {}
      : { supersededByTaskId: text(row.superseded_by_task_id) as TaskId }),
    version: numberValue(row.version),
    createdAt: text(row.created_at) as IsoTimestamp,
    updatedAt: text(row.updated_at) as IsoTimestamp,
    ...(row.accepted_at == null ? {} : { acceptedAt: text(row.accepted_at) as IsoTimestamp }),
    ...(row.started_at == null ? {} : { startedAt: text(row.started_at) as IsoTimestamp }),
    ...(row.delivered_at == null ? {} : { deliveredAt: text(row.delivered_at) as IsoTimestamp }),
    ...(row.review_started_at == null
      ? {}
      : { reviewStartedAt: text(row.review_started_at) as IsoTimestamp }),
    ...(row.closed_at == null ? {} : { closedAt: text(row.closed_at) as IsoTimestamp }),
  }
}

function eventFromRow(row: Row): TaskEvent {
  return {
    eventId: text(row.event_id) as EventId,
    projectId: text(row.project_id) as ProjectId,
    taskId: text(row.task_id) as TaskId,
    ...(row.from_status == null ? {} : { fromStatus: text(row.from_status) as TaskStatus }),
    toStatus: text(row.to_status) as TaskStatus,
    actorSessionId: text(row.actor_session_id) as SessionId | 'system',
    ...(row.reason == null ? {} : { reason: text(row.reason) }),
    idempotencyKey: text(row.idempotency_key) as IdempotencyKey,
    at: text(row.at) as IsoTimestamp,
  }
}

export class SqliteLedgerCore {
  readonly db: DatabaseSync
  readonly now: () => IsoTimestamp
  readonly newId: () => string
  private txDepth = 0
  readonly tx: LedgerTransaction

  constructor(options: SqliteLedgerOptions) {
    if (options.databasePath !== ':memory:') {
      mkdirSync(dirname(options.databasePath), { recursive: true })
    }
    this.db = new DatabaseSync(options.databasePath)
    this.db.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 15000)}`)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    initSchema(this.db)
    this.now = options.now ?? DEFAULT_NOW
    this.newId = options.newId ?? DEFAULT_NEW_ID
    this.tx = {
      createTask: (command) => this.createTaskTx(command),
      transition: (command) => this.transitionTx(command),
      getTask: (projectId, taskId) => this.getTask(projectId, taskId),
      listTasks: (projectId) => this.listTasks(projectId),
      listEvents: (projectId, taskId) => this.listEvents(projectId, taskId),
    }
  }

  withTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1
      try {
        return fn()
      } finally {
        this.txDepth -= 1
      }
    }
    this.beginImmediate()
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务可能已因 SQLite 错误自动回滚；保留原始错误。
      }
      throw error
    } finally {
      this.txDepth = 0
    }
  }

  close(): void {
    this.db.close()
  }

  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as Row | undefined
    return row ? text(row.integrity_check) : 'unknown'
  }

  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as Row | undefined
    return row ? text(row.journal_mode) : 'unknown'
  }

  schemaVersion(): string {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get() as
      | Row
      | undefined
    return row ? text(row.value) : '0'
  }

  private beginImmediate(): void {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE')
        return
      } catch (error) {
        if (!isBusy(error) || attempt >= BUSY_RETRIES) throw error
        sleep(BUSY_SLEEP_MS)
      }
    }
  }

  private createTaskTx(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome> {
    const duplicate = this.db.prepare('SELECT 1 AS x FROM tasks WHERE task_id = ?').get(command.taskId)
    if (duplicate) {
      return fail({
        code: 'INTERNAL_ERROR',
        message: `taskId 已存在：${command.taskId}`,
        projectId: command.projectId,
        taskId: command.taskId,
      })
    }

    let oldTask: TaskRecord | undefined
    if (command.supersedesTaskId !== undefined) {
      const oldRow = this.db
        .prepare('SELECT * FROM tasks WHERE task_id = ?')
        .get(command.supersedesTaskId) as Row | undefined
      oldTask = oldRow ? taskFromRow(oldRow) : undefined
      const invalid = validateSupersedeTarget(
        command.projectId,
        command.taskId,
        command.supersedesTaskId,
        oldTask,
      )
      if (invalid) return { ok: false, error: invalid }
    }

    const at = this.now()
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks WHERE project_id = ?')
      .get(command.projectId) as Row
    const seq = numberValue(seqRow.next)

    if (oldTask) {
      const updated = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'cancelled', superseded_by_task_id = ?, version = version + 1,
               updated_at = ?, closed_at = ?
           WHERE task_id = ? AND project_id = ? AND version = ?
             AND status NOT IN ('verified', 'failed', 'cancelled')`,
        )
        .run(command.taskId, at, at, oldTask.taskId, command.projectId, oldTask.version)
      if (Number(updated.changes) === 0) {
        return fail({
          code: 'INVALID_TRANSITION',
          message: '取代失败：旧任务版本冲突或已进入终态',
          projectId: command.projectId,
          taskId: oldTask.taskId,
          from: oldTask.status,
          to: 'cancelled',
        })
      }
    }

    this.db
      .prepare(
        `INSERT INTO tasks (
           task_id, project_id, seq, title, body, body_bytes, body_sha256, status,
           dispatcher_session_id, assignee_session_id, attempt, supersedes_task_id,
           superseded_by_task_id, created_at, dispatched_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, 0, ?, NULL, ?, ?, ?, 1)`,
      )
      .run(
        command.taskId,
        command.projectId,
        seq,
        command.title,
        command.body,
        Buffer.byteLength(command.body, 'utf8'),
        createHash('sha256').update(command.body, 'utf8').digest('hex'),
        command.dispatcherSessionId,
        command.assigneeSessionId,
        command.supersedesTaskId ?? null,
        at,
        at,
        at,
      )
    this.insertEvent({
      projectId: command.projectId,
      taskId: command.taskId,
      toStatus: 'dispatched',
      actorSessionId: command.dispatcherSessionId,
      idempotencyKey: command.idempotencyKey,
      at,
    })

    let superseded: TaskRecord | undefined
    if (oldTask) {
      this.insertEvent({
        projectId: command.projectId,
        taskId: oldTask.taskId,
        fromStatus: oldTask.status,
        toStatus: 'cancelled',
        actorSessionId: command.dispatcherSessionId,
        reason: 'superseded',
        idempotencyKey: command.idempotencyKey,
        at,
      })
      superseded = {
        ...oldTask,
        status: 'cancelled',
        supersededByTaskId: command.taskId,
        version: oldTask.version + 1,
        updatedAt: at,
        closedAt: at,
      }
    }

    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(command.taskId) as Row
    const task = taskFromRow(row)
    return {
      ok: true,
      value: superseded ? { task, superseded, replayed: false } : { task, replayed: false },
    }
  }

  private transitionTx(command: TransitionCommand): LedgerResult<TransitionOutcome> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(command.taskId) as
      | Row
      | undefined
    if (!row) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${command.taskId}`,
        projectId: command.projectId,
        taskId: command.taskId,
      })
    }
    const task = taskFromRow(row)
    const invalid = validateTransition(task, command)
    if (invalid) return { ok: false, error: invalid }

    const at = this.now()
    const effects = transitionEffects(task, command.to, at)
    const updated = this.db
      .prepare(
        `UPDATE tasks SET
           status = ?, attempt = ?,
           accepted_at = COALESCE(?, accepted_at),
           started_at = COALESCE(?, started_at),
           delivered_at = COALESCE(?, delivered_at),
           review_started_at = COALESCE(?, review_started_at),
           closed_at = COALESCE(?, closed_at),
           version = version + 1, updated_at = ?
         WHERE task_id = ? AND project_id = ? AND version = ?`,
      )
      .run(
        effects.status,
        effects.attempt,
        effects.acceptedAt ?? null,
        effects.startedAt ?? null,
        effects.deliveredAt ?? null,
        effects.reviewStartedAt ?? null,
        effects.closedAt ?? null,
        at,
        command.taskId,
        command.projectId,
        task.version,
      )
    if (Number(updated.changes) === 0) {
      return fail({
        code: 'INVALID_TRANSITION',
        message: '乐观锁冲突：任务已被并发修改',
        projectId: command.projectId,
        taskId: command.taskId,
        from: task.status,
        to: command.to,
      })
    }

    const event = this.insertEvent({
      projectId: command.projectId,
      taskId: command.taskId,
      fromStatus: task.status,
      toStatus: command.to,
      actorSessionId: actorSession(command.actor),
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      at,
    })

    const updatedRow = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(command.taskId) as Row
    return { ok: true, value: { task: taskFromRow(updatedRow), event, replayed: false } }
  }

  private getTask(projectId: ProjectId, taskId: TaskId): LedgerResult<TaskRecord> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Row | undefined
    if (!row) {
      return fail({
        code: 'TASK_NOT_FOUND',
        message: `任务不存在：${taskId}`,
        projectId,
        taskId,
      })
    }
    if (text(row.project_id) !== projectId) {
      return fail({
        code: 'CROSS_PROJECT_DENIED',
        message: '任务属于其他项目',
        projectId,
      })
    }
    return { ok: true, value: taskFromRow(row) }
  }

  private listTasks(projectId: ProjectId): readonly TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY seq ASC')
      .all(projectId) as Row[]
    return rows.map(taskFromRow)
  }

  private listEvents(projectId: ProjectId, taskId: TaskId): LedgerResult<readonly TaskEvent[]> {
    const found = this.getTask(projectId, taskId)
    if (!found.ok) return found
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY rowid ASC')
      .all(taskId) as Row[]
    return { ok: true, value: rows.map(eventFromRow) }
  }

  private insertEvent(input: {
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
    this.db
      .prepare(
        `INSERT INTO task_events (
           event_id, project_id, task_id, from_status, to_status,
           actor_session_id, reason, message_id, idempotency_key, at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        event.eventId,
        event.projectId,
        event.taskId,
        event.fromStatus ?? null,
        event.toStatus,
        event.actorSessionId,
        event.reason ?? null,
        event.idempotencyKey,
        event.at,
      )
    return event
  }
}

function actorSession(actor: TransitionCommand['actor']): SessionId | 'system' {
  return actor.kind === 'system' ? 'system' : actor.sessionId
}

/** 对外台账实现：每次公开调用自带事务与台账级幂等。 */
export class SqliteTaskLedger implements TaskLedgerPort {
  readonly core: SqliteLedgerCore
  private readonly ownsCore: boolean

  constructor(options: SqliteLedgerOptions | { core: SqliteLedgerCore }) {
    if ('core' in options) {
      this.core = options.core
      this.ownsCore = false
    } else {
      this.core = new SqliteLedgerCore(options)
      this.ownsCore = true
    }
  }

  createTask(command: CreateTaskCommand): LedgerResult<CreateTaskOutcome> {
    const fingerprint = createTaskFingerprint(command)
    return this.core.withTransaction(() => {
      const existing = this.readIdempotent(command.projectId, command.idempotencyKey)
      if (existing) {
        if (existing.operation !== 'create' || existing.fingerprint !== fingerprint) {
          return this.idempotencyConflict(command.projectId, command.idempotencyKey)
        }
        const value = JSON.parse(text(existing.ledger_result_json)) as CreateTaskOutcome
        return { ok: true, value: { ...value, replayed: true } }
      }
      const result = this.core.tx.createTask(command)
      if (result.ok) {
        this.writeIdempotent(command.projectId, command.idempotencyKey, 'create', fingerprint, result.value, null)
      }
      return result
    })
  }

  transition(command: TransitionCommand): LedgerResult<TransitionOutcome> {
    const fingerprint = transitionFingerprint(command)
    return this.core.withTransaction(() => {
      const existing = this.readIdempotent(command.projectId, command.idempotencyKey)
      if (existing) {
        if (existing.operation !== 'transition' || existing.fingerprint !== fingerprint) {
          return this.idempotencyConflict(command.projectId, command.idempotencyKey)
        }
        const value = JSON.parse(text(existing.ledger_result_json)) as TransitionOutcome
        return { ok: true, value: { ...value, replayed: true } }
      }
      const result = this.core.tx.transition(command)
      if (result.ok) {
        this.writeIdempotent(
          command.projectId,
          command.idempotencyKey,
          'transition',
          fingerprint,
          result.value,
          null,
        )
      }
      return result
    })
  }

  getTask(projectId: ProjectId, taskId: TaskId): LedgerResult<TaskRecord> {
    return this.core.tx.getTask(projectId, taskId)
  }

  listTasks(projectId: ProjectId): readonly TaskRecord[] {
    return this.core.tx.listTasks(projectId)
  }

  listEvents(projectId: ProjectId, taskId: TaskId): LedgerResult<readonly TaskEvent[]> {
    return this.core.tx.listEvents(projectId, taskId)
  }

  close(): void {
    if (this.ownsCore) this.core.close()
  }

  integrityCheck(): string {
    return this.core.integrityCheck()
  }

  journalMode(): string {
    return this.core.journalMode()
  }

  schemaVersion(): number {
    return Number(this.core.schemaVersion())
  }

  /** 供派活/汇报在同一连接、同一事务内组合消息与幂等回执。 */
  withTransaction<T>(fn: () => T): T {
    return this.core.withTransaction(fn)
  }

  get tx(): LedgerTransaction {
    return this.core.tx
  }

  private readIdempotent(projectId: ProjectId, key: IdempotencyKey): Row | undefined {
    return this.core.db
      .prepare('SELECT * FROM idempotency WHERE project_id = ? AND idempotency_key = ?')
      .get(projectId, key) as Row | undefined
  }

  private writeIdempotent(
    projectId: ProjectId,
    key: IdempotencyKey,
    operation: string,
    fingerprint: string,
    ledgerResult: unknown,
    receipt: unknown,
  ): void {
    this.core.db
      .prepare(
        `INSERT INTO idempotency (
           project_id, idempotency_key, operation, fingerprint,
           ledger_result_json, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, idempotency_key) DO NOTHING`,
      )
      .run(
        projectId,
        key,
        operation,
        fingerprint,
        ledgerResult === null ? null : JSON.stringify(ledgerResult),
        receipt === null ? null : JSON.stringify(receipt),
        this.core.now(),
      )
  }

  private idempotencyConflict(projectId: ProjectId, key: IdempotencyKey): LedgerResult<never> {
    return fail({
      code: 'IDEMPOTENCY_CONFLICT',
      message: `幂等键已被不同请求占用：${key}`,
      projectId,
    })
  }
}


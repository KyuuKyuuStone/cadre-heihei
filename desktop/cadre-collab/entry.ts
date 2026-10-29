/**
 * B③ write-path library entry.
 *
 * Bundled by `scripts/build-cadre-collab.mjs` into
 * `apps/desktop/lib/cadre-collab.cjs` and required from the desktop main
 * process. All state-machine, permission, idempotency and validation logic
 * comes from the desktop-owned snapshot in `cadre-collab/collab/**`; this file
 * only binds an actor identity and forwards calls to `DispatchService` /
 * `SqliteTaskLedger.transition`.
 */

import { DispatchService } from './collab/dispatch/dispatch-service.ts'
import { SqliteCollabStore } from './collab/dispatch/sqlite-dispatch.ts'

export interface CadreCollabOptions {
  readonly databasePath: string
  readonly projectId: string
  readonly sessionId: string
  readonly busyTimeoutMs?: number
}

export interface CadreDispatchInput {
  readonly to: string
  readonly title: string
  readonly body: string
  readonly idempotencyKey?: string
  readonly supersedesTaskId?: string
}

export interface CadreTransitionInput {
  readonly taskId: string
  /** Optional: when omitted the current status is read from the same write connection. */
  readonly from?: string
  readonly to: string
  readonly reason?: string
  readonly idempotencyKey?: string
}

export interface CadreCollab {
  readonly databasePath: string
  dispatch(input: CadreDispatchInput): unknown
  transition(input: CadreTransitionInput): unknown
  /** Post-commit snapshot from the write connection (WAL sees its own commit). */
  listTasks(): { projectId: string; rows: readonly unknown[] }
  close(): void
}

/**
 * Create the ledger schema without binding a project or seeding a roster.
 *
 * The desktop main process needs the tables before the first project is known
 * (its read-only connection and the employee roster open at startup). Opening
 * a real project store here would bind an actor to a project that may not
 * exist, so this only runs the forward-only migration.
 * @param databasePath - absolute path to `cadre.sqlite`.
 */
export function initCadreStore(databasePath: string): void {
  const store = new SqliteCollabStore({ databasePath })
  store.close()
}

/** Open the SQLite collaboration store with a fixed caller identity. */
export function openCadreCollab(options: CadreCollabOptions): CadreCollab {
  const store = new SqliteCollabStore({
    databasePath: options.databasePath,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  })
  console.log(`cadre-ledger roster project=${options.projectId} size=${store.listMembers(options.projectId as never).length}`)
  const service = new DispatchService(store)
  const binding = { projectId: options.projectId as never, sessionId: options.sessionId as never }
  /**
   * Actor kind from the roster, never from the caller or the process.
   *
   * The write path is the only place that names an actor kind, so an
   * environment variable (the old `CADRE_ROLE` fallback) or a renderer-supplied
   * role cannot grant supervisor rights: a roster `worker` maps to the
   * ledger's `assignee`, and the ledger still verifies that the session really
   * is the task's assignee or the project's supervisor (`validation.ts` +
   * `SqliteSupervisorResolver`). A session without a roster row gets no actor
   * kind at all.
   */
  const actorRole = (): 'supervisor' | 'assignee' | undefined => {
    // `sup-1` is the legacy placeholder row without a Session; it must never
    // act, or any caller naming that id could borrow supervisor rights.
    if (options.sessionId === 'sup-1') return undefined
    const member = store.listMembers(options.projectId as never)
      .find(row => row.sessionId === options.sessionId && (row.state as string) !== 'departed')
    if (member === undefined) return undefined
    return member.role === 'supervisor' ? 'supervisor' : 'assignee'
  }
  return {
    databasePath: options.databasePath,
    dispatch(input) {
      // Never enrol the target here: a hallucinated session id would become a
      // real "ghost employee" before the service can reject it. An unknown
      // target must fail as target-not-member on both tool and IPC paths.
      return service.dispatch(binding, {
        projectId: options.projectId as never,
        toSessionId: input.to as never,
        title: input.title,
        body: input.body,
        idempotencyKey: (input.idempotencyKey ?? crypto.randomUUID()) as never,
        ...(input.supersedesTaskId === undefined
          ? {}
          : { supersedesTaskId: input.supersedesTaskId as never }),
      })
    },
    transition(input) {
      // The panel sends only the target status; resolve the start status from
      // the same write connection so the ledger still validates it strictly.
      let from = input.from
      if (from === undefined) {
        const current = store.ledger.getTask(options.projectId as never, input.taskId as never)
        if (!current.ok) return current
        from = current.value.status
      }
      const role = actorRole()
      if (role === undefined) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN_ACTOR',
            message: '调用会话不在本项目花名册（或已离职），无法执行验收迁移',
            retryable: false,
            projectId: options.projectId,
            actorSessionId: options.sessionId,
            reasonCategory: 'not-member',
          },
        }
      }
      const actor = { kind: 'session' as const, sessionId: options.sessionId, role }
      // One-step accept: the panel's "通过验收" on a delivered task runs the
      // mandatory delivered→review→verified chain as two real ledger
      // transitions (two events). Each step still passes validation.ts and the
      // SQLite trigger; non-delivered starts keep the old single-step path.
      if (input.to === 'verified' && from === 'delivered') {
        const review = store.ledger.transition({
          projectId: options.projectId as never,
          taskId: input.taskId as never,
          from: 'delivered',
          to: 'review',
          actor: actor as never,
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:review` as never,
        })
        if (!review.ok) return review
        console.log(`cadre-ledger one-step review project=${options.projectId} task=${input.taskId}`)
        return store.ledger.transition({
          projectId: options.projectId as never,
          taskId: input.taskId as never,
          from: 'review',
          to: 'verified',
          actor: actor as never,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:verified` as never,
        })
      }
      // `SqliteTaskLedger.transition` applies `validation.ts`: start-status
      // match, legal rule, reason requirement, and actor permission via the
      // project roster (`SqliteSupervisorResolver`).
      return store.ledger.transition({
        projectId: options.projectId as never,
        taskId: input.taskId as never,
        from: from as never,
        to: input.to as never,
        actor: actor as never,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey: (input.idempotencyKey ?? crypto.randomUUID()) as never,
      })
    },
    listTasks() {
      // Newest first, same projection as the read-only IPC channel.
      const rows = [...store.ledger.listTasks(options.projectId as never)].reverse().map(task => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        assigneeSessionId: task.assigneeSessionId,
        updatedAt: task.updatedAt,
      }))
      return { projectId: options.projectId, rows }
    },
    close() {
      store.close()
    },
  }
}

/** One open task handed back to the supervisor when its assignee departs. */
export interface CadreReturnOpenTasksInput {
  readonly databasePath: string
  readonly projectId: string
  /** Departing member whose tasks are released. */
  readonly fromSessionId: string
  /** Active supervisor receiving the tasks; resolved from the roster. */
  readonly actorSessionId: string
  readonly taskIds: readonly string[]
  readonly reason?: string
}

/** Result of {@link returnOpenTasksToSupervisor}. */
export type CadreReturnOpenTasksResult =
  | { readonly ok: true; readonly returned: number; readonly replayed: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly taskId?: string }

/** Statuses a departed assignee's task may be released from. */
const RETIRABLE_STATUSES = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'review',
  'rework',
] as const

class ReturnTaskError extends Error {
  readonly code: string
  readonly taskId: string | undefined

  constructor(code: string, message: string, taskId?: string) {
    super(message)
    this.code = code
    this.taskId = taskId
  }
}

/**
 * Hand a departing assignee's open tasks back to an active supervisor (DF-006
 * `taskDisposition: 'return'`).
 *
 * The status does not change, so this is not a state-machine transition: the
 * row keeps its status and the reassignment is recorded as a `task_events` row
 * with `from_status = to_status` and reason `assignee-retired`. The event's
 * `idempotency_key` (`retire-return:<taskId>`) makes a retry a no-op. The actor
 * is re-validated against the roster; the caller cannot self-assign tasks to a
 * session that is about to depart.
 * @param input - database path, project, departing/acting sessions and task ids.
 * @returns how many tasks moved, or a fail-closed error naming the task.
 */
export function returnOpenTasksToSupervisor(input: CadreReturnOpenTasksInput): CadreReturnOpenTasksResult {
  const store = new SqliteCollabStore({ databasePath: input.databasePath })
  try {
    const members = store.listMembers(input.projectId as never)
    const actor = members.find(member => member.sessionId === input.actorSessionId && (member.state as string) !== 'departed')
    if (actor === undefined || actor.role !== 'supervisor') {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '退回任务必须由本项目在册 supervisor 执行' }
    }
    if (input.actorSessionId === input.fromSessionId) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '不能把任务退回到即将离职的会话' }
    }
    const db = store.ledger.core.db
    let returned = 0
    let replayed = 0
    try {
      store.ledger.withTransaction(() => {
        const now = new Date().toISOString()
        for (const taskId of input.taskIds) {
          const row = db.prepare(
            'SELECT status, assignee_session_id FROM tasks WHERE project_id = ? AND task_id = ?',
          ).get(input.projectId, taskId) as { status?: unknown; assignee_session_id?: unknown } | undefined
          if (row === undefined) throw new ReturnTaskError('TASK_NOT_FOUND', `任务不存在：${taskId}`, taskId)
          const idempotencyKey = `retire-return:${taskId}`
          const seen = db.prepare(
            'SELECT 1 AS x FROM task_events WHERE project_id = ? AND idempotency_key = ?',
          ).get(input.projectId, idempotencyKey)
          if (seen !== undefined) {
            replayed += 1
            continue
          }
          const status = String(row.status)
          if (!(RETIRABLE_STATUSES as readonly string[]).includes(status)) {
            throw new ReturnTaskError('INVALID_TRANSITION', `任务 ${taskId} 的状态 ${status} 不能退回`, taskId)
          }
          if (String(row.assignee_session_id) !== input.fromSessionId) {
            throw new ReturnTaskError('INVALID_TRANSITION', `任务 ${taskId} 不属于 ${input.fromSessionId}`, taskId)
          }
          db.prepare(`UPDATE tasks
            SET assignee_session_id = ?, updated_at = ?, version = version + 1
            WHERE project_id = ? AND task_id = ?`).run(input.actorSessionId, now, input.projectId, taskId)
          db.prepare(`INSERT INTO task_events (event_id, project_id, task_id, from_status, to_status,
            actor_session_id, reason, idempotency_key, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            crypto.randomUUID(), input.projectId, taskId, status, status,
            input.actorSessionId, input.reason ?? 'assignee-retired', idempotencyKey, now,
          )
          returned += 1
        }
      })
    } catch (error) {
      if (error instanceof ReturnTaskError) {
        return { ok: false, code: error.code, message: error.message, ...(error.taskId === undefined ? {} : { taskId: error.taskId }) }
      }
      throw error
    }
    return { ok: true, returned, replayed }
  } catch (error) {
    return { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
  } finally {
    store.close()
  }
}

/** One stalled task handed to an in-roster worker (DF-014 reassign). */
export interface CadreReassignTaskInput {
  readonly databasePath: string
  readonly projectId: string
  readonly taskId: string
  readonly actorSessionId: string
  readonly toSessionId: string
  readonly reason: string
  readonly idempotencyKey: string
}

/** Result of {@link reassignOpenTask}. */
export type CadreReassignTaskResult =
  | { readonly ok: true; readonly version: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Move one open task to another in-roster worker without changing its status.
 *
 * This is an audited reassignment (one `task_events` row, `from_status` =
 * `to_status` = current status), not a state-machine transition: the status
 * stays, only the assignee changes, and the next dispatch loop starts from the
 * same state. The supervisor actor and target worker are re-validated here.
 * @param input - ledger path, task, acting supervisor, target worker, reason and replay key.
 * @returns the new task version, or a fail-closed error.
 */
export function reassignOpenTask(input: CadreReassignTaskInput): CadreReassignTaskResult {
  if (input.reason.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '重派必须填写原因' }
  }
  if (input.idempotencyKey.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'idempotencyKey 不能为空' }
  }
  const store = new SqliteCollabStore({ databasePath: input.databasePath })
  try {
    const members = store.listMembers(input.projectId as never)
    const actor = members.find(member => member.sessionId === input.actorSessionId && (member.state as string) !== 'departed')
    if (actor === undefined || actor.role !== 'supervisor') {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '重派必须由本项目在册 supervisor 执行' }
    }
    const target = members.find(member => member.sessionId === input.toSessionId && (member.state as string) !== 'departed')
    if (target === undefined || target.role !== 'worker') {
      return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: '目标必须是本项目在职员工' }
    }
    if (target.sessionId === actor.sessionId) {
      return { ok: false, code: 'REASSIGN_TARGET_INVALID', message: '不能重派给执行人自己' }
    }
    const db = store.ledger.core.db
    const key = `stall-reassign:${input.taskId}:${input.idempotencyKey}`
    let version = 0
    let replayed = false
    try {
      store.ledger.withTransaction(() => {
        const row = db.prepare(
          'SELECT status, assignee_session_id, version FROM tasks WHERE project_id = ? AND task_id = ?',
        ).get(input.projectId, input.taskId) as
          { status?: unknown; assignee_session_id?: unknown; version?: unknown } | undefined
        if (row === undefined) throw new ReturnTaskError('TASK_NOT_FOUND', `任务不存在：${input.taskId}`)
        const seen = db.prepare(
          'SELECT 1 AS x FROM task_events WHERE project_id = ? AND idempotency_key = ?',
        ).get(input.projectId, key)
        if (seen !== undefined) {
          replayed = true
          version = Number(row.version ?? 0)
          return
        }
        const status = String(row.status)
        if (!(RETIRABLE_STATUSES as readonly string[]).includes(status)) {
          throw new ReturnTaskError('INVALID_TRANSITION', `任务 ${input.taskId} 的状态 ${status} 不能重派`)
        }
        if (String(row.assignee_session_id) === input.toSessionId) {
          throw new ReturnTaskError('REASSIGN_TARGET_INVALID', '任务已在目标员工名下')
        }
        const now = new Date().toISOString()
        db.prepare(`UPDATE tasks
          SET assignee_session_id = ?, updated_at = ?, version = version + 1
          WHERE project_id = ? AND task_id = ?`).run(input.toSessionId, now, input.projectId, input.taskId)
        db.prepare(`INSERT INTO task_events (event_id, project_id, task_id, from_status, to_status,
          actor_session_id, reason, idempotency_key, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          crypto.randomUUID(), input.projectId, input.taskId, status, status,
          input.actorSessionId, `stalled-reassign: ${input.reason.trim()}`, key, now,
        )
        version = Number(row.version ?? 0) + 1
      })
    } catch (error) {
      if (error instanceof ReturnTaskError) return { ok: false, code: error.code, message: error.message }
      throw error
    }
    return { ok: true, version, replayed }
  } catch (error) {
    return { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
  } finally {
    store.close()
  }
}

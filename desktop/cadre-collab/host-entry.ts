/**
 * Host-side bridge to the one state machine.
 *
 * The Host plugin (`@deepseek-ai/dsh-host-collab`) writes messages itself, but
 * it must not hand-roll status transitions: the desktop-owned snapshot in
 * `cadre-collab/collab/**` owns the matrix, the reason rule, the actor
 * permission check and the audit event
 * (including `from_status`). This entry bundles that code into a CJS file the
 * Host plugin requires, so an employee report becomes real ledger transitions
 * instead of a bare `UPDATE tasks SET status = 'delivered'`.
 *
 * The actor kind is resolved from the project roster here, never from the
 * caller: the Host tool already proved the reporter is the task's assignee,
 * and the ledger re-validates each step through `validation.ts`.
 */

import { SqliteCollabStore } from './collab/dispatch/sqlite-dispatch.ts'

export interface AdvanceReportInput {
  readonly databasePath: string
  readonly projectId: string
  readonly taskId: string
  readonly actorSessionId: string
  /** Prefix for per-step idempotency keys recorded in `task_events`. */
  readonly idempotencyBase: string
}

export type AdvanceReportResult =
  | {
    readonly ok: true
    /** Status the report started from (`delivered` when it was a replay). */
    readonly from: string
    readonly to: 'delivered'
    readonly replayed: boolean
    readonly eventIds: readonly string[]
  }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Steps from one status to `delivered`, or undefined when the task cannot be
 * reported from it.
 *
 * The tools expose no accept/start call, so a report from `dispatched` walks
 * the same path a human would: accepted → in_progress → delivered. Each hop is
 * one validated transition with its own `task_events` row.
 */
function chainToDelivered(from: string): readonly string[] | undefined {
  switch (from) {
    case 'dispatched': return ['accepted', 'in_progress', 'delivered']
    case 'accepted': return ['in_progress', 'delivered']
    case 'in_progress': return ['delivered']
    case 'rework': return ['in_progress', 'delivered']
    default: return undefined
  }
}

/**
 * Advance one reported task to `delivered` through `SqliteTaskLedger.transition`.
 * @param input - ledger path, project/task ids and the reporting Session.
 * @returns the recorded transitions, or a fail-closed error.
 */
export function advanceReportToDelivered(input: AdvanceReportInput): AdvanceReportResult {
  const store = new SqliteCollabStore({ databasePath: input.databasePath })
  try {
    // `sup-1` is the legacy placeholder row without a Session; never an actor.
    const membership = input.actorSessionId === 'sup-1'
      ? undefined
      : store.listMembers(input.projectId as never)
        .find(row => row.sessionId === input.actorSessionId && (row.state as string) !== 'departed')
    if (membership === undefined) {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '汇报会话不在本项目花名册（或已离职）' }
    }
    const role = membership.role === 'supervisor' ? 'supervisor' : 'assignee'
    const current = store.ledger.getTask(input.projectId as never, input.taskId as never)
    if (!current.ok) return { ok: false, code: current.error.code, message: current.error.message }
    const startedFrom = current.value.status
    // A retried report (the first attempt committed the transition but its
    // supervisor notification failed) must not fail: there is nothing left to
    // transition and the caller only needs to deliver the message again.
    if (startedFrom === 'delivered') {
      return { ok: true, from: startedFrom, to: 'delivered', replayed: true, eventIds: [] }
    }
    const chain = chainToDelivered(startedFrom)
    if (chain === undefined) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        message: `任务当前状态为 ${startedFrom}，不能汇报为 delivered`,
      }
    }
    // Each rework round is a new reporting cycle. The latest rework event is a
    // stable cycle id: retries of the same round reuse it (replay), while a
    // later rework records a new event and therefore new keys.
    const cycleId = ((): string => {
      if (startedFrom !== 'rework') return startedFrom
      const row = store.ledger.core.db.prepare(`SELECT event_id FROM task_events
        WHERE project_id = ? AND task_id = ? AND to_status = 'rework'
        ORDER BY at DESC, rowid DESC LIMIT 1`).get(input.projectId, input.taskId) as
        { event_id?: unknown } | undefined
      return typeof row?.event_id === 'string' && row.event_id !== '' ? row.event_id : startedFrom
    })()
    const eventIds: string[] = []
    let from: string = startedFrom
    for (const to of chain) {
      const step = store.ledger.transition({
        projectId: input.projectId as never,
        taskId: input.taskId as never,
        from: from as never,
        to: to as never,
        actor: { kind: 'session', sessionId: input.actorSessionId as never, role },
        // Scope keys to the reporting cycle: reports after `rework` must not
        // replay keys recorded by the earlier delivery cycle.
        idempotencyKey: `${input.idempotencyBase}:${cycleId}:${to}` as never,
      })
      if (!step.ok) {
        return { ok: false, code: step.error.code, message: `${from} → ${to}：${step.error.message}` }
      }
      from = to
      eventIds.push(step.value.event.eventId)
    }
    return { ok: true, from: startedFrom, to: 'delivered', replayed: false, eventIds }
  } finally {
    store.close()
  }
}

/** One task row the supervisor list needs; `due_at` is read opportunistically. */
export interface HostTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly dispatcherSessionId: string
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly dueAt?: string
  readonly supersedesTaskId?: string
  readonly supersededByTaskId?: string
  readonly bodyPreview: string
}

export interface ListTasksInput {
  readonly databasePath: string
  readonly projectId: string
}

export type ListTasksResult =
  | { readonly ok: true; readonly rows: readonly HostTaskRow[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

const BODY_PREVIEW_LIMIT = 160

function bodyPreview(body: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  return flat.length > BODY_PREVIEW_LIMIT ? `${flat.slice(0, BODY_PREVIEW_LIMIT)}…` : flat
}

/**
 * Read one project's task rows through the shared ledger projection.
 *
 * `due_at` was added to the Host schema after the ledger contract, so it is
 * read only when the column exists; the ledger projection above ignores
 * unknown columns and stays the source of truth for status/timestamps.
 * @param input - ledger path and project id.
 * @returns newest-first rows, or a read error.
 */
export function listTasks(input: ListTasksInput): ListTasksResult {
  let store: SqliteCollabStore | undefined
  try {
    store = new SqliteCollabStore({ databasePath: input.databasePath })
    const tasks = store.ledger.listTasks(input.projectId as never)
    const columns = store.ledger.core.db.prepare('PRAGMA table_info(tasks)').all() as { name?: unknown }[]
    const due = new Map<string, string>()
    if (columns.some(column => column.name === 'due_at')) {
      const dueRows = store.ledger.core.db
        .prepare('SELECT task_id, due_at FROM tasks WHERE project_id = ?')
        .all(input.projectId) as { task_id?: unknown; due_at?: unknown }[]
      for (const row of dueRows) {
        if (typeof row.task_id === 'string' && typeof row.due_at === 'string' && row.due_at !== '') {
          due.set(row.task_id, row.due_at)
        }
      }
    }
    const rows = [...tasks]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.seq - left.seq)
      .map((task): HostTaskRow => {
      const dueAt = due.get(task.taskId)
      return {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        assigneeSessionId: task.assigneeSessionId,
        dispatcherSessionId: task.dispatcherSessionId,
        attempt: task.attempt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(dueAt === undefined ? {} : { dueAt }),
        ...(task.supersedesTaskId === undefined ? {} : { supersedesTaskId: task.supersedesTaskId }),
        ...(task.supersededByTaskId === undefined ? {} : { supersededByTaskId: task.supersededByTaskId }),
        bodyPreview: bodyPreview(task.body),
      }
    })
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
  } finally {
    store?.close()
  }
}

export interface TransitionTaskInput {
  readonly databasePath: string
  readonly projectId: string
  readonly taskId: string
  readonly to: string
  readonly actorSessionId: string
  readonly idempotencyKey: string
  readonly reason?: string
}

export interface TransitionStep {
  readonly from: string
  readonly to: string
  readonly eventId: string
}

export type TransitionTaskResult =
  | {
    readonly ok: true
    readonly from: string
    readonly status: string
    readonly steps: readonly TransitionStep[]
    /** True when the task was already at `to`; no event was written. */
    readonly replayed: boolean
  }
  | { readonly ok: false; readonly code: string; readonly message: string }

const TERMINAL_STATUSES = ['verified', 'failed', 'cancelled'] as const

/**
 * Steps from `from` to the supervisor's target.
 *
 * `review` is mandatory: a decision taken on a delivered task first records
 * `delivered → review`, then the decision itself. Cancellation is allowed from
 * any non-terminal state and needs no review.
 */
function chainToTarget(from: string, to: string): readonly string[] | undefined {
  if (to === 'cancelled') {
    return (TERMINAL_STATUSES as readonly string[]).includes(from) ? undefined : ['cancelled']
  }
  if (to === 'review') return from === 'delivered' ? ['review'] : undefined
  if (to === 'verified' || to === 'rework' || to === 'failed') {
    if (from === 'delivered') return ['review', to]
    if (from === 'review') return [to]
    return undefined
  }
  return undefined
}

/**
 * Apply one supervisor decision through `SqliteTaskLedger.transition`.
 *
 * The roster is the authority for both the role gate and the ledger's
 * `resolveActorKind` check. Replaying the same request after success returns
 * the current state with no new events; per-step idempotency keys still guard
 * a retry after a partially completed chain.
 * @param input - ledger path, task, target and the acting Session.
 * @returns the recorded steps, a replay marker, or a fail-closed error.
 */
export function transitionTask(input: TransitionTaskInput): TransitionTaskResult {
  if (input.idempotencyKey.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'idempotencyKey 不能为空' }
  }
  let store: SqliteCollabStore | undefined
  try {
    store = new SqliteCollabStore({ databasePath: input.databasePath })
    // `sup-1` is the legacy placeholder row without a Session; never an actor.
    const membership = input.actorSessionId === 'sup-1'
      ? undefined
      : store.listMembers(input.projectId as never)
        .find(row => row.sessionId === input.actorSessionId && (row.state as string) !== 'departed')
    if (membership === undefined) {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '调用会话不在本项目花名册（或已离职）' }
    }
    if (membership.role !== 'supervisor') {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: '只有本项目 supervisor 可以改任务状态' }
    }
    // Validate before the review hop: otherwise a missing reason would leave
    // the task in `review` even though the decision itself never happened.
    if (['rework', 'failed', 'cancelled'].includes(input.to)
      && (input.reason === undefined || input.reason.trim() === '')) {
      return { ok: false, code: 'MISSING_REASON', message: `目标态 ${input.to} 的迁移必须提供非空 reason` }
    }
    const current = store.ledger.getTask(input.projectId as never, input.taskId as never)
    if (!current.ok) return { ok: false, code: current.error.code, message: current.error.message }
    const startedFrom = current.value.status
    if (startedFrom === input.to) {
      return { ok: true, from: startedFrom, status: startedFrom, steps: [], replayed: true }
    }
    const chain = chainToTarget(startedFrom, input.to)
    if (chain === undefined) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        message: `不允许从 ${startedFrom} 迁移到 ${input.to}`,
      }
    }
    const steps: TransitionStep[] = []
    let from: string = startedFrom
    for (const to of chain) {
      const step = store.ledger.transition({
        projectId: input.projectId as never,
        taskId: input.taskId as never,
        from: from as never,
        to: to as never,
        actor: { kind: 'session', sessionId: input.actorSessionId as never, role: 'supervisor' },
        ...(to === input.to && input.reason !== undefined ? { reason: input.reason } : {}),
        idempotencyKey: `${input.idempotencyKey}:${to}` as never,
      })
      if (!step.ok) {
        return { ok: false, code: step.error.code, message: `${from} → ${to}：${step.error.message}` }
      }
      steps.push({ from, to, eventId: step.value.event.eventId })
      from = to
    }
    return { ok: true, from: startedFrom, status: from, steps, replayed: false }
  } catch (error) {
    return { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
  } finally {
    store?.close()
  }
}

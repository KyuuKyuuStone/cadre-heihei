/**
 * Host-side bridge to the one state machine.
 *
 * The Host plugin (`@deepseek-ai/dsh-host-collab`) writes messages itself, but
 * it must not hand-roll status transitions: `app/src/collab/**` owns the
 * matrix, the reason rule, the actor permission check and the audit event
 * (including `from_status`). This entry bundles that code into a CJS file the
 * Host plugin requires, so an employee report becomes real ledger transitions
 * instead of a bare `UPDATE tasks SET status = 'delivered'`.
 *
 * The actor kind is resolved from the project roster here, never from the
 * caller: the Host tool already proved the reporter is the task's assignee,
 * and the ledger re-validates each step through `validation.ts`.
 */

import { SqliteCollabStore } from '../../app/src/collab/dispatch/sqlite-dispatch.ts'

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
        .find(row => row.sessionId === input.actorSessionId && row.state !== 'departed')
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
    const eventIds: string[] = []
    let from = startedFrom
    for (const to of chain) {
      const step = store.ledger.transition({
        projectId: input.projectId as never,
        taskId: input.taskId as never,
        from: from as never,
        to: to as never,
        actor: { kind: 'session', sessionId: input.actorSessionId as never, role },
        idempotencyKey: `${input.idempotencyBase}:${to}`,
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

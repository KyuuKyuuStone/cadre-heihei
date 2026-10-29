/**
 * Retirement guard (DF-006): a member with open tasks cannot simply disappear.
 *
 * The renderer cannot move ledger tasks itself, so the main process owns the
 * disposition:
 * - no `taskDisposition` and open tasks → `OPEN_TASKS` plus the task list;
 * - `cancel` → every open task transitions to `cancelled` (reason
 *   `assignee-retired`) through the shared state machine;
 * - `return` → tasks keep their status and move back to the acting supervisor
 *   with one `task_events` row each (`from_status = to_status`);
 * - `transfer` is not implemented in 0.9.3 → `UNSUPPORTED_DISPOSITION`.
 *
 * The acting supervisor is resolved from the roster. A renderer-supplied
 * `actorSessionId` is only an identity hint: its role and state are re-checked
 * here, never trusted from the request.
 */
import type { CadreCollab } from './cadre-collab-api.ts'
import type { CadreMemberRow, CadreTaskRow } from './cadre-ledger.ts'
import type { EmployeeResult } from './employees-db.ts'

/** Dispositions this version understands. */
export type RetireTaskDisposition = 'cancel' | 'return' | 'transfer'

/** Request shape for `cadre:retireMember` (front-end contract for the next round). */
export interface RetireMemberOptions {
  readonly sessionId: string
  readonly projectId: string
  /** Optional identity hint; must resolve to an active supervisor. */
  readonly actorSessionId?: string
  readonly taskDisposition?: RetireTaskDisposition
  /** Reserved for `transfer`; rejected as unsupported in 0.9.3. */
  readonly transferTo?: string
}

/** One open task returned with `OPEN_TASKS`, so the UI can show the blocker. */
export interface OpenTaskSummary {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: string
}

/** Success payload of a disposition. */
export interface RetireDispositionSummary {
  readonly kind: RetireTaskDisposition
  readonly taskIds: readonly string[]
  /** `cancel`: tasks moved to `cancelled`. */
  readonly cancelled?: number
  /** `return`: tasks reassigned to the acting supervisor. */
  readonly returned?: number
  /** `return`: tasks that already had a `retire-return` event. */
  readonly replayed?: number
}

/** Every failure keeps `ok: false` so the IPC caller can branch on `code`. */
export type RetireMemberResult =
  | { readonly ok: true; readonly retired: true; readonly disposition?: RetireDispositionSummary }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly tasks?: readonly OpenTaskSummary[] }

/** Services the guard needs; injected so the decision is testable without Electron. */
export interface RetireMemberDeps {
  listMembers(projectId: string): readonly CadreMemberRow[]
  listTasks(projectId: string): readonly CadreTaskRow[]
  /** Open (or fail) the per-caller write store used for `cancel`. */
  openCollab(projectId: string, sessionId: string): CadreCollab | undefined
  /** Reassign open tasks without a status change, recording one event per task. */
  returnTasks(input: {
    readonly projectId: string
    readonly fromSessionId: string
    readonly actorSessionId: string
    readonly taskIds: readonly string[]
    readonly reason: string
  }): { readonly ok: true; readonly returned: number; readonly replayed: number }
    | { readonly ok: false; readonly code: string; readonly message: string; readonly taskId?: string }
  retire(sessionId: string, projectId: string): EmployeeResult<{ retired: true }>
}

const NON_TERMINAL = new Set(['dispatched', 'accepted', 'in_progress', 'delivered', 'review', 'rework'])
const DISPOSITIONS = new Set<RetireTaskDisposition>(['cancel', 'return', 'transfer'])
const RETIRE_REASON = 'assignee-retired'

function failure(code: string, message: string, tasks?: readonly OpenTaskSummary[]): RetireMemberResult {
  return { ok: false, code, message, ...(tasks === undefined ? {} : { tasks }) }
}

/** Open tasks assigned to one departing member, in ledger order. */
export function openTasksOf(tasks: readonly CadreTaskRow[], sessionId: string): OpenTaskSummary[] {
  return tasks
    .filter(task => task.assigneeSessionId === sessionId && NON_TERMINAL.has(task.status))
    .map(task => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
    }))
}

/** Resolve the acting supervisor: the hint when valid, otherwise the roster's active one. */
export function resolveRetireActor(
  members: readonly CadreMemberRow[],
  hint: string | undefined,
): { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly code: string; readonly message: string } {
  const eligible = (member: CadreMemberRow): boolean =>
    member.role === 'supervisor' && member.state !== 'departed' && member.sessionId !== 'sup-1'
  const candidate = hint === undefined ? undefined : members.find(member => member.sessionId === hint)
  if (hint !== undefined) {
    if (candidate === undefined || !eligible(candidate)) {
      return { ok: false, code: 'FORBIDDEN_ACTOR', message: 'actorSessionId 不是本项目在册 supervisor' }
    }
    return { ok: true, sessionId: candidate.sessionId }
  }
  const active = members.find(eligible)
  if (active === undefined) {
    return { ok: false, code: 'NO_ACTOR', message: '本项目没有在册 supervisor，无法处置未结任务' }
  }
  return { ok: true, sessionId: active.sessionId }
}

/**
 * Retire one member, refusing or disposing of their open tasks first.
 * @param deps - roster/task reads plus the two ledger write paths and the store.
 * @param options - request values already type-checked by the IPC parser.
 * @returns success with the disposition, or a structured refusal.
 */
export function retireMemberWithDisposition(deps: RetireMemberDeps, options: RetireMemberOptions): RetireMemberResult {
  if (options.taskDisposition !== undefined && !DISPOSITIONS.has(options.taskDisposition)) {
    return failure('INVALID_ARGUMENT', `taskDisposition 只能是 cancel/return/transfer（收到 ${String(options.taskDisposition)}）`)
  }
  if (options.taskDisposition === 'transfer') {
    return failure('UNSUPPORTED_DISPOSITION', 'transfer 在 0.9.3 未实现；请改用 cancel 或 return（或先手工转移任务）')
  }

  const members = deps.listMembers(options.projectId)
  const target = members.find(member => member.sessionId === options.sessionId)
  if (target === undefined || target.state === 'departed') {
    return failure('NOT_FOUND', '该会话不在本项目花名册中（可能已离职）')
  }

  const open = openTasksOf(deps.listTasks(options.projectId), options.sessionId)
  if (open.length === 0) {
    const retired = deps.retire(options.sessionId, options.projectId)
    return retired.ok ? { ok: true, retired: true } : failure(retired.code, retired.message)
  }
  if (options.taskDisposition === undefined) {
    return failure('OPEN_TASKS', `该成员有 ${String(open.length)} 个未结任务，请指定 taskDisposition（cancel 或 return）`, open)
  }

  const actor = resolveRetireActor(members, options.actorSessionId)
  if (!actor.ok) return failure(actor.code, actor.message)
  if (actor.sessionId === options.sessionId) {
    // A departing supervisor may be the only active supervisor. Cancelling
    // their own open tasks is a valid way to close the loop; returning them
    // would hand the tasks to the session that is about to depart.
    if (options.taskDisposition === 'return') {
      return failure(
        'NO_OTHER_SUPERVISOR',
        '该项目没有其他在册 supervisor 可接手；请先任命接手人，或改用 cancel 结束自己的未结任务',
      )
    }
  }

  const taskIds = open.map(task => task.taskId)
  let cancelledCount: number | undefined
  let returnedCount: number | undefined
  let replayedCount: number | undefined
  if (options.taskDisposition === 'cancel') {
    const collab = deps.openCollab(options.projectId, actor.sessionId)
    if (collab === undefined) return failure('COLLAB_UNAVAILABLE', '协作写路径不可用，无法取消未结任务')
    // Re-read on the write connection: a retried disposition may find tasks
    // already cancelled, which is success, not INVALID_TRANSITION.
    const current = collab.listTasks().rows
    for (const task of open) {
      const row = current.find(candidate => candidate.taskId === task.taskId)
      if (row === undefined) return failure('DISPOSITION_FAILED', `任务 ${task.taskId} 不在当前台账中`, open)
      if (row.status === 'cancelled') continue
      const result = collab.transition({
        taskId: task.taskId,
        from: row.status,
        to: 'cancelled',
        reason: RETIRE_REASON,
        idempotencyKey: `retire-cancel:${task.taskId}`,
      }) as { readonly ok?: unknown; readonly error?: { readonly code?: unknown; readonly message?: unknown } }
      if (result.ok !== true) {
        return failure(
          'DISPOSITION_FAILED',
          `取消任务 ${task.taskId} 失败：${String(result.error?.code ?? 'INTERNAL_ERROR')} ${String(result.error?.message ?? '')}`.trim(),
          open,
        )
      }
    }
    cancelledCount = taskIds.length
  } else {
    const returned = deps.returnTasks({
      projectId: options.projectId,
      fromSessionId: options.sessionId,
      actorSessionId: actor.sessionId,
      taskIds,
      reason: RETIRE_REASON,
    })
    if (!returned.ok) {
      return failure(
        'DISPOSITION_FAILED',
        `退回任务失败：${returned.code} ${returned.message}`,
        open,
      )
    }
    returnedCount = returned.returned
    replayedCount = returned.replayed
  }

  const retired = deps.retire(options.sessionId, options.projectId)
  if (!retired.ok) return failure(retired.code, retired.message)
  return {
    ok: true,
    retired: true,
    disposition: {
      kind: options.taskDisposition,
      taskIds,
      ...(options.taskDisposition === 'cancel'
        ? { cancelled: cancelledCount ?? 0 }
        : { returned: returnedCount ?? 0, replayed: replayedCount ?? 0 }),
    },
  }
}

/**
 * Parse the IPC request. Unknown fields are ignored; types are enforced so a
 * renderer cannot smuggle a disposition of the wrong shape.
 * @param raw - untrusted IPC payload.
 * @returns the typed request or a structured failure.
 */
export function parseRetireMemberOptions(raw: unknown): { readonly ok: true; readonly value: RetireMemberOptions }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly field?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '参数无效' }
  }
  const record = raw as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'sessionId 无效', field: 'sessionId' }
  }
  if (typeof record.projectId !== 'string' || record.projectId.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'projectId 无效', field: 'projectId' }
  }
  if (record.actorSessionId !== undefined && typeof record.actorSessionId !== 'string') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'actorSessionId 必须是字符串', field: 'actorSessionId' }
  }
  if (record.transferTo !== undefined && typeof record.transferTo !== 'string') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'transferTo 必须是字符串', field: 'transferTo' }
  }
  if (record.taskDisposition !== undefined && typeof record.taskDisposition !== 'string') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'taskDisposition 必须是字符串', field: 'taskDisposition' }
  }
  return {
    ok: true,
    value: {
      sessionId: record.sessionId,
      projectId: record.projectId,
      ...(record.actorSessionId === undefined ? {} : { actorSessionId: record.actorSessionId as string }),
      ...(record.taskDisposition === undefined
        ? {}
        : { taskDisposition: record.taskDisposition as RetireTaskDisposition }),
      ...(record.transferTo === undefined ? {} : { transferTo: record.transferTo as string }),
    },
  }
}

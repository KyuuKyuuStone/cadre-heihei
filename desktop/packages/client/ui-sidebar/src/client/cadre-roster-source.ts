/**
 * Roster data adapter (W1).
 *
 * The panel consumes `RosterMember` only. Today the rows come from the
 * Electron bridge (`cadre:listRoster`, falling back to `cadre:listEmployees`);
 * when the ledger moves to a Host Remote (ADR-0023 §2.4) only this file and
 * its bridge type change — the UI keeps its view model.
 */

/** Roles are the ledger's `members.role`; the client never invents one. */
export type RosterRole = 'supervisor' | 'worker'

/** The four mutually exclusive roster states, in display-priority order. */
export type RosterStatus = 'review' | 'working' | 'idle' | 'offline'

/** One row the roster renders. */
export interface RosterMember {
  readonly sessionId: string
  readonly name: string
  readonly role: RosterRole
  readonly status: RosterStatus
  readonly updatedAt: string | undefined
}

/** Ledger statuses that mean "waiting for the supervisor". */
const REVIEW_STATUSES = new Set(['delivered', 'pending_review'])
/** Ledger statuses that mean the assignee is still working. */
const WORKING_STATUSES = new Set(['in_progress', 'rework'])

/** Raw member row returned by `cadre:listRoster`. */
export interface RosterRow {
  readonly sessionId: string
  readonly role: string
  readonly displayName?: string
  readonly state?: string
  readonly updatedAt?: string
}

/** Raw employee row returned by `cadre:listEmployees`. */
interface EmployeeRow {
  readonly sessionId: string
  readonly displayName?: string
}

/** The bridge surface this adapter needs; every method stays optional. */
export interface RosterBridge {
  listRoster?(query: { projectId: string }): Promise<{
    rows?: readonly RosterRow[]
    members?: readonly RosterRow[]
  } | undefined>
  listEmployees?(query?: { projectId?: string }): Promise<{
    ok?: boolean
    employees?: readonly EmployeeRow[]
    code?: string
    message?: string
  } | undefined>
}

/** Task facts used to derive 待验收 / 执行中 without a second data source. */
export interface RosterTaskHint {
  readonly assigneeSessionId: string
  readonly status: string
}

export type RosterLoad =
  | { readonly ok: true; readonly members: readonly RosterMember[] }
  | { readonly ok: false; readonly reason: string }

/** @param role - raw ledger role. @returns the view role, workers by default. */
function toRole(role: string): RosterRole {
  return role === 'supervisor' ? 'supervisor' : 'worker'
}

/**
 * Resolve one member's state. Priority is 待验收 > 执行中 > 空闲 > 离线:
 * a delivered task outranks a stale offline mark because it waits on a human.
 * @param row - raw roster row.
 * @param state - ledger member state (`available`/`busy`/`offline`).
 * @param tasks - ledger task hints for this project.
 * @returns the display status.
 */
function toStatus(row: RosterRow, state: string | undefined, tasks: readonly RosterTaskHint[]): RosterStatus {
  const own = tasks.filter(task => task.assigneeSessionId === row.sessionId)
  if (own.some(task => REVIEW_STATUSES.has(task.status))) return 'review'
  if (state === 'busy' || own.some(task => WORKING_STATUSES.has(task.status))) return 'working'
  if (state === 'offline') return 'offline'
  return 'idle'
}

/** @param row - raw row. @param state - ledger state. @param tasks - task hints. */
function toMember(row: RosterRow, state: string | undefined, tasks: readonly RosterTaskHint[]): RosterMember {
  return {
    sessionId: row.sessionId,
    name: row.displayName?.trim() === '' || row.displayName === undefined ? row.sessionId : row.displayName,
    role: toRole(row.role),
    status: toStatus(row, state, tasks),
    updatedAt: row.updatedAt,
  }
}

/** @param a - member. @param b - member. @returns supervisor first, then newest. */
function compare(a: RosterMember, b: RosterMember): number {
  if (a.role !== b.role) return a.role === 'supervisor' ? -1 : 1
  const left = a.updatedAt === undefined ? 0 : Date.parse(a.updatedAt)
  const right = b.updatedAt === undefined ? 0 : Date.parse(b.updatedAt)
  return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left)
}

/**
 * Read and adapt the project roster.
 *
 * `cadre:listRoster` is authoritative; a shell without it falls back to the
 * employee table, whose rows are workers with no runtime state (idle).
 * @param bridge - `window.cadre` when the preload exposed it.
 * @param projectId - current project.
 * @param tasks - ledger tasks used to derive review/working states.
 * @returns adapted members, or the failure reason.
 */
export async function loadRoster(
  bridge: RosterBridge | undefined,
  projectId: string,
  tasks: readonly RosterTaskHint[],
): Promise<RosterLoad> {
  if (bridge === undefined) return { ok: false, reason: '主进程通道未就绪' }
  try {
    if (bridge.listRoster !== undefined) {
      const result = await bridge.listRoster({ projectId })
      const rows = result?.rows ?? result?.members ?? []
      return {
        ok: true,
        members: rows.map(row => toMember(row, row.state, tasks)).sort(compare),
      }
    }
    if (bridge.listEmployees !== undefined) {
      const result = await bridge.listEmployees({ projectId })
      if (result?.ok === false) {
        return { ok: false, reason: `${result.code ?? 'UNKNOWN'} · ${result.message ?? '读取员工失败'}` }
      }
      const rows = (result?.employees ?? []).map(employee => ({
        sessionId: employee.sessionId,
        role: 'worker',
        ...(employee.displayName === undefined ? {} : { displayName: employee.displayName }),
      }))
      return { ok: true, members: rows.map(row => toMember(row, undefined, tasks)).sort(compare) }
    }
    return { ok: true, members: [] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Relative activity text. A working member is always "刚刚" because the
 * ledger's `updated_at` only moves on membership writes, not every task step.
 * @param member - roster member.
 * @param now - clock injection for tests.
 * @returns the label shown under the status.
 */
export function activityText(member: RosterMember, now: number = Date.now()): string {
  if (member.status === 'working') return '刚刚'
  if (member.updatedAt === undefined) return '—'
  const at = Date.parse(member.updatedAt)
  if (Number.isNaN(at)) return '—'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

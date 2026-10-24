/**
 * Read-only view of the cadre task ledger for the official desktop shell.
 *
 * The Electron main process opens `<userData>/cadre.sqlite` with
 * `readOnly: true` and never writes: the cadre backend remains the only
 * writer. `busy_timeout` lets a reader wait for WAL checkpoints instead of
 * failing immediately while the writer holds the database.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Single ledger-path resolver shared by the read-only and write connections.
 *
 * Priority: `CADRE_LEDGER_PATH` → `CADRE_USER_DATA/cadre.sqlite` → Electron
 * `userData/cadre.sqlite`. Honouring `CADRE_USER_DATA` keeps the desktop shell
 * aligned with the standalone cadre app's database location.
 * @param userData - Electron `app.getPath('userData')`.
 * @param env - process environment (injectable for tests).
 * @returns absolute ledger path used by both sides.
 */
export function resolveCadreLedgerPath(userData: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CADRE_LEDGER_PATH?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const cadreUserData = env.CADRE_USER_DATA?.trim()
  return join(cadreUserData !== undefined && cadreUserData !== '' ? cadreUserData : userData, 'cadre.sqlite')
}

/** Latest employee report attached to a task (W3 report card). */
export interface CadreReportRow {
  readonly messageId: string
  readonly reporterSessionId: string
  readonly reporterName: string
  readonly summary: string
  readonly preview: string
  readonly deliverables: readonly string[]
  readonly receivedAt: string
  readonly deliveryState: string
}

/** One task row projected for the renderer; camelCase mirrors the IPC payload. */
export interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
  /** Roster name of the assignee; falls back to the session id. */
  readonly assigneeName?: string
  /** Free-text position from the roster row, when the project filled one in. */
  readonly assigneeTitle?: string
  /** Ledger role (`supervisor`/`worker`) used when the roster has no position. */
  readonly assigneeRole?: string
  /** Newest report. Absent when the task has never been reported. */
  readonly latestReport?: CadreReportRow
}

/** Parse `messages.deliverables_json`; malformed history degrades to no items. */
function parseDeliverables(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Result of one `listTasks` call, including the elapsed query time. */
export interface CadreTaskList {
  readonly projectId: string
  readonly rows: readonly CadreTaskRow[]
  readonly elapsedMs: number
}

/** One member row projected for the roster; role is the ledger's authority. */
export interface CadreMemberRow {
  readonly sessionId: string
  readonly role: string
  readonly displayName: string
  readonly state: string
  readonly updatedAt: string
}

/** Result of one `listMembers` call. */
export interface CadreMemberList {
  readonly projectId: string
  readonly rows: readonly CadreMemberRow[]
}

/** Task-list limit; the shell never asks for the whole ledger. */
const TASK_LIMIT = 200
/** Project rosters are small; the cap only guards against corrupt ledgers. */
const MEMBER_LIMIT = 200
/** Project ids come from configuration, not free-form text; reject anything else. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Validate a project id supplied over IPC.
 * @param value - untrusted renderer value.
 * @returns the project id.
 * @throws if the value is not a bounded, safe identifier.
 */
export function requireProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new Error('cadre: projectId must match [A-Za-z0-9._:-]{1,128}')
  }
  return value
}

/**
 * Read-only ledger connection. A missing or unopenable database degrades the
 * feature instead of blocking the official shell's startup.
 */
export class CadreLedger {
  readonly #path: string
  #db: DatabaseSync | undefined
  #unavailable: string | undefined
  /** Older ledgers may predate the collaboration tables; degrade to base rows. */
  #hasReports = false

  /**
   * @param path - absolute ledger path, normally `<userData>/cadre.sqlite`.
   * @param log - diagnostic sink for open failures (defaults to console).
   */
  constructor(path: string, log: (message: string) => void = message => { console.log(message) }) {
    this.#path = path
    if (!existsSync(path)) {
      this.#unavailable = 'missing'
      log(`cadre-ledger unavailable path=${path} reason=missing`)
      return
    }
    try {
      this.#db = new DatabaseSync(path, { readOnly: true })
      this.#db.exec('PRAGMA busy_timeout = 5000')
      const check = this.#db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ?').get('table') as
        | { count?: number }
        | undefined
      const tables = this.#db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('messages', 'members')`).get() as { count?: number } | undefined
      this.#hasReports = (tables?.count ?? 0) === 2
      log(`cadre-ledger open path=${path} readOnly=true tables=${String(check?.count ?? 0)} ` +
        `reports=${String(this.#hasReports)}`)
    } catch (error) {
      this.#db = undefined
      this.#unavailable = error instanceof Error ? error.message : String(error)
      log(`cadre-ledger unavailable path=${path} reason=${this.#unavailable}`)
    }
  }

  /** Whether the connection opened successfully. */
  get available(): boolean {
    return this.#db !== undefined
  }

  /** Absolute database path (also logged at startup). */
  get path(): string {
    return this.#path
  }

  /**
   * Return the newest tasks of one project.
   * @param projectId - bounded project identifier.
   * @returns projected rows plus query timing.
   * @throws when the ledger is unavailable or the query fails.
   */
  listTasks(projectId: unknown): CadreTaskList {
    const project = requireProjectId(projectId)
    const db = this.#db
    if (db === undefined) throw new Error(`cadre ledger unavailable (${this.#unavailable ?? 'unknown'})`)
    const started = performance.now()
    const rows = this.#hasReports
      ? db.prepare(`SELECT t.task_id, t.title, t.status, t.assignee_session_id, t.updated_at,
          COALESCE(mem.display_name, t.assignee_session_id) AS assignee_name,
          mem.description AS assignee_title,
          COALESCE(mem.role, 'worker') AS assignee_role,
          m.message_id AS report_message_id, m.body AS report_body, m.preview AS report_preview,
          m.deliverables_json AS report_deliverables, m.received_at AS report_received_at,
          m.delivery_state AS report_delivery_state, m.from_session_id AS report_from,
          COALESCE(rm.display_name, m.from_session_id) AS report_reporter_name
        FROM tasks t
        LEFT JOIN members mem ON mem.project_id = t.project_id AND mem.session_id = t.assignee_session_id
        LEFT JOIN messages m ON m.message_id = COALESCE(t.latest_report_message_id,
          (SELECT m2.message_id FROM messages m2
           WHERE m2.task_id = t.task_id AND m2.direction = 'report'
           ORDER BY m2.received_at DESC LIMIT 1))
        LEFT JOIN members rm ON rm.project_id = t.project_id AND rm.session_id = m.from_session_id
        WHERE t.project_id = ? ORDER BY t.rowid DESC LIMIT ?`).all(project, TASK_LIMIT)
      : db.prepare(`SELECT task_id, title, status, assignee_session_id, updated_at
          FROM tasks WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`).all(project, TASK_LIMIT)
    const projected = rows.map((row) => {
      const base = {
        taskId: String(row.task_id),
        title: String(row.title),
        status: String(row.status),
        assigneeSessionId: String(row.assignee_session_id),
        updatedAt: String(row.updated_at),
      }
      const assigneeTitle = typeof row.assignee_title === 'string' && row.assignee_title.trim() !== ''
        ? String(row.assignee_title)
        : undefined
      if (row.report_message_id === null || row.report_message_id === undefined) {
        return this.#hasReports
          ? {
              ...base,
              assigneeName: String(row.assignee_name ?? base.assigneeSessionId),
              assigneeRole: String(row.assignee_role ?? 'worker'),
              ...(assigneeTitle === undefined ? {} : { assigneeTitle }),
            }
          : base
      }
      return {
        ...base,
        assigneeName: String(row.assignee_name ?? base.assigneeSessionId),
        assigneeRole: String(row.assignee_role ?? 'worker'),
        ...(assigneeTitle === undefined ? {} : { assigneeTitle }),
        latestReport: {
          messageId: String(row.report_message_id),
          reporterSessionId: String(row.report_from ?? base.assigneeSessionId),
          reporterName: String(row.report_reporter_name ?? row.report_from ?? base.assigneeSessionId),
          summary: String(row.report_body ?? ''),
          preview: String(row.report_preview ?? ''),
          deliverables: parseDeliverables(row.report_deliverables),
          receivedAt: String(row.report_received_at ?? base.updatedAt),
          deliveryState: String(row.report_delivery_state ?? 'delivered'),
        },
      }
    })
    return { projectId: project, rows: projected, elapsedMs: Math.round((performance.now() - started) * 100) / 100 }
  }

  /**
   * Return the members of one project, supervisors first.
   * @param projectId - bounded project identifier.
   * @returns projected member rows.
   * @throws when the ledger is unavailable or the query fails.
   */
  listMembers(projectId: unknown): CadreMemberList {
    const project = requireProjectId(projectId)
    const db = this.#db
    if (db === undefined) throw new Error(`cadre ledger unavailable (${this.#unavailable ?? 'unknown'})`)
    const rows = db.prepare(`SELECT session_id, role, display_name, state, updated_at
      FROM members WHERE project_id = ?
      ORDER BY CASE role WHEN 'supervisor' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT ?`).all(project, MEMBER_LIMIT)
    return {
      projectId: project,
      rows: rows.map(row => ({
        sessionId: String(row.session_id),
        role: String(row.role),
        displayName: String(row.display_name),
        state: String(row.state),
        updatedAt: String(row.updated_at),
      })),
    }
  }

  /** Close the connection; safe to call twice. */
  close(): void {
    this.#db?.close()
    this.#db = undefined
  }
}

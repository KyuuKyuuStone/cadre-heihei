/**
 * Read-only view of the cadre task ledger for the official desktop shell.
 *
 * The Electron main process opens `<DSH_HOME>/cadre.sqlite` (legacy installs:
 * `<userData>/cadre.sqlite`) with `readOnly: true` and never writes: the cadre
 * backend remains the only writer. `busy_timeout` lets a reader wait for WAL
 * checkpoints instead of failing immediately while the writer holds the
 * database.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Resolve the Harness home exactly like `@deepseek-ai/dsh-home-paths`:
 * `$DSH_HOME` (non-blank) wins, otherwise `~/.dsh`.
 * @param env - process environment (injectable for tests).
 * @returns normalized absolute home so the ledger lives beside sessions.
 */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const selected = configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
  const expanded = selected === '~'
    ? homedir()
    : selected.startsWith('~/') || selected.startsWith('~\\') ? join(homedir(), selected.slice(2)) : selected
  return resolve(expanded)
}

/**
 * Single ledger-path resolver shared by the read-only and write connections.
 *
 * Priority: `CADRE_LEDGER_PATH` → `CADRE_USER_DATA/cadre.sqlite` → the shared
 * Harness home (`$DSH_HOME` or `~/.dsh`) + `cadre.sqlite`. The home root
 * survives app uninstall/reinstall and already owns session history, so the
 * roster cannot disappear with Electron's userData directory.
 * @param _userData - Electron `app.getPath('userData')`, retained for callers
 * and for the legacy-path planner; the resolver itself does not use it.
 * @param env - process environment (injectable for tests).
 * @returns absolute ledger path used by both sides.
 */
export function resolveCadreLedgerPath(_userData: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CADRE_LEDGER_PATH?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const cadreUserData = env.CADRE_USER_DATA?.trim()
  if (cadreUserData !== undefined && cadreUserData !== '') return join(cadreUserData, 'cadre.sqlite')
  return join(resolveHarnessHome(env), 'cadre.sqlite')
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

/** One recorded task-status transition (the ledger timeline). */
export interface CadreTaskEventRow {
  readonly fromStatus: string | null
  readonly toStatus: string
  readonly actorSessionId: string
  readonly actorName?: string
  readonly reason?: string
  readonly at: string
}

/** One task row projected for the renderer; camelCase mirrors the IPC payload. */
export interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
  /** Dispatch deadline; absent on ledgers that predate the column or rows without one. */
  readonly dueAt?: string
  /** Status timeline in ledger order; absent when the ledger has no event table. */
  readonly events?: readonly CadreTaskEventRow[]
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
  /** Free-text position/job description, when the project filled one in. */
  readonly description?: string
  readonly state: string
  readonly updatedAt: string
}

/** Result of one `listMembers` call. */
export interface CadreMemberList {
  readonly projectId: string
  readonly rows: readonly CadreMemberRow[]
  /** Startup detected that a previously populated roster is now missing. */
  readonly warning?: { readonly code: 'ROSTER_MISSING'; readonly message: string }
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
  #hasDue = false
  #hasEvents = false

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
      const taskColumns = this.#db.prepare('PRAGMA table_info(tasks)').all() as { name?: string }[]
      this.#hasDue = taskColumns.some(column => column.name === 'due_at')
      const eventTable = this.#db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'task_events'`).get() as { count?: number } | undefined
      this.#hasEvents = (eventTable?.count ?? 0) === 1
      log(`cadre-ledger open path=${path} readOnly=true tables=${String(check?.count ?? 0)} ` +
        `reports=${String(this.#hasReports)} due=${String(this.#hasDue)} events=${String(this.#hasEvents)}`)
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
    const due = this.#hasDue ? ', t.due_at' : ''
    const rows = this.#hasReports
      ? db.prepare(`SELECT t.task_id, t.title, t.status, t.assignee_session_id, t.updated_at${due},
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
      : db.prepare(`SELECT t.task_id, t.title, t.status, t.assignee_session_id, t.updated_at${due}
          FROM tasks t WHERE t.project_id = ? ORDER BY t.rowid DESC LIMIT ?`).all(project, TASK_LIMIT)
    const eventsByTask = new Map<string, CadreTaskEventRow[]>()
    if (this.#hasEvents) {
      const actorName = this.#hasReports
        ? `COALESCE(mem.display_name, e.actor_session_id) AS actor_name`
        : `e.actor_session_id AS actor_name`
      const join = this.#hasReports
        ? `LEFT JOIN members mem ON mem.project_id = e.project_id AND mem.session_id = e.actor_session_id`
        : ''
      const eventRows = db.prepare(`SELECT e.task_id, e.from_status, e.to_status, e.actor_session_id,
          ${actorName}, e.reason, e.at
        FROM task_events e ${join}
        WHERE e.project_id = ? ORDER BY e.at, e.rowid`).all(project)
      for (const event of eventRows) {
        const taskId = String(event.task_id)
        const list = eventsByTask.get(taskId) ?? []
        list.push({
          fromStatus: event.from_status === null || event.from_status === undefined ? null : String(event.from_status),
          toStatus: String(event.to_status),
          actorSessionId: String(event.actor_session_id),
          ...(typeof event.actor_name === 'string' && event.actor_name !== '' ? { actorName: event.actor_name } : {}),
          ...(typeof event.reason === 'string' && event.reason !== '' ? { reason: event.reason } : {}),
          at: String(event.at),
        })
        eventsByTask.set(taskId, list)
      }
    }
    const projected = rows.map((row) => {
      const base = {
        taskId: String(row.task_id),
        title: String(row.title),
        status: String(row.status),
        assigneeSessionId: String(row.assignee_session_id),
        updatedAt: String(row.updated_at),
        ...(this.#hasDue && typeof row.due_at === 'string' && row.due_at !== '' ? { dueAt: row.due_at } : {}),
        ...(eventsByTask.has(String(row.task_id)) ? { events: eventsByTask.get(String(row.task_id))! } : {}),
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
   * Count roster rows across every project, used only to detect a recreated
   * (roster-less) ledger at startup.
   * @returns row count, or 0 when the ledger is unavailable or has no table.
   */
  memberCount(): number {
    const db = this.#db
    if (db === undefined) return 0
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n?: number } | undefined
      return Number(row?.n ?? 0)
    } catch {
      return 0
    }
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
    const rows = db.prepare(`SELECT session_id, role, display_name, description, state, updated_at
      FROM members WHERE project_id = ?
      ORDER BY CASE role WHEN 'supervisor' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT ?`).all(project, MEMBER_LIMIT)
    return {
      projectId: project,
      rows: rows.map(row => ({
        sessionId: String(row.session_id),
        role: String(row.role),
        displayName: String(row.display_name),
        ...(typeof row.description === 'string' && row.description !== '' ? { description: row.description } : {}),
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

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

/** One task row projected for the renderer; camelCase mirrors the IPC payload. */
export interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
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
      log(`cadre-ledger open path=${path} readOnly=true tables=${String(check?.count ?? 0)}`)
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
    const rows = db.prepare(`SELECT task_id, title, status, assignee_session_id, updated_at
      FROM tasks WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`).all(project, TASK_LIMIT)
    const projected = rows.map(row => ({
      taskId: String(row.task_id),
      title: String(row.title),
      status: String(row.status),
      assigneeSessionId: String(row.assignee_session_id),
      updatedAt: String(row.updated_at),
    }))
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

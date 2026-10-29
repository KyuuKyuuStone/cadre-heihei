/**
 * Cadre employee-template bundle and the collaboration tools.
 *
 * The bundle still ships the preset patch; it also mounts one Host plugin row
 * (`cadre-collab` in `cordis.patch.yml`) that registers the supervisor /
 * employee tools. Those tools write the SQLite ledger and deliver messages
 * through the official Session prompt channel, so a task exists only after its
 * prompt was accepted.
 *
 * Configuration comes from the desktop launcher's environment:
 * `CADRE_LEDGER_PATH` (cadre.sqlite). The project is never configured here: each
 * tool call resolves it from the caller's roster row (`members`), so no process
 * default can leak tasks into another project.
 * The plugin speaks to the Host structurally (tools registry, Session prompt),
 * so this package needs no Host dependency graph of its own.
 * @module @deepseek-ai/dsh-bundle-cadre
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

interface SessionController {
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }, signal: AbortSignal): Promise<{ readonly accepted: true }>
}

/** The agent-scoped tool registry surface used by role masks. */
export interface AgentToolsLike {
  restrict(filter: { deny?: readonly string[]; allow?: readonly string[] }): () => void
  /** Authoritative per-agent visibility probe; undefined means the tool does not exist here. */
  get?(name: string): unknown
}

interface AgentLike {
  readonly id: string
  readonly ctx: {
    readonly tools: AgentToolsLike
    readonly systemPrompt?: {
      readonly section: (section: {
        readonly name: string
        readonly order: number
        readonly text: string | (() => string)
      }) => () => void
      readonly getSectionOrder: (name: 'TEAM_POLICY') => number
    }
  }
}

interface HostContext {
  readonly tools: { register(definition: unknown): void; get?(name: string): unknown }
  effect(setup: () => () => void): void
  on(event: string, handler: (payload: { readonly agent: AgentLike }, next: () => unknown) => unknown): () => void
  readonly sessionController: SessionController
  /** Optional web-server scope injection (the desktop Host mounts it). */
  inject?(dependencies: readonly string[], callback: (scope: unknown) => void): void
}

interface ToolRun {
  readonly agent?: { readonly id: string }
  readonly signal: AbortSignal
}

interface DispatchItem {
  readonly employee: string
  readonly title: string
  readonly body: string
  readonly dueAt: string
}

interface DispatchArgs {
  readonly tasks: readonly DispatchItem[]
}

interface DispatchValue {
  readonly dispatched: readonly {
    readonly taskId: string
    readonly assigneeName: string
    readonly role: string
    readonly dueAt: string
  }[]
  readonly failed: readonly {
    readonly target: string
    readonly reason: string
    readonly retryable: boolean
    readonly pendingId?: string
  }[]
}

/** Machine-readable failure kind; retryability derives from this, not from prose. */
type DispatchFailureKind = 'missing-employee' | 'delivery-failed' | 'invalid-due-at'

interface DispatchFailure {
  readonly kind: DispatchFailureKind
  readonly reason: string
}

/** JSON schema fragment shared by dispatch_task and retry_dispatch results. */
const DISPATCHED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['taskId', 'assigneeName', 'role', 'dueAt'],
    properties: {
      taskId: { type: 'string' },
      assigneeName: { type: 'string' },
      role: { type: 'string' },
      dueAt: { type: 'string' },
    },
  },
} as const

const FAILED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['target', 'reason', 'retryable'],
    properties: {
      target: { type: 'string' },
      reason: { type: 'string' },
      retryable: { type: 'boolean' },
      pendingId: { type: 'string' },
    },
  },
} as const

interface ReportArgs {
  readonly taskId: string
  readonly summary: string
  readonly deliverables?: readonly string[]
}

interface ReportValue {
  readonly taskId: string
  readonly status: string
  readonly supervisorNotified: boolean
}

/** One roster row as `list_employees` reports it (DF-002 adds role detail + model). */
interface EmployeeRow {
  readonly sessionId: string
  readonly name: string
  readonly state: string
  readonly description?: string
  readonly templateId?: string
  readonly preferredProviderId?: string
  readonly preferredModel?: string
}

interface EmployeesValue {
  readonly employees: readonly EmployeeRow[]
}

/** One task row projected by the shared ledger bridge. */
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

interface TaskListArgs {
  readonly scope?: 'open' | 'all'
  readonly assignee?: string
  readonly limit?: number
}

interface TaskListValue {
  readonly projectId: string
  readonly tasks: readonly {
    readonly taskId: string
    readonly title: string
    readonly status: string
    readonly assignee: { readonly sessionId: string; readonly name: string }
    readonly dispatcherSessionId: string
    readonly basedOn: {
      readonly bodyPreview: string
      readonly supersedesTaskId?: string
      readonly supersededByTaskId?: string
    }
    readonly attempt: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly dueAt?: string
  }[]
  readonly total: number
  readonly truncated: boolean
  readonly empty: boolean
  readonly reason?: 'no_tasks' | 'no_match'
  readonly hint?: string
}

export interface TaskListPage {
  readonly rows: readonly HostTaskRow[]
  readonly total: number
  readonly truncated: boolean
  readonly empty: boolean
  readonly reason?: 'no_tasks' | 'no_match'
  readonly hint?: string
}

interface TransitionTaskArgs {
  readonly taskId: string
  readonly to: string
  readonly reason?: string
  readonly idempotencyKey?: string
}

interface TransitionTaskValue {
  readonly taskId: string
  readonly from: string
  readonly status: string
  readonly steps: readonly { readonly from: string; readonly to: string; readonly eventId: string }[]
  readonly replayed: boolean
  /** DF-005: only set for a fresh `rework` transition. */
  readonly assigneeNotified?: boolean
  /** DF-005: why the assignee prompt failed; the transition still stands. */
  readonly notifyError?: string
}

const TASK_LIST_OPEN_STATUSES = ['dispatched', 'accepted', 'in_progress', 'delivered', 'review', 'rework'] as const
const TASK_LIST_MAX_LIMIT = 100
const TASK_LIST_DEFAULT_LIMIT = 50
const TRANSITION_TARGETS = ['review', 'verified', 'rework', 'failed', 'cancelled'] as const

/** Stable Cordis plugin name. */
export const name = 'cadre-collab'

/** Host services the tools use. */
export const inject = ['tools', 'sessionController']

const DDL = `
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
  display_name TEXT, description TEXT, state TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
CREATE TABLE IF NOT EXISTS employees (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, display_name TEXT, template_id TEXT,
  persona_note TEXT, preferred_provider_id TEXT, preferred_model TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, body_bytes INTEGER NOT NULL, body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL, dispatcher_session_id TEXT NOT NULL, assignee_session_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, supersedes_task_id TEXT, superseded_by_task_id TEXT,
  latest_dispatch_message_id TEXT, latest_report_message_id TEXT,
  created_at TEXT NOT NULL, dispatched_at TEXT, accepted_at TEXT, started_at TEXT,
  delivered_at TEXT, review_started_at TEXT, closed_at TEXT, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, due_at TEXT,
  UNIQUE (project_id, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  direction TEXT NOT NULL, channel TEXT NOT NULL, from_session_id TEXT NOT NULL, to_session_id TEXT,
  body TEXT NOT NULL, body_bytes INTEGER NOT NULL, body_sha256 TEXT NOT NULL, preview TEXT NOT NULL,
  deliverables_json TEXT, idempotency_key TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'delivered', error_code TEXT,
  received_at TEXT NOT NULL, delivered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL, actor_session_id TEXT NOT NULL, reason TEXT,
  message_id TEXT, idempotency_key TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_dispatch (
  pending_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dispatcher_session_id TEXT NOT NULL,
  employee TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, due_at TEXT NOT NULL,
  reason TEXT NOT NULL, retryable INTEGER NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL, ledger_result_json TEXT, receipt_json TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key)
);
`

/** One Session mapped to several projects cannot be judged by any single one. */
function ambiguityError(sessionId: string, projects: readonly string[]): Error {
  return new Error(`会话同时属于多个项目部（session=${sessionId} projects=${projects.join(',')}），无法确定归属`)
}

/**
 * The desktop-owned `cadre-collab/collab/**` state machine, bundled next to
 * this plugin by `desktop/scripts/build-cadre-collab.mjs`.
 *
 * Every status change goes through it so `task_events.from_status` is recorded
 * and the permission matrix (roster supervisor / task assignee) is enforced in
 * one place. A missing bridge is a hard failure: falling back to a direct
 * `UPDATE tasks` would silently write unauditable transitions.
 */
interface HostLedgerBridge {
  advanceReportToDelivered(input: {
    readonly databasePath: string
    readonly projectId: string
    readonly taskId: string
    readonly actorSessionId: string
    readonly idempotencyBase: string
  }): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }
  listTasks(input: {
    readonly databasePath: string
    readonly projectId: string
  }): { readonly ok: true; readonly rows: readonly HostTaskRow[] } | { readonly ok: false; readonly code: string; readonly message: string }
  transitionTask(input: {
    readonly databasePath: string
    readonly projectId: string
    readonly taskId: string
    readonly to: string
    readonly actorSessionId: string
    readonly idempotencyKey: string
    readonly reason?: string
  }): {
    readonly ok: true
    readonly from: string
    readonly status: string
    readonly steps: readonly { readonly from: string; readonly to: string; readonly eventId: string }[]
    readonly replayed: boolean
  } | { readonly ok: false; readonly code: string; readonly message: string }
}

const requireHostLedger = createRequire(import.meta.url)
let hostLedgerBridge: HostLedgerBridge | undefined

function loadHostLedgerBridge(): HostLedgerBridge {
  if (hostLedgerBridge !== undefined) return hostLedgerBridge
  let mod: Partial<HostLedgerBridge>
  try {
    // Bundled plugin: index.js and cadre-ledger.cjs share lib/. Source tests
    // import src/index.ts, where the same file sits one directory up.
    try {
      mod = requireHostLedger('./cadre-ledger.cjs') as Partial<HostLedgerBridge>
    } catch {
      mod = requireHostLedger('../lib/cadre-ledger.cjs') as Partial<HostLedgerBridge>
    }
  } catch (error) {
    throw new Error('协作状态机不可用：缺少 lib/cadre-ledger.cjs，请运行 node desktop/scripts/build-cadre-collab.mjs'
      + `（${error instanceof Error ? error.message : String(error)}）`)
  }
  for (const name of ['advanceReportToDelivered', 'listTasks', 'transitionTask'] as const) {
    if (typeof mod[name] !== 'function') {
      throw new Error(`协作状态机不可用：cadre-ledger.cjs 未导出 ${name}`)
    }
  }
  hostLedgerBridge = mod as HostLedgerBridge
  return hostLedgerBridge
}

/** Ledger writes the collaboration tools need; one SQLite handle for the Host process. */
class Ledger {
  readonly db: DatabaseSync
  private readonly path: string

  constructor(path: string) {
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(DDL)
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as { name?: string }[]
    if (!columns.some(column => column.name === 'due_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN due_at TEXT')
    }
  }

  close(): void { this.db.close() }

  /**
   * Active roster rows for one Session; `sup-1` is the legacy row with no
   * Session, and a departed row no longer confers a role (its tools, prompt
   * section and restrictions all fall away while task history stays).
   */
  private memberRows(sessionId: string): { projectId: string; role: string; state: string }[] {
    const rows = this.db.prepare(`SELECT project_id, role, state FROM members
      WHERE session_id = ? AND session_id != 'sup-1' AND state != 'departed'
      ORDER BY project_id`).all(sessionId) as
      { project_id: string; role: string; state: string }[]
    return rows.map(row => ({ projectId: row.project_id, role: row.role, state: row.state }))
  }

  /**
   * The roster row for one Session across projects (the caller's identity).
   *
   * A Session is expected to belong to exactly one project. Ambiguity throws
   * instead of picking the newest row: a silent pick would let restrict and
   * the prompt section judge the caller by the wrong project.
   */
  member(sessionId: string): { projectId: string; role: string; state: string } | undefined {
    const rows = this.memberRows(sessionId)
    const [first] = rows
    if (first === undefined) return undefined
    if (rows.length > 1) throw ambiguityError(sessionId, rows.map(row => row.projectId))
    return first
  }

  /**
   * The project this Session belongs to, resolved from the roster.
   *
   * There is deliberately no environment fallback: a caller without a roster
   * row cannot guess a project, and a guessed project would write to the wrong
   * ledger. Ambiguity is an error too, not a "pick the latest".
   */
  projectOf(sessionId: string): string {
    const member = this.member(sessionId)
    if (member === undefined) {
      throw new Error(`会话不属于任何项目部（session=${sessionId}）；请先在项目部花名册登记该会话`)
    }
    return member.projectId
  }

  /** Resolve an assignee by member session id, member name, or employee name. */
  resolveAssignee(projectId: string, employee: string): { sessionId: string; name: string } {
    const direct = this.db.prepare(`SELECT session_id, COALESCE(display_name, session_id) AS name FROM members
      WHERE project_id = ? AND session_id = ? AND state != 'departed'`).get(projectId, employee) as
      { session_id: string; name: string } | undefined
    if (direct !== undefined) return { sessionId: direct.session_id, name: direct.name }
    const byMemberName = this.db.prepare(`SELECT session_id, COALESCE(display_name, session_id) AS name FROM members
      WHERE project_id = ? AND display_name = ? AND state != 'departed' LIMIT 1`).get(projectId, employee) as
      { session_id: string; name: string } | undefined
    if (byMemberName !== undefined) return { sessionId: byMemberName.session_id, name: byMemberName.name }
    const byEmployee = this.db.prepare(`SELECT session_id, COALESCE(display_name, session_id) AS name FROM employees
      WHERE project_id = ? AND (session_id = ? OR display_name = ?) LIMIT 1`).get(projectId, employee, employee) as
      { session_id: string; name: string } | undefined
    if (byEmployee !== undefined) return { sessionId: byEmployee.session_id, name: byEmployee.name }
    throw new Error(`本项目没有找到员工：${employee}（先用 list_employees 查名单）`)
  }

  /**
   * Active workers of one project with their role detail (DF-002).
   *
   * `members` is the roster authority; the employee row only supplies the
   * template, model preference and persona note, so a member without an
   * employee row still appears. A departed member is excluded.
   * @param projectId - project whose workers are read.
   * @returns worker rows, ordered by display name.
   */
  workers(projectId: string): EmployeeRow[] {
    const rows = this.db.prepare(`SELECT m.session_id,
        COALESCE(NULLIF(TRIM(m.display_name), ''), m.session_id) AS name, m.state,
        COALESCE(NULLIF(TRIM(m.description), ''), NULLIF(TRIM(e.persona_note), '')) AS description,
        e.template_id, e.preferred_provider_id, e.preferred_model
      FROM members m
      LEFT JOIN employees e ON e.project_id = m.project_id AND e.session_id = m.session_id
      WHERE m.project_id = ? AND m.role = 'worker' AND m.state != 'departed'
      UNION ALL
      SELECT e.session_id, COALESCE(NULLIF(TRIM(e.display_name), ''), e.session_id), 'available',
        NULLIF(TRIM(e.persona_note), ''), e.template_id, e.preferred_provider_id, e.preferred_model
      FROM employees e
      WHERE e.project_id = ? AND NOT EXISTS (
        SELECT 1 FROM members m WHERE m.project_id = e.project_id AND m.session_id = e.session_id)
      ORDER BY name`).all(projectId, projectId) as {
        session_id: string; name: string; state: string
        description?: string | null; template_id?: string | null
        preferred_provider_id?: string | null; preferred_model?: string | null
      }[]
    return rows.map((row) => ({
      sessionId: row.session_id,
      name: row.name,
      state: row.state,
      ...(row.description == null || row.description.trim() === '' ? {} : { description: row.description }),
      ...(row.template_id == null || row.template_id.trim() === '' ? {} : { templateId: row.template_id }),
      ...(row.preferred_provider_id == null || row.preferred_provider_id.trim() === ''
        ? {}
        : { preferredProviderId: row.preferred_provider_id }),
      ...(row.preferred_model == null || row.preferred_model.trim() === ''
        ? {}
        : { preferredModel: row.preferred_model }),
    }))
  }

  /**
   * Display names for every Session this project can name as an assignee.
   *
   * Members win over not-yet-enrolled employee templates; both fall back to the
   * Session id, matching how dispatch resolves a target.
   * @param projectId - project whose rows are read.
   * @returns sessionId → display name.
   */
  displayNames(projectId: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT session_id, COALESCE(NULLIF(TRIM(display_name), ''), session_id) AS name
      FROM members WHERE project_id = ?
      UNION ALL
      SELECT session_id, COALESCE(NULLIF(TRIM(display_name), ''), session_id) AS name
      FROM employees WHERE project_id = ?`).all(projectId, projectId) as
      { session_id: string; name: string }[]
    const names = new Map<string, string>()
    for (const row of rows) {
      if (!names.has(row.session_id)) names.set(row.session_id, row.name)
    }
    return names
  }

  /**
   * The project's one active supervisor.
   *
   * `sup-1` is the legacy roster placeholder the ledger seeds so an empty project
   * still shows a supervisor row; it has no Session and must never receive a
   * prompt. A real supervisor (created by the user) wins regardless of update
   * time; when only the placeholder exists the answer is "no supervisor".
   */
  /** The roster's 「角色负责什么」 text for one employee Session, when recorded. */
  workerRole(projectId: string, sessionId: string): { name: string; role: string } | undefined {
    const row = this.db.prepare(`SELECT COALESCE(e.display_name, e.session_id) AS name,
      COALESCE(NULLIF(TRIM(e.persona_note), ''), NULLIF(TRIM(e.template_id), ''),
        (SELECT NULLIF(TRIM(m.description), '') FROM members m
          WHERE m.project_id = e.project_id AND m.session_id = e.session_id)) AS role
      FROM employees e WHERE e.project_id = ? AND e.session_id = ?`).get(projectId, sessionId) as
      { name: string; role?: string | null } | undefined
    if (row === undefined || row.role == null) return undefined
    return { name: row.name, role: row.role }
  }

  /**
   * Active members of one project for the supervisor prompt, supervisors
   * first. Read on every prompt assembly so a newly created employee appears
   * without restarting the supervisor Session.
   */
  roster(projectId: string): { name: string; role: string; description?: string }[] {
    const rows = this.db.prepare(`SELECT COALESCE(NULLIF(TRIM(display_name), ''), session_id) AS name,
      role, NULLIF(TRIM(description), '') AS description
      FROM members WHERE project_id = ? AND state != 'departed' AND session_id != 'sup-1'
      ORDER BY CASE role WHEN 'supervisor' THEN 0 ELSE 1 END, name`).all(projectId) as
      { name: string; role: string; description?: string | null }[]
    return rows.map(row => ({
      name: row.name,
      role: row.role,
      ...(row.description == null ? {} : { description: row.description }),
    }))
  }

  supervisor(projectId: string): string | undefined {
    const row = this.db.prepare(`SELECT session_id FROM members WHERE project_id = ? AND role = 'supervisor'
      AND state != 'departed' AND session_id != 'sup-1' ORDER BY updated_at DESC LIMIT 1`)
      .get(projectId) as { session_id?: string } | undefined
    return row?.session_id
  }

  task(projectId: string, taskId: string): { taskId: string; title: string; status: string; assignee: string; dueAt?: string } | undefined {
    const row = this.db.prepare('SELECT task_id, title, status, assignee_session_id, due_at FROM tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, taskId) as
      { task_id: string; title: string; status: string; assignee_session_id: string; due_at?: string | null } | undefined
    if (row === undefined) return undefined
    return {
      taskId: row.task_id, title: row.title, status: row.status, assignee: row.assignee_session_id,
      ...(row.due_at == null ? {} : { dueAt: row.due_at }),
    }
  }

  /** Insert the task intent plus the pending dispatch message in one transaction. */
  beginDispatch(projectId: string, input: {
    taskId: string; title: string; body: string; dueAt: string
    dispatcher: string; assignee: string; idempotencyKey: string; messageId: string
  }): void {
    const now = new Date().toISOString()
    const sha = createHash('sha256').update(input.body).digest('hex')
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks WHERE project_id = ?')
      .get(projectId) as { next: number }).next
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256, status,
        dispatcher_session_id, assignee_session_id, created_at, updated_at, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?)`).run(
        input.taskId, projectId, seq, input.title, input.body, Buffer.byteLength(input.body), sha,
        input.dispatcher, input.assignee, now, now, input.dueAt)
      this.db.prepare(`INSERT INTO messages (message_id, project_id, task_id, direction, channel,
        from_session_id, to_session_id, body, body_bytes, body_sha256, preview, idempotency_key,
        delivery_state, received_at, delivered_at)
        VALUES (?, ?, ?, 'dispatch', 'session', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
        input.messageId, projectId, input.taskId, input.dispatcher, input.assignee,
        input.body, Buffer.byteLength(input.body), sha, input.body.slice(0, 120), input.idempotencyKey, now, now)
      this.db.prepare(`INSERT INTO idempotency (project_id, idempotency_key, operation, fingerprint,
        ledger_result_json, created_at) VALUES (?, ?, 'dispatch', ?, ?, ?)`).run(
        projectId, input.idempotencyKey, input.idempotencyKey, JSON.stringify({ taskId: input.taskId }), now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Delivery accepted: flip the message and record the dispatch event. */
  confirmDispatch(projectId: string, taskId: string, messageId: string): void {
    const now = new Date().toISOString()
    const actor = (this.db.prepare('SELECT dispatcher_session_id FROM tasks WHERE task_id = ?')
      .get(taskId) as { dispatcher_session_id: string }).dispatcher_session_id
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE messages SET delivery_state = 'delivered', delivered_at = ? WHERE message_id = ?`).run(now, messageId)
      this.db.prepare(`UPDATE tasks SET latest_dispatch_message_id = ?, dispatched_at = ?, updated_at = ? WHERE task_id = ?`)
        .run(messageId, now, now, taskId)
      // Creation event, not a transition: `beginDispatch` already inserted the
      // task as `dispatched`, so there is no prior status. This matches
      // `cadre-collab/collab`'s `createTaskTx`, whose create event also carries
      // a NULL `from_status`.
      this.db.prepare(`INSERT INTO task_events (event_id, project_id, task_id, from_status, to_status,
        actor_session_id, message_id, idempotency_key, at)
        VALUES (?, ?, ?, NULL, 'dispatched', ?, ?, ?, ?)`).run(
        randomUUID(), projectId, taskId, actor, messageId, `dispatch:${taskId}`, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Compensation: a refused prompt leaves no task, message, event or idempotency row. */
  rollbackDispatch(projectId: string, taskId: string, idempotencyKey: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM messages WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId)
      this.db.prepare('DELETE FROM idempotency WHERE project_id = ? AND idempotency_key = ?').run(projectId, idempotencyKey)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Record one employee report and move the task to `delivered`.
   *
   * The message row is written first (pending), then the status change runs
   * through the shared state machine as real transitions, so every hop lands
   * in `task_events` with its `from_status`. A failed transition deletes the
   * pending message: a report that did not reach the ledger leaves no trace,
   * and the employee sees the error instead of a silent "delivered".
   */
  report(projectId: string, input: { taskId: string; summary: string; deliverables: readonly string[]; reporter: string }): string {
    const now = new Date().toISOString()
    const messageId = randomUUID()
    const sha = createHash('sha256').update(input.summary).digest('hex')
    const supervisor = this.supervisor(projectId)
    this.db.prepare(`INSERT INTO messages (message_id, project_id, task_id, direction, channel,
      from_session_id, to_session_id, body, body_bytes, body_sha256, preview, deliverables_json,
      idempotency_key, delivery_state, received_at, delivered_at)
      VALUES (?, ?, ?, 'report', 'session', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      messageId, projectId, input.taskId, input.reporter, supervisor ?? null, input.summary,
      Buffer.byteLength(input.summary), sha, input.summary.slice(0, 120),
      JSON.stringify(input.deliverables), `report:${input.taskId}`, now, now)
    try {
      const advanced = loadHostLedgerBridge().advanceReportToDelivered({
        databasePath: this.path,
        projectId,
        taskId: input.taskId,
        actorSessionId: input.reporter,
        idempotencyBase: `report:${input.taskId}`,
      })
      if (!advanced.ok) throw new Error(`汇报状态迁移被拒（${advanced.code}）：${advanced.message}`)
      // Metadata only: the status and timestamps belong to the state machine.
      this.db.prepare(`UPDATE tasks SET latest_report_message_id = ?, updated_at = ? WHERE task_id = ?`)
        .run(messageId, now, input.taskId)
      return messageId
    } catch (error) {
      this.db.prepare('DELETE FROM messages WHERE message_id = ?').run(messageId)
      throw error
    }
  }

  /** Record one refused dispatch so a retry can replay the exact spec. */
  addPending(projectId: string, input: {
    dispatcher: string; employee: string; title: string; body: string; dueAt: string
    reason: string; retryable: boolean
  }): string {
    const pendingId = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO pending_dispatch (pending_id, project_id, dispatcher_session_id,
      employee, title, body, due_at, reason, retryable, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
      pendingId, projectId, input.dispatcher, input.employee, input.title, input.body,
      input.dueAt, input.reason, input.retryable ? 1 : 0, now, now)
    return pendingId
  }

  pending(projectId: string, pendingId: string): {
    pendingId: string; dispatcher: string; employee: string; title: string; body: string
    dueAt: string; status: string; retryable: boolean; attempts: number
  } | undefined {
    const row = this.db.prepare(`SELECT pending_id, dispatcher_session_id, employee, title, body,
      due_at, status, retryable, attempts FROM pending_dispatch WHERE project_id = ? AND pending_id = ?`)
      .get(projectId, pendingId) as {
        pending_id: string; dispatcher_session_id: string; employee: string; title: string
        body: string; due_at: string; status: string; retryable: number; attempts: number } | undefined
    if (row === undefined) return undefined
    return {
      pendingId: row.pending_id, dispatcher: row.dispatcher_session_id, employee: row.employee,
      title: row.title, body: row.body, dueAt: row.due_at, status: row.status,
      retryable: row.retryable === 1, attempts: row.attempts,
    }
  }

  settlePending(pendingId: string, outcome: { taskId?: string; reason?: string; retryable?: boolean }): void {
    const now = new Date().toISOString()
    if (outcome.taskId !== undefined) {
      this.db.prepare(`UPDATE pending_dispatch SET status = 'dispatched', task_id = ?,
        attempts = attempts + 1, updated_at = ? WHERE pending_id = ?`).run(outcome.taskId, now, pendingId)
      return
    }
    this.db.prepare(`UPDATE pending_dispatch SET status = 'pending', reason = ?, retryable = ?,
      attempts = attempts + 1, updated_at = ? WHERE pending_id = ?`).run(
      outcome.reason ?? 'retry failed', outcome.retryable === false ? 0 : 1, now, pendingId)
  }

  confirmReport(messageId: string): void {
    this.db.prepare(`UPDATE messages SET delivery_state = 'delivered', delivered_at = ? WHERE message_id = ?`)
      .run(new Date().toISOString(), messageId)
  }

  failReport(messageId: string, reason: string): void {
    this.db.prepare(`UPDATE messages SET delivery_state = 'failed', error_code = ? WHERE message_id = ?`)
      .run(reason.slice(0, 200), messageId)
  }
}

/** Hard caps enforced by the tools themselves (persona repeats them only as a reminder). */
const MAX_DISPATCH_ITEMS = 5
const MAX_RETRIES = 3

/** Supervisor duties injected into every supervisor Session's prompt (product rule). */
const SUPERVISOR_DUTY = [
  '你是本项目的主管，只做调度与验收，不替员工做专业执行：',
  '1. 只做任务拆解、按花名册派活（dispatch_task）、验收汇总；',
  '2. 有对应角色的员工时，不得代劳该员工的专业执行工作；',
  '3. 当任务需要某个角色但花名册中没有时：明确告诉用户缺少哪个角色、为什么需要它，并询问用户是否需要配置这个角色的员工；不得自己补位执行，不得假装已经派出去，也不要自行创建员工（选角色/模型需要用户决定）；dispatch_task 对不在册员工会返回 missing-employee；',
  '4. 验收前先用 list_tasks 核对台账状态；验收/打回/搁置用 transition_task（to=verified/rework/failed/cancelled，后三者必须写 reason），并对照任务的完成条件核实证据（交付物），不以口头说明代替；',
  '5. 汇报用户时区分「已证实 / 未决 / 风险」三类，不把推测写成结论；',
  `6. 一次最多派 ${String(MAX_DISPATCH_ITEMS)} 条任务（多了要分批）；同一失败重试最多 ${String(MAX_RETRIES)} 次，超过必须换人或找用户裁决。`,
].join('\n')

/**
 * What the supervisor says to the user, and when. The user hears conclusions
 * and decisions, not a relay of every employee report.
 */
const REPORTING_POLICY = [
  '汇报策略（对用户）：',
  '1. 不要逐条复述员工汇报，也不要贴原文；用户不需要每条任务的技术细节。',
  '2. 默认不打扰，你有权判断什么值得告诉用户；能自己判断的不要拿去问。',
  '3. 只有这些必须汇报：任务失败/卡住/重试超限；结果偏离用户要求或与此前决定冲突；需要用户决策（选方案、缺角色是否加人、范围变更）；发现数据/安全/兼容性风险；一批任务阶段性完成、可以验收。',
  '4. 正常完成、中间过程（「员工 A 正在写代码」）、技术细节（改了哪个文件）不汇报。',
  '5. 汇报用总结式：一段话说清发生了什么、结果如何、需要用户做什么，不要罗列原文。',
  '6. 按阶段汇报，不实时打扰；攒一批一起说，只有必须立刻告知的风险才当下说。',
].join('\n')

/** Roster rows as prompt lines: 名字 + 角色（岗位描述前 80 字）. */
function rosterLines(rows: readonly { name: string; role: string; description?: string }[]): string {
  return rows.map((row) => {
    const title = row.role === 'supervisor' ? '主管' : '员工'
    const duty = row.description === undefined ? '' : ` · ${row.description.slice(0, 80)}`
    return `- ${row.name}（${title}${duty}）`
  }).join('\n')
}

/**
 * Supervisor text. The roster is interpolated on every assembly (the section
 * callback re-reads the ledger), so a new employee is visible on the next turn
 * instead of only in the first report-in snapshot.
 */
function supervisorDuty(roster: string): string {
  return [
    SUPERVISOR_DUTY,
    '',
    '以下是当前花名册（每轮重新读取）。派活前必须先核对；名单可能在上一次对话后变化，不要沿用旧印象：',
    roster === '' ? '（暂无成员；先创建员工再派活）' : roster,
    '',
    '派活时用花名册里的名字指认员工；人不在名单里就说明缺哪个角色，并询问用户是否要配置该角色的员工，不要猜、不要补位、不要假装已派出。',
    '',
    REPORTING_POLICY,
  ].join('\n')
}

/** Worker role text: one line, roster 「角色负责什么」, re-read on every assembly. */
function workerDuty(role: { readonly name: string; readonly role: string }): string {
  return `你的角色：${role.name}——${role.role}`
}

/** Mint the official request identity for one programmatic prompt. */
function requestId(): string {
  return randomUUID()
}

/** Text content part used by both tools. */
function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value }
}

/** Outcome of resolving one role mask against the agent's visible tools. */
export interface ToolRestrictionOutcome {
  readonly lift: () => void
  readonly deny: readonly string[]
  readonly absent: readonly string[]
  readonly failClosed: boolean
  readonly reason?: string
}

type ToolRestrictionPlan =
  | { readonly kind: 'none'; readonly absent: readonly string[] }
  | { readonly kind: 'deny'; readonly deny: readonly string[]; readonly absent: readonly string[] }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/** The PTC presentation transport is reserved and cannot appear in a mask. */
const RESERVED_TOOL_NAME = 'run_code'

class FailClosedEnforcementError extends Error {}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort diagnostic append.
 *
 * Logging runs inside failure handlers; a read-only or removed log target must
 * not turn an already-committed transition into a tool failure.
 * @param message - line to append (a newline is added).
 */
function appendDiagnostic(message: string): void {
  try {
    appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
      `${message}\n`)
  } catch {
    // Diagnostics are optional; the caller still reports the real failure.
  }
}

function invalidDenyEntry(entry: unknown): boolean {
  if (typeof entry !== 'string' || entry.trim() === '' || entry.trim() !== entry) return true
  return entry === RESERVED_TOOL_NAME
}

/**
 * Resolve a role mask without guessing from `restrict()` errors.
 *
 * A tool the agent cannot see is genuinely absent: it cannot be called, so
 * leaving it out is safe. Every other uncertainty (no probe, a throwing probe,
 * a malformed mask, `restrict()` rejecting a probed name) is fail-closed.
 */
function planToolRestriction(
  desired: readonly unknown[],
  probe: ((name: string) => unknown) | undefined,
): ToolRestrictionPlan {
  if (probe === undefined) return { kind: 'fail-closed', reason: 'probe-unavailable' }
  if (!Array.isArray(desired) || desired.length === 0) return { kind: 'fail-closed', reason: 'empty-deny-list' }
  const invalidIndex = desired.findIndex(invalidDenyEntry)
  if (invalidIndex >= 0) return { kind: 'fail-closed', reason: `invalid-deny-entry:${JSON.stringify(desired[invalidIndex])}` }
  const deny: string[] = []
  const absent: string[] = []
  try {
    for (const name of desired as readonly string[]) {
      if (probe(name) === undefined) absent.push(name)
      else deny.push(name)
    }
  } catch (error) {
    return { kind: 'fail-closed', reason: `probe-error: ${describeError(error)}` }
  }
  if (deny.length === 0) return { kind: 'none', absent }
  return { kind: 'deny', deny, absent }
}

function failClosedRestriction(tools: AgentToolsLike, reason: string): ToolRestrictionOutcome {
  try {
    // `allow: []` masks every global tool; scoped registrations stay visible.
    return { lift: tools.restrict({ allow: [] }), deny: [], absent: [], failClosed: true, reason }
  } catch (error) {
    throw new FailClosedEnforcementError(
      `cadre-collab: fail-closed 无法禁用全局工具 reason=${reason} error=${describeError(error)}`,
    )
  }
}

/**
 * Apply one role's deny list. Never calls `restrict({ deny: [] })`.
 * @param tools - Agent-scoped registry; `get` is the authoritative known set.
 * @param desired - Candidate tool names for the role mask.
 * @returns the lift handle plus what was denied/absent, or a fail-closed marker.
 */
export function applyToolRestriction(tools: AgentToolsLike, desired: readonly unknown[]): ToolRestrictionOutcome {
  const get = tools.get
  const probe = typeof get === 'function' ? (name: string): unknown => get.call(tools, name) : undefined
  const plan = planToolRestriction(desired, probe)
  if (plan.kind === 'none') return { lift: () => {}, deny: [], absent: plan.absent, failClosed: false }
  if (plan.kind === 'deny') {
    try {
      return { lift: tools.restrict({ deny: plan.deny }), deny: plan.deny, absent: plan.absent, failClosed: false }
    } catch (error) {
      return failClosedRestriction(tools, `restrict-error: ${describeError(error)}`)
    }
  }
  return failClosedRestriction(tools, plan.reason)
}

/**
 * Apply visibility, scope and filters to one project's task rows.
 *
 * A supervisor sees the whole project; any other roster role sees only tasks
 * assigned to itself. An empty page distinguishes "this project has no tasks"
 * from "the filters matched nothing", so the model does not treat a lookup
 * mistake as an empty project.
 * @param rows - every task in the caller's project, newest first.
 * @param names - sessionId → display name.
 * @param query - caller identity and optional filters.
 * @returns the page plus its empty reason and hint.
 */
export function pageTaskRows(
  rows: readonly HostTaskRow[],
  names: ReadonlyMap<string, string>,
  query: { readonly role: string; readonly caller: string; readonly scope?: string; readonly assignee?: string; readonly limit?: number },
): TaskListPage {
  const scope = query.scope ?? 'open'
  if (scope !== 'open' && scope !== 'all') throw new Error(`scope 只能是 open 或 all（收到 ${String(scope)}）`)
  const limit = query.limit ?? TASK_LIST_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIST_MAX_LIMIT) {
    throw new Error(`limit 必须是 1..${String(TASK_LIST_MAX_LIMIT)} 的整数（收到 ${String(limit)}）`)
  }
  const projectHasTasks = rows.length > 0
  let visible = query.role === 'supervisor'
    ? [...rows]
    : rows.filter(row => row.assigneeSessionId === query.caller)
  if (scope === 'open') {
    visible = visible.filter(row => (TASK_LIST_OPEN_STATUSES as readonly string[]).includes(row.status))
  }
  const assignee = query.assignee?.trim().toLowerCase() ?? ''
  if (assignee !== '') {
    visible = visible.filter(row =>
      row.assigneeSessionId.toLowerCase() === assignee
      || (names.get(row.assigneeSessionId) ?? '').toLowerCase() === assignee)
  }
  const total = visible.length
  const page = visible.slice(0, limit)
  const supervisor = query.role === 'supervisor'
  const hint = projectHasTasks
    ? supervisor
      ? '本项目有任务，但当前筛选或可见范围内没有匹配；去掉 scope/assignee 重查，或确认任务是否属于当前会话'
      : '你名下没有匹配任务；员工只能看到派给自己的任务，去掉 scope 再查或向主管确认任务号与分派'
    : supervisor
      ? '本项目还没有任务；先用 list_employees 查在册员工，再 dispatch_task 派活'
      : '本项目还没有任务；等主管派活后再用 list_tasks 查看自己的任务'
  return {
    rows: page,
    total,
    truncated: total > page.length,
    empty: total === 0,
    ...(total === 0
      ? { reason: projectHasTasks ? 'no_match' as const : 'no_tasks' as const, hint }
      : {}),
  }
}

/**
 * Register the collaboration tools over the ledger and Session prompt channel.
 * @param ctx - Host plugin context; services are injected above.
 */
export function apply(ctx: HostContext): void {
  appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
    `apply tools=${String((ctx.tools as { register?: unknown }).register !== undefined)} pid=${process.pid} at=${new Date().toISOString()}
`)
  const databasePath = process.env.CADRE_LEDGER_PATH?.trim()
  if (databasePath === undefined || databasePath === '') {
    console.error('cadre-collab: CADRE_LEDGER_PATH is unset; collaboration tools are not registered')
    return
  }
  const ledger = new Ledger(databasePath)
  const controller = ctx.sessionController
  ctx.effect(() => () => { ledger.close() })

  const callerOf = (run: ToolRun): string => {
    const id = run.agent?.id
    if (id === undefined) throw new Error('cadre-collab: 工具必须由会话内的 Agent 调用')
    return id
  }

  ctx.tools.register({
    name: 'list_employees',
    description: 'List the active employees of this project with their role detail: sessionId, name, state, description, templateId and preferred model (DF-002).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['employees'],
        properties: {
          employees: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['sessionId', 'name', 'state'],
              properties: {
                sessionId: { type: 'string' },
                name: { type: 'string' },
                state: { type: 'string' },
                description: { type: 'string' },
                templateId: { type: 'string' },
                preferredProviderId: { type: 'string' },
                preferredModel: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: EmployeesValue) => [text(value.employees.length === 0
        ? '本项目还没有员工。'
        : value.employees.map((row) => {
          const detail = [
            row.description,
            row.templateId === undefined ? undefined : `模板 ${row.templateId}`,
            row.preferredModel === undefined
              ? undefined
              : `${row.preferredProviderId ?? '默认服务商'}/${row.preferredModel}`,
          ].filter((part): part is string => part !== undefined)
          return `${row.name}（${row.sessionId}） · ${row.state}${detail.length === 0 ? '' : ` · ${detail.join(' · ')}`}`
        }).join('\n'))],
    },
    isConcurrencySafe: () => true,
    execute: async (_args: unknown, run: ToolRun) =>
      ({ employees: ledger.workers(ledger.projectOf(callerOf(run))) }),
  })

  ctx.tools.register({
    name: 'list_tasks',
    description: 'List this project\'s tasks with status, assignee, dispatch basis and update time. A supervisor sees every task; a worker sees only tasks assigned to itself. Call this before accepting work so the decision is based on the ledger, not on conversation memory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: {
          type: 'string', enum: ['open', 'all'],
          description: 'open (default): exclude verified/failed/cancelled; all: every task.',
        },
        assignee: { type: 'string', description: 'Optional assignee sessionId or display name.' },
        limit: {
          type: 'integer', minimum: 1, maximum: TASK_LIST_MAX_LIMIT,
          description: `Page size (default ${String(TASK_LIST_DEFAULT_LIMIT)}).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['projectId', 'tasks', 'total', 'truncated', 'empty'],
        properties: {
          projectId: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['taskId', 'title', 'status', 'assignee', 'dispatcherSessionId', 'basedOn',
                'attempt', 'createdAt', 'updatedAt'],
              properties: {
                taskId: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                assignee: {
                  type: 'object', additionalProperties: false, required: ['sessionId', 'name'],
                  properties: { sessionId: { type: 'string' }, name: { type: 'string' } },
                },
                dispatcherSessionId: { type: 'string' },
                basedOn: {
                  type: 'object', additionalProperties: false, required: ['bodyPreview'],
                  properties: {
                    bodyPreview: { type: 'string' },
                    supersedesTaskId: { type: 'string' },
                    supersededByTaskId: { type: 'string' },
                  },
                },
                attempt: { type: 'integer' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
                dueAt: { type: 'string' },
              },
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          empty: { type: 'boolean' },
          reason: { type: 'string', enum: ['no_tasks', 'no_match'] },
          hint: { type: 'string' },
        },
      },
      render: (_args: unknown, value: TaskListValue) => [text(value.empty
        ? `没有任务（${String(value.reason)}）：${value.hint ?? ''}`
        : value.tasks.map(row => `${row.taskId} [${row.status}] ${row.title} → ${row.assignee.name}`
          + `（更新 ${row.updatedAt}${row.dueAt === undefined ? '' : `，截止 ${row.dueAt}`}）`).join('\n')
          + (value.truncated ? `\n仅显示 ${String(value.tasks.length)}/${String(value.total)} 条` : ''))],
    },
    isConcurrencySafe: () => true,
    execute: async (args: TaskListArgs, run: ToolRun): Promise<TaskListValue> => {
      const caller = callerOf(run)
      const member = ledger.member(caller)
      if (member === undefined) throw new Error(`会话不在本项目花名册（session=${caller}）`)
      if (args.assignee !== undefined && typeof args.assignee !== 'string') throw new Error('assignee 必须是字符串')
      const listed = loadHostLedgerBridge().listTasks({ databasePath, projectId: member.projectId })
      if (!listed.ok) throw new Error(`台账读取失败（${listed.code}）：${listed.message}`)
      const names = ledger.displayNames(member.projectId)
      const page = pageTaskRows(listed.rows, names, {
        role: member.role,
        caller,
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.assignee === undefined ? {} : { assignee: args.assignee }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return {
        projectId: member.projectId,
        tasks: page.rows.map(row => ({
          taskId: row.taskId,
          title: row.title,
          status: row.status,
          assignee: { sessionId: row.assigneeSessionId, name: names.get(row.assigneeSessionId) ?? row.assigneeSessionId },
          dispatcherSessionId: row.dispatcherSessionId,
          basedOn: {
            bodyPreview: row.bodyPreview,
            ...(row.supersedesTaskId === undefined ? {} : { supersedesTaskId: row.supersedesTaskId }),
            ...(row.supersededByTaskId === undefined ? {} : { supersededByTaskId: row.supersededByTaskId }),
          },
          attempt: row.attempt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          ...(row.dueAt === undefined ? {} : { dueAt: row.dueAt }),
        })),
        total: page.total,
        truncated: page.truncated,
        empty: page.empty,
        ...(page.reason === undefined ? {} : { reason: page.reason }),
        ...(page.hint === undefined ? {} : { hint: page.hint }),
      }
    },
  })

  /** Dispatch exactly one spec; shared by the initial and the retry path. */
  const dispatchOne = async (item: DispatchItem, dispatcher: string, projectId: string, signal: AbortSignal):
  Promise<{ ok: true; value: DispatchValue['dispatched'][number] } | { ok: false } & DispatchFailure> => {
    try {
      if (Number.isNaN(Date.parse(item.dueAt))) {
        return { ok: false, kind: 'invalid-due-at', reason: `dueAt 不是合法时间：${item.dueAt}` }
      }
      const assignee = ledger.resolveAssignee(projectId, item.employee)
      const fingerprint = createHash('sha256')
        .update([dispatcher, assignee.sessionId, item.title, item.body, item.dueAt].join('\n')).digest('hex')
      const idempotencyKey = `dispatch:${fingerprint}`
      const replay = ledger.db.prepare(`SELECT ledger_result_json FROM idempotency
        WHERE project_id = ? AND idempotency_key = ?`).get(projectId, idempotencyKey) as
        { ledger_result_json?: string } | undefined
      if (replay?.ledger_result_json !== undefined) {
        const prior = JSON.parse(replay.ledger_result_json) as { taskId: string }
        return { ok: true, value: { taskId: prior.taskId, assigneeName: assignee.name, role: 'worker', dueAt: item.dueAt } }
      }
      const taskId = randomUUID()
      const messageId = randomUUID()
      ledger.beginDispatch(projectId, { taskId, title: item.title, body: item.body, dueAt: item.dueAt,
        dispatcher, assignee: assignee.sessionId, idempotencyKey, messageId })
      try {
        await controller.prompt({
          requestId: requestId(), sessionId: assignee.sessionId, mode: 'queue',
          content: [text([
            '【Cadre 任务】', `任务号：${taskId}`, `标题：${item.title}`,
            `截止：${item.dueAt}`, '', '交付要求：', item.body, '',
            `完成后调用 report_task 工具回报（taskId=${taskId}，summary 写结论，deliverables 列交付物路径）。`,
          ].join('\n'))],
        }, signal)
      } catch (error) {
        ledger.rollbackDispatch(projectId, taskId, idempotencyKey)
        // A cancelled turn is not a dispatch failure: surface the abort so the
        // turn stops instead of queueing a bogus retry.
        if (signal.aborted) throw error
        return { ok: false, kind: 'delivery-failed', reason: `投递失败，已回滚：${error instanceof Error ? error.message : String(error)}` }
      }
      ledger.confirmDispatch(projectId, taskId, messageId)
      console.log(`cadre-collab: dispatch ok task=${taskId} assignee=${assignee.sessionId} due=${item.dueAt}`)
      return { ok: true, value: { taskId, assigneeName: assignee.name, role: 'worker', dueAt: item.dueAt } }
    } catch (error) {
      if (signal.aborted) throw error
      return { ok: false, kind: 'missing-employee', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Turn one failure into the tool-facing row, queueing retryable ones. */
  const failRow = (item: DispatchItem, dispatcher: string, projectId: string, outcome: DispatchFailure): DispatchValue['failed'][number] => {
    const { kind, reason } = outcome
    const retryable = kind !== 'invalid-due-at'
    const target = typeof item.employee === 'string' && item.employee !== '' ? item.employee : '(未指定员工)'
    const pendingId = retryable
      ? ledger.addPending(projectId, { dispatcher, employee: item.employee, title: item.title, body: item.body,
        dueAt: item.dueAt, reason, retryable })
      : undefined
    return {
      target,
      reason: kind === 'missing-employee' ? `待派：${reason}` : reason,
      retryable,
      ...(pendingId === undefined ? {} : { pendingId }),
    }
  }

  const supervisorOnly = (dispatcher: string): void => {
    const role = ledger.member(dispatcher)?.role
    if (role === 'worker') throw new Error(`员工不能派活（caller=${dispatcher} role=${String(role)}）；只有主管或用户会话可以派发任务`)
  }

  /** Structured card data: the front end reads this meta, never the text. */
  const dispatchMeta = (_args: unknown, value: DispatchValue) => ({
    dispatched: value.dispatched.map(row => ({
      taskId: row.taskId, assigneeName: row.assigneeName, role: row.role, dueAt: row.dueAt,
    })),
    failed: value.failed.map(row => ({
      target: row.target, reason: row.reason, retryable: row.retryable,
      ...(row.pendingId === undefined ? {} : { pendingId: row.pendingId }),
    })),
  })

  ctx.tools.register({
    name: 'dispatch_task',
    description: 'Dispatch one or more tasks from a supervisor breakdown, one item at a time. Each item is confirmed individually; a partial failure is reported per item and never swallowed.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['employee', 'title', 'body', 'dueAt'],
            properties: {
              employee: { type: 'string', description: 'Employee sessionId or display name.' },
              title: { type: 'string', description: 'Short task title.' },
              body: { type: 'string', description: 'Delivery requirements the employee must satisfy.' },
              dueAt: { type: 'string', description: 'Deadline as ISO-8601 timestamp; required.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['dispatched', 'failed'],
        properties: { dispatched: DISPATCHED_SCHEMA, failed: FAILED_SCHEMA },
      },
      render: (_args: unknown, value: DispatchValue) => {
        const ok = value.dispatched.map(row => `已派发 ${row.taskId} → ${row.assigneeName}（${row.role}），截止 ${row.dueAt}`)
        const bad = value.failed.map(row => `未派出「${row.target}」：${row.reason}`)
        return [text([...ok, ...bad].join('\n') || '没有任何任务被派出')]
      },
      presentationMeta: dispatchMeta,
    },
    execute: async (args: DispatchArgs, run: ToolRun) => {
      const dispatcher = callerOf(run)
      supervisorOnly(dispatcher)
      const projectId = ledger.projectOf(dispatcher)
      if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error('拆解失败：tasks 至少一条，请重新拆解后再派')
      if (args.tasks.length > MAX_DISPATCH_ITEMS) {
        throw new Error(`一次最多派 ${String(MAX_DISPATCH_ITEMS)} 条（收到 ${String(args.tasks.length)} 条），请分批派发`)
      }
      const dispatched: DispatchValue['dispatched'][number][] = []
      const failed: DispatchValue['failed'][number][] = []
      for (const item of args.tasks) {
        const outcome = await dispatchOne(item, dispatcher, projectId, run.signal)
        if (outcome.ok) {
          dispatched.push(outcome.value)
          continue
        }
        console.log(`cadre-collab: dispatch failed target=${item.employee} reason=${outcome.reason}`)
        failed.push(failRow(item, dispatcher, projectId, outcome))
      }
      return { dispatched, failed }
    },
  })

  /** Replay one queued failure; shared by the tool and the desktop retry route. */
  const retryOne = async (pendingId: string, caller: string, signal: AbortSignal): Promise<DispatchValue> => {
    supervisorOnly(caller)
    const projectId = ledger.projectOf(caller)
    const record = ledger.pending(projectId, pendingId)
    if (record === undefined) throw new Error(`待派条目不存在：${pendingId}`)
    if (record.status === 'dispatched') throw new Error(`该条目已派出，无需重试：${pendingId}`)
    if (record.dispatcher !== caller) throw new Error(`该待派条目属于 ${record.dispatcher}，当前会话无权重试`)
    if (record.attempts >= MAX_RETRIES) {
      throw new Error(`该任务已重试 ${String(record.attempts)} 次（上限 ${String(MAX_RETRIES)} 次），请换人派活或退回用户裁决`)
    }
    const item: DispatchItem = { employee: record.employee, title: record.title, body: record.body, dueAt: record.dueAt }
    const outcome = await dispatchOne(item, caller, projectId, signal)
    if (outcome.ok) {
      ledger.settlePending(record.pendingId, { taskId: outcome.value.taskId })
      console.log(`cadre-collab: retry ok pending=${record.pendingId} task=${outcome.value.taskId}`)
      return { dispatched: [outcome.value], failed: [] }
    }
    ledger.settlePending(record.pendingId, { reason: outcome.reason, retryable: outcome.kind !== 'invalid-due-at' })
    console.log(`cadre-collab: retry failed pending=${record.pendingId} reason=${outcome.reason}`)
    return { dispatched: [], failed: [failRow(item, caller, projectId, outcome)] }
  }

  ctx.tools.register({
    name: 'retry_dispatch',
    description: 'Re-dispatch one queued failure by its pendingId: the exact original spec is replayed, so retrying does not depend on the model understanding a prompt.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['pendingId'],
      properties: {
        pendingId: { type: 'string', description: 'pendingId from a failed dispatch entry.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['dispatched', 'failed'],
        properties: { dispatched: DISPATCHED_SCHEMA, failed: FAILED_SCHEMA },
      },
      render: (_args: unknown, value: DispatchValue) => [text(value.dispatched.length > 0
        ? `重试成功：${value.dispatched.map(row => row.taskId).join(', ')}`
        : `重试仍失败：${value.failed.map(row => `${row.target}：${row.reason}`).join('；')}`)],
      presentationMeta: dispatchMeta,
    },
    execute: async (args: { pendingId: string }, run: ToolRun) =>
      retryOne(args.pendingId, callerOf(run), run.signal),
  })

  // Direct retry: the renderer's button cannot call a Host tool by name, so the
  // app fetches this loopback route through the same protocol/cookie path as
  // /api. Connection admission authenticates the owner before the ledger's
  // supervisor check runs.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scope) => {
      const web = scope as {
        webServer: {
          register(route: {
            kind: 'exact'
            path: string
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
          }): () => void
        }
        connection: { admit(req: IncomingMessage): { readonly rejection: number } | unknown }
        effect(setup: () => () => void, label: string): () => void
      }
      const reply = (res: ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const readBody = async (req: IncomingMessage): Promise<unknown> => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
          size += buffer.length
          if (size > 16_384) throw new Error('请求体过大')
          chunks.push(buffer)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: '/cadre/retry-dispatch',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
            return
          }
          const admission = web.connection.admit(req)
          if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
            const rejection = (admission as { rejection: number }).rejection
            reply(res, rejection, { ok: false, code: 'FORBIDDEN', message: '重试请求未授权' })
            return
          }
          try {
            const body = await readBody(req) as { pendingId?: unknown; dispatcherSessionId?: unknown }
            const pendingId = typeof body?.pendingId === 'string' ? body.pendingId : ''
            const dispatcher = typeof body?.dispatcherSessionId === 'string' ? body.dispatcherSessionId : ''
            if (pendingId === '' || dispatcher === '') {
              reply(res, 400, { ok: false, code: 'INVALID_ARGUMENT', message: 'pendingId 与 dispatcherSessionId 必填' })
              return
            }
            const value = await retryOne(pendingId, dispatcher, AbortSignal.timeout(60_000))
            reply(res, 200, { ok: true, ...value })
          } catch (error) {
            reply(res, 409, {
              ok: false,
              code: 'RETRY_FAILED',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }), 'cadre-collab: /cadre/retry-dispatch')
    })
  }

  ctx.tools.register({
    name: 'report_task',
    description: 'Report the result of one dispatched task back to the supervisor. Only the assignee may report.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['taskId', 'summary'],
      properties: {
        taskId: { type: 'string', description: 'Task id from the dispatch message.' },
        summary: { type: 'string', description: 'What was done and the outcome.' },
        deliverables: { type: 'array', items: { type: 'string' }, description: 'Files or artifacts produced.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['taskId', 'status', 'supervisorNotified'],
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string' },
          supervisorNotified: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: ReportValue) => [text(
        `已回报 ${value.taskId}，任务状态 ${value.status}` +
        (value.supervisorNotified ? '，主管已收到消息。' : '；本项目暂无主管，消息已记录。'))],
    },
    execute: async (args: ReportArgs, run: ToolRun) => {
      const reporter = callerOf(run)
      const projectId = ledger.projectOf(reporter)
      if (typeof args.summary !== 'string' || args.summary.trim() === '') {
        throw new Error('汇报结论（summary）不能为空：必须写清做了什么与结果')
      }
      if (!Array.isArray(args.deliverables) || args.deliverables.length === 0) {
        throw new Error('汇报必须附交付物（deliverables 至少一条：文件路径或产物说明）')
      }
      const task = ledger.task(projectId, args.taskId)
      if (task === undefined) throw new Error(`任务不存在：${args.taskId}`)
      if (task.assignee !== reporter) throw new Error(`只能回报派给自己的任务（该任务属于 ${task.assignee}）`)
      const deliverables = args.deliverables ?? []
      const messageId = ledger.report(projectId, { taskId: task.taskId, summary: args.summary, deliverables, reporter })
      const supervisor = ledger.supervisor(projectId)
      if (supervisor === undefined || supervisor === reporter) {
        appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
          `report supervisor=absent project=${projectId} task=${task.taskId} reporter=${reporter}
`)
        console.log(`cadre-collab: report ok task=${task.taskId} reporter=${reporter} supervisor=absent (no active supervisor session)`)
        return { taskId: task.taskId, status: 'delivered', supervisorNotified: false }
      }
      try {
        await controller.prompt({
          requestId: requestId(), sessionId: supervisor, mode: 'queue',
          content: [text([
            '【员工汇报】', `任务号：${task.taskId}`, `标题：${task.title}`,
            `回报人：${reporter}`, '', args.summary, '',
            `交付物：${deliverables.length === 0 ? '（未提供）' : deliverables.join(', ')}`,
            '任务已置 delivered，可用 list_tasks 查看状态、用 transition_task 验收'
              + '（to=verified；打回用 to=rework 并附 reason）。',
          ].join('\n'))],
        }, run.signal)
        ledger.confirmReport(messageId)
        console.log(`cadre-collab: report ok task=${task.taskId} reporter=${reporter} supervisor=${supervisor}`)
        return { taskId: task.taskId, status: 'delivered', supervisorNotified: true }
      } catch (error) {
        ledger.failReport(messageId, error instanceof Error ? error.message : String(error))
        console.log(`cadre-collab: report delivery failed task=${task.taskId} reason=${error instanceof Error ? error.message : String(error)}`)
        return { taskId: task.taskId, status: 'delivered', supervisorNotified: false }
      }
    },
  })

  ctx.tools.register({
    name: 'transition_task',
    description: 'Change one task status as the project supervisor: to=verified accepts, rework returns it for another attempt, failed closes it as rejected, cancelled shelves it, review only starts the review. reason is required for rework/failed/cancelled. Delivered→verified/rework/failed records the mandatory review step first. Only a supervisor member may call this.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['taskId', 'to'],
      properties: {
        taskId: { type: 'string', description: 'Task id from list_tasks or dispatch_task.' },
        to: { type: 'string', enum: [...TRANSITION_TARGETS], description: 'Target status.' },
        reason: {
          type: 'string',
          description: 'Why. Required (non-empty) for rework, failed and cancelled; recommended for verified.',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Optional stable key for retries; reusing it never writes duplicate events.',
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['taskId', 'from', 'status', 'steps', 'replayed'],
        properties: {
          taskId: { type: 'string' },
          from: { type: 'string' },
          status: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['from', 'to', 'eventId'],
              properties: { from: { type: 'string' }, to: { type: 'string' }, eventId: { type: 'string' } },
            },
          },
          replayed: { type: 'boolean' },
          assigneeNotified: { type: 'boolean' },
          notifyError: { type: 'string' },
        },
      },
      render: (_args: unknown, value: TransitionTaskValue) => [text(value.replayed
        ? `任务 ${value.taskId} 已是 ${value.status}，未重复写入事件。`
        : `任务 ${value.taskId}：${value.steps.map(step => `${step.from}→${step.to}`).join('，')}`
          + (value.assigneeNotified === undefined
            ? ''
            : value.assigneeNotified ? '；已通知员工' : `；通知员工失败：${value.notifyError ?? '未知原因'}`))],
    },
    execute: async (args: TransitionTaskArgs, run: ToolRun): Promise<TransitionTaskValue> => {
      const caller = callerOf(run)
      const member = ledger.member(caller)
      if (member === undefined) {
        throw new Error(`FORBIDDEN_ACTOR: 调用会话不在本项目花名册（session=${caller}）`)
      }
      if (member.role !== 'supervisor') {
        throw new Error(`FORBIDDEN_ACTOR: 员工不能改任务状态（transition_task 仅 supervisor 可用，caller=${caller} role=${member.role}）`)
      }
      if (typeof args.taskId !== 'string' || args.taskId.trim() === '') throw new Error('taskId 必填')
      if (!(TRANSITION_TARGETS as readonly string[]).includes(args.to)) {
        throw new Error(`INVALID_ARGUMENT: to 只能是 ${TRANSITION_TARGETS.join('/')}（收到 ${String(args.to)}）`)
      }
      if (args.reason !== undefined && typeof args.reason !== 'string') throw new Error('reason 必须是字符串')
      if (args.idempotencyKey !== undefined && typeof args.idempotencyKey !== 'string') {
        throw new Error('idempotencyKey 必须是字符串')
      }
      const idempotencyKey = args.idempotencyKey?.trim() || `transition:${randomUUID()}`
      const outcome = loadHostLedgerBridge().transitionTask({
        databasePath,
        projectId: member.projectId,
        taskId: args.taskId,
        to: args.to,
        actorSessionId: caller,
        idempotencyKey,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      })
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`)
      // DF-005: a rework must reach the assignee, not only the ledger. The
      // notice is sent only for a fresh transition: a replay (same
      // idempotencyKey, task already rework) must not page the employee twice.
      // A delivery failure never rolls the status back — the reason is already
      // in task_events; the tool reports the failed notice instead.
      let assigneeNotified: boolean | undefined
      let notifyError: string | undefined
      if (args.to === 'rework' && !outcome.replayed) {
        const task = ledger.task(member.projectId, args.taskId)
        if (task !== undefined) {
          const noticeReason = args.reason?.trim()
          try {
            await controller.prompt({
              requestId: requestId(),
              sessionId: task.assignee,
              mode: 'queue',
              content: [text([
                '【任务打回】', `任务号：${task.taskId}`, `标题：${task.title}`, '',
                `打回原因：${noticeReason === undefined || noticeReason === '' ? '（主管未填写）' : noticeReason}`, '',
                '任务状态已置 rework。请按原因修改后重新调用 report_task 回报。',
              ].join('\n'))],
            }, run.signal)
            assigneeNotified = true
          } catch (error) {
            assigneeNotified = false
            notifyError = error instanceof Error ? error.message : String(error)
            appendDiagnostic(`rework-notify-failed task=${task.taskId} assignee=${task.assignee} reason=${notifyError}`)
            console.log(`cadre-collab: rework notify failed task=${task.taskId} assignee=${task.assignee} reason=${notifyError}`)
          }
        }
      }
      return {
        taskId: args.taskId,
        from: outcome.from,
        status: outcome.status,
        steps: outcome.steps,
        replayed: outcome.replayed,
        ...(assigneeNotified === undefined ? {} : { assigneeNotified }),
        ...(notifyError === undefined ? {} : { notifyError }),
      }
    },
  })

  // D2: role-scoped tool visibility. The official registry restricts per Agent
  // scope (`agent.ctx.tools.restrict`); apply it at each step so a role written
  // after the Agent was created is honoured on the next request.
  const restricted = new Map<string, { role: string; lift: () => void }>()
  const sectioned = new Set<string>()
  const unrecognisedLogged = new Set<string>()
  const ambiguousLogged = new Set<string>()
  /**
   * Roster identity for an Agent, or undefined when unknown/ambiguous.
   *
   * Ambiguity is logged once and treated as unknown so prompt assembly and
   * role restriction fail open rather than judge the caller by the wrong
   * project. Tools still reject it: `projectOf()` throws on ambiguity.
   */
  const memberFor = (agentId: string): { projectId: string; role: string; state: string } | undefined => {
    try {
      return ledger.member(agentId)
    } catch (error) {
      if (!ambiguousLogged.has(agentId)) {
        ambiguousLogged.add(agentId)
        const reason = error instanceof Error ? error.message : String(error)
        appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
          `ambiguous-role agent=${agentId} restrict=off reason=${reason}
`)
        console.warn(`cadre-collab: 会话归属不唯一，角色限制与岗位段已跳过 agent=${agentId} reason=${reason}`)
      }
      return undefined
    }
  }
  /** One scoped prompt section per Agent; the provider runs at every assembly. */
  const attachSection = (agent: AgentLike): void => {
    const prompt = agent.ctx.systemPrompt
    if (prompt === undefined) {
      appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
        `section unavailable agent=${agent.id} service=${String((agent.ctx as unknown as Record<string, unknown>).systemPrompt)}
`)
      return
    }
    if (sectioned.has(agent.id)) return
    sectioned.add(agent.id)
    try {
      prompt.section({
        name: 'cadre-role',
        order: prompt.getSectionOrder('TEAM_POLICY'),
        text: () => {
          const member = memberFor(agent.id)
          if (member === undefined) return ''
          if (member.role === 'supervisor') {
            return supervisorDuty(rosterLines(ledger.roster(member.projectId)))
          }
          const role = ledger.workerRole(member.projectId, agent.id)
          return role === undefined ? '' : workerDuty(role)
        },
      })
    } catch (error) {
      console.warn(`cadre-collab: role section skipped agent=${agent.id} reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // `agent/pre-step` is a waterfall: every listener must call `next()` and
  // return its decision, even when it changes nothing. Returning early yields
  // `undefined` to the downstream listeners, which read `decision.kind`.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    attachSection(agent)
    const member = memberFor(agent.id)
    if (member === undefined) {
      // Unknown role = an ordinary session belonging to the user: fail open.
      // Only an explicitly recorded `supervisor` member is restricted.
      if (!unrecognisedLogged.has(agent.id)) {
        unrecognisedLogged.add(agent.id)
        appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
          `unrecognised-role agent=${agent.id} role=(none) restrict=off
`)
        console.log(`cadre-collab: 未识别角色，不限制 agent=${agent.id}`)
      }
      return next()
    }
    const role = member.role
    const previous = restricted.get(agent.id)
    if (previous?.role !== role) {
      previous?.lift()
      try {
        const desired = role === 'worker'
          ? ['dispatch_task', 'list_employees', 'transition_task']
          : ['report_task', 'bash', 'pwsh', 'write', 'edit', 'str_replace_editor']
        const outcome = applyToolRestriction(agent.ctx.tools, desired)
        restricted.set(agent.id, { role, lift: outcome.lift })
        appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
          outcome.failClosed
            ? `restrict fail-closed agent=${agent.id} role=${role} reason=${outcome.reason}
`
            : `restrict agent=${agent.id} role=${role} deny=${outcome.deny.join(',')} absent=${outcome.absent.join(',')}
`)
        if (outcome.failClosed) {
          console.warn(`cadre-collab: 工具限制解析失败，已禁用全部全局工具（fail-closed）agent=${agent.id} role=${role} reason=${outcome.reason}`)
        } else if (outcome.deny.length === 0) {
          // Fail-open by construction (the tools really are absent), but leave a
          // trace: a mask that resolves to nothing is otherwise indistinguishable
          // from a role that was never restricted.
          console.warn(`cadre-collab: 角色限制目标工具均不存在，已安全放行（fail-open）agent=${agent.id} role=${role} absent=${outcome.absent.join(',')}`)
        }
      } catch (error) {
        // A fail-closed enforcement failure must abort the step, not fall back
        // to an unrestricted agent; other errors keep the previous behaviour.
        if (error instanceof FailClosedEnforcementError) throw error
        console.warn(`cadre-collab: tool restriction skipped agent=${agent.id} reason=${describeError(error)}`)
      }
    }
    return next()
  })
}

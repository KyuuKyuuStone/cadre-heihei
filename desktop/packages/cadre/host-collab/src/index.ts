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
import {
  buildEmployeeContext, estimateTokens, measureTokenBudget, normalizeTaskPacket, TokenBudgetController,
  type TaskFileRef, type TaskPacketInput,
} from './task-packet.ts'
import { appendFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { QuestionRouter, type RoutedRequest, type RoutedAnswer, type ResolveRequest } from './questions.ts'

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

interface HostEventPayload extends Partial<RoutedRequest> {
  readonly agent?: AgentLike
}

interface HostContext {
  readonly tools: { register(definition: unknown): void; get?(name: string): unknown }
  get?(name: string): unknown
  effect(setup: () => () => void): void
  on(event: string, handler: (payload: HostEventPayload, next: () => Promise<unknown>) => unknown, options?: { readonly prepend?: boolean }): () => void
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
  readonly packet?: TaskPacketInput
}

interface DispatchArgs {
  readonly tasks: readonly unknown[]
}

interface DispatchValue {
  readonly dispatched: readonly {
    readonly taskId: string
    readonly assigneeName: string
    readonly role: string
    readonly dueAt: string
    readonly estimatedTokens: number
    readonly warnings: readonly string[]
    readonly overlaps?: readonly {
      readonly taskId: string
      readonly assignee: string
      readonly file: string
    }[]
  }[]
  readonly failed: readonly {
    readonly target: string
    readonly reason: string
    readonly retryable: boolean
    readonly pendingId?: string
  }[]
}

/**
 * Machine-readable failure kind; retryability derives from this, not from prose.
 * `invalid-input` rejects the spec itself, `invalid-item` rejects a non-object batch
 * entry, and `missing-employee` rejects the employee mention, while `storage-failed`
 * reports the ledger write — callers distinguish a fixable spec from a broken store
 * by this tag alone.
 */
type DispatchFailureKind = 'missing-employee' | 'delivery-failed' | 'invalid-due-at' | 'invalid-input' | 'invalid-item' | 'storage-failed'

interface DispatchFailure {
  readonly kind: DispatchFailureKind
  readonly reason: string
}

/** Kinds no retry can fix: replaying the queued spec would fail identically. */
const NON_RETRYABLE_DISPATCH_KINDS: ReadonlySet<DispatchFailureKind> = new Set<DispatchFailureKind>(['invalid-due-at', 'invalid-input', 'invalid-item'])

/**
 * Normalize one dispatch text field into a value SQLite can bind.
 * A missing or blank field collapses to `fallback`, so a queued failure keeps
 * its own readable reason instead of surfacing a bind error from the ledger.
 */
const bindableText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback

/** Object guard for the raw tool boundary: null, arrays, and primitives are not task specs. */
const isDispatchItem = (value: unknown): value is DispatchItem =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Readable target for a malformed batch entry that has no employee field to read. */
const dispatchItemTarget = (item: unknown): string =>
  isDispatchItem(item) ? bindableText(item.employee, '(未指定员工)') : '(非对象条目)'

/** Type name for an invalid-item diagnostic, without echoing arbitrary payload text. */
const dispatchItemType = (item: unknown): string =>
  item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item

/** File paths from one task's persisted `file_refs` JSON; malformed rows are ignored. */
function fileRefPaths(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    console.log(`cadre-collab: invalid file_refs reason=${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  if (!Array.isArray(parsed)) return []
  const paths: string[] = []
  for (const item of parsed) {
    const path = typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null ? (item as { readonly path?: unknown }).path : undefined
    if (typeof path === 'string' && path.trim() !== '') paths.push(path)
  }
  return paths
}

/** JSON schema fragment shared by dispatch_task and retry_dispatch results. */
const DISPATCHED_SCHEMA = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['taskId', 'assigneeName', 'role', 'dueAt', 'estimatedTokens', 'warnings'],
    properties: {
      taskId: { type: 'string' },
      assigneeName: { type: 'string' },
      role: { type: 'string' },
      dueAt: { type: 'string' },
      estimatedTokens: { type: 'number' },
      warnings: { type: 'array', items: { type: 'string' } },
      overlaps: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['taskId', 'assignee', 'file'],
          properties: {
            taskId: { type: 'string' },
            assignee: { type: 'string' },
            file: { type: 'string' },
          },
        },
      },
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
  /** DF-005/P0-1: only set for a fresh `rework`, `cancelled` or `failed` transition. */
  readonly assigneeNotified?: boolean
  /** DF-005/P0-1: why the assignee prompt failed; the transition still stands. */
  readonly notifyError?: string
}

const TASK_LIST_OPEN_STATUSES = ['dispatched', 'accepted', 'in_progress', 'delivered', 'review', 'rework'] as const
const TASK_LIST_MAX_LIMIT = 100
const TASK_LIST_DEFAULT_LIMIT = 50
const TRANSITION_TARGETS = ['review', 'verified', 'rework', 'failed', 'cancelled'] as const

interface AssigneeNotice {
  readonly title: string
  readonly reasonLabel: string
  readonly statusLine: string
}

/** Employee-facing copy for the transition targets that return, cancel or close a task. */
function transitionNotice(to: string): AssigneeNotice | undefined {
  switch (to) {
    case 'rework':
      return {
        title: '【任务打回】',
        reasonLabel: '打回原因：',
        statusLine: '任务状态已置 rework。请按原因修改后重新调用 report_task 回报。',
      }
    case 'cancelled':
      return {
        title: '【任务取消】',
        reasonLabel: '取消原因：',
        statusLine: '任务状态已置 cancelled。无需再回报。',
      }
    case 'failed':
      return {
        title: '【任务关闭】',
        reasonLabel: '关闭原因：',
        statusLine: '任务状态已置 failed。无需再回报。',
      }
    default:
      return undefined
  }
}

/** Stable Cordis plugin name. */
export const name = 'cadre-collab'

/** Host services the tools use. */
export const inject = ['tools', 'sessionController']

/** Tools hidden from an employee Session. `ask_user_question` must stay visible (DF-011 routing). */
export const WORKER_TOOL_DENY = ['dispatch_task', 'list_employees', 'transition_task'] as const

/** Tools hidden from a supervisor Session. Question/decision tools stay visible (DF-011). */
export const SUPERVISOR_TOOL_DENY = ['report_task', 'bash', 'pwsh', 'write', 'edit', 'str_replace_editor'] as const

/** Deployment-varying question routing limits. */
export interface Config {
  /** Milliseconds before a pending employee question is escalated (default 30 min). */
  questionTimeoutMs?: number
  /** Maximum unanswered questions one worker may hold (default 20). */
  questionMaxPendingPerWorker?: number
}

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
  version INTEGER NOT NULL DEFAULT 1, due_at TEXT, file_refs TEXT,
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
  }): {
    readonly ok: true
    readonly from: string
    readonly to: 'delivered'
    readonly replayed: boolean
    readonly eventIds: readonly string[]
    readonly cycleId: string
  } | { readonly ok: false; readonly code: string; readonly message: string }
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
    if (!columns.some(column => column.name === 'file_refs')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN file_refs TEXT')
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

  /** Latest event that put one terminal task into its current status, for a readable report refusal. */
  terminalNotice(projectId: string, taskId: string, status: string): { at: string; reason?: string } | undefined {
    const event = this.db.prepare(`SELECT at, reason FROM task_events
      WHERE project_id = ? AND task_id = ? AND to_status = ?
      ORDER BY at DESC, rowid DESC LIMIT 1`).get(projectId, taskId, status) as
      { at?: unknown; reason?: unknown } | undefined
    const task = this.db.prepare('SELECT updated_at FROM tasks WHERE project_id = ? AND task_id = ?')
      .get(projectId, taskId) as { updated_at?: unknown } | undefined
    if (task === undefined) return undefined
    const at = typeof event?.at === 'string'
      ? event.at
      : typeof task.updated_at === 'string' ? task.updated_at : undefined
    if (at === undefined) return undefined
    return {
      at,
      ...(typeof event?.reason === 'string' && event.reason.trim() !== '' ? { reason: event.reason } : {}),
    }
  }

  /** Latest non-terminal task assigned to one worker, with its dispatcher. */
  openTask(projectId: string, workerSessionId: string): { taskId: string; title: string; dispatcherSessionId?: string } | undefined {
    const row = this.db.prepare(`SELECT task_id, title, dispatcher_session_id FROM tasks
      WHERE project_id = ? AND assignee_session_id = ?
        AND status NOT IN ('verified','failed','cancelled')
      ORDER BY updated_at DESC LIMIT 1`).get(projectId, workerSessionId) as
      { task_id: string; title: string; dispatcher_session_id?: string | null } | undefined
    if (row === undefined) return undefined
    return {
      taskId: row.task_id,
      title: row.title,
      ...(row.dispatcher_session_id == null ? {} : { dispatcherSessionId: row.dispatcher_session_id }),
    }
  }

  /** Open tasks' referenced files, for the dispatch_task overlap advisory (P0-2). */
  openFileRefs(projectId: string): { taskId: string; assignee: string; files: readonly string[] }[] {
    const rows = this.db.prepare(`SELECT task_id, assignee_session_id, file_refs FROM tasks
      WHERE project_id = ? AND status NOT IN ('verified','failed','cancelled')
        AND file_refs IS NOT NULL
      ORDER BY seq`).all(projectId) as
      { task_id: string; assignee_session_id: string; file_refs: string }[]
    return rows
      .map(row => ({
        taskId: row.task_id,
        assignee: row.assignee_session_id,
        files: fileRefPaths(row.file_refs),
      }))
      .filter(row => row.files.length > 0)
  }

  /** Display name for one roster member, falling back to the session id. */
  name(projectId: string, sessionId: string): string {
    const row = this.db.prepare(`SELECT COALESCE(NULLIF(TRIM(display_name), ''), session_id) AS name
      FROM members WHERE project_id = ? AND session_id = ?`).get(projectId, sessionId) as { name?: unknown } | undefined
    return typeof row?.name === 'string' ? row.name : sessionId
  }

  /** Insert the task intent plus the pending dispatch message in one transaction. */
  beginDispatch(projectId: string, input: {
    taskId: string; title: string; body: string; dueAt: string
    dispatcher: string; assignee: string; idempotencyKey: string; messageId: string
    fileRefs: readonly TaskFileRef[]
  }): void {
    const now = new Date().toISOString()
    const sha = createHash('sha256').update(input.body).digest('hex')
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks WHERE project_id = ?')
      .get(projectId) as { next: number }).next
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256, status,
        dispatcher_session_id, assignee_session_id, created_at, updated_at, due_at, file_refs)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, ?)`).run(
        input.taskId, projectId, seq, input.title, input.body, Buffer.byteLength(input.body), sha,
        input.dispatcher, input.assignee, now, now, input.dueAt,
        input.fileRefs.length === 0 ? null : JSON.stringify(input.fileRefs))
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
      // Traceability only: messages.idempotency_key has no uniqueness and is
      // not consulted by report replay (the transition ledger owns that).
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
      const cycleKey = `report:${input.taskId}:${advanced.cycleId}`
      if (advanced.replayed) {
        const existing = this.db.prepare(`SELECT message_id FROM messages
          WHERE project_id = ? AND idempotency_key = ? ORDER BY received_at DESC LIMIT 1`)
          .get(projectId, cycleKey) as { message_id?: unknown } | undefined
        if (typeof existing?.message_id === 'string') {
          this.db.prepare('DELETE FROM messages WHERE message_id = ?').run(messageId)
          return existing.message_id
        }
      }
      this.db.prepare('UPDATE messages SET idempotency_key = ? WHERE message_id = ?').run(cycleKey, messageId)
      const actual = (() => {
        const reader = new DatabaseSync(this.path, { readOnly: true })
        try {
          return reader.prepare('SELECT status FROM tasks WHERE project_id = ? AND task_id = ?')
            .get(projectId, input.taskId) as { status?: unknown } | undefined
        } finally {
          reader.close()
        }
      })()
      if (String(actual?.status) !== 'delivered') {
        throw new Error(`汇报未完成：任务状态仍为 ${String(actual?.status ?? 'unknown')}，未到 delivered`)
      }
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
  '你是本项目的主管：负责拆解、派活、验收和向用户汇报；专业执行全部交给员工，有对应角色的员工时不得代劳。',
  '派活',
  '1. 只派给下方花名册里的人（dispatch_task 对不在册的人返回 missing-employee）。缺少所需角色时，告诉用户缺哪个角色、为什么需要，由用户决定是否配置；不要自己补位执行，不要自行创建员工，不要声称已派出。',
  '2. 每条任务写清：目标与完成定义、可检验的验收项（命令/文件/预期输出）、约束与禁止项、截止时间。需要给人看的文档时，在验收项写明文档名称、读者和用途；未明确要求时，不要求员工另写说明性文档。',
  '3. 同一文件同一时间只交给一名员工；改派前先用 transition_task 把原任务置 cancelled 并写明原因。',
  `4. 一次最多派 ${String(MAX_DISPATCH_ITEMS)} 条（多了分批）；同一失败最多重试 ${String(MAX_RETRIES)} 次，超过就换人或请用户裁决。`,
  '验收',
  '5. 先用 list_tasks 核对台账状态，再逐条对照验收项检查交付物；口头说明不算证据。你不能运行命令，所以派活时就要求员工把命令和完整输出用重定向保存为原始日志并给出路径；不要把 AI 交接用的说明性文档作为交付要求。',
  '6. 验收结论对应具体版本（文件路径+哈希或 commit）；验收后内容又变了，需要重新验收。',
  '7. 用 transition_task 结案：verified / rework / failed / cancelled；后三者必须写 reason，rework 的 reason 要列出缺少的具体证据。',
].join('\n')

/**
 * What the supervisor says to the user, and when. The user hears conclusions
 * and decisions, not a relay of every employee report.
 */
const REPORTING_POLICY = [
  '对用户汇报',
  '8. 默认不打扰；能自己判断的不要拿去问。只在以下情况汇报：任务失败、卡住或重试超限；结果偏离用户要求或与此前决定冲突；需要用户决策（选方案、缺角色是否加人、范围变更）；发现数据/安全/兼容性风险；一批任务阶段性完成、可以验收。',
  '9. 正常进展、中间过程和技术细节（改了哪个文件）不汇报；攒一批一起说，只有必须立刻告知的风险才当下说。',
  '10. 用一段话说明发生了什么、结果如何、需要用户做什么；有不确定的地方在句中标明「已证实」或「未决」，不要把推测写成结论；不转贴员工原文。',
].join('\n')

/**
 * Roster rows as prompt lines: 名字 + 角色（岗位描述前 80 字）.
 * @param rows - active project members, supervisors first.
 * @returns one `- 名字（主管|员工 · 描述）` line per member, or '' when empty.
 */
export function rosterLines(rows: readonly { name: string; role: string; description?: string }[]): string {
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
 * @param roster - output of {@link rosterLines}.
 * @returns the supervisor's `cadre-role` system-prompt section.
 */
export function supervisorDuty(roster: string): string {
  // Static policy first, roster last: a roster change then invalidates only the
  // tail of the cached prompt prefix.
  return [
    SUPERVISOR_DUTY,
    REPORTING_POLICY,
    '',
    '当前花名册（每轮重新读取，派活前以此为准，不要沿用旧印象；用名单里的名字指认员工）：',
    roster === '' ? '（暂无员工。告诉用户需要哪些角色，请用户创建。）' : roster,
  ].join('\n')
}

/** Worker working rules shared by every employee; the role line precedes them. */
const WORKER_POLICY = [
  '你是本项目的员工，任务来自【主管任务】消息：',
  '1. 只做任务包范围内的事；目标、验收项或文件引用不清楚时，先用 ask_user_question 提问（会转给主管），不要猜。',
  '2. 修改文件前确认没有别人正在改；发现文件被并发修改或被移动，停下来问主管，不要覆盖。',
  '3. 完成后调用 report_task：summary 默认不超过 10 行，先写结论，再分「已证实（附关键命令结果和日志路径）」与「未决」；deliverables 列出改动文件和原始日志路径。没跑过的检查，不要说它通过了。',
  '4. 只有任务包的验收项明确要求给用户的文档，或交付对象是用户时，才编写方案、发布说明、README、CHANGELOG、交接文档等；否则不新建说明性 .md。原始日志必须保留，不用 AI 总结代替。',
  '5. 收到【任务打回】时，只补原因里列出的项，然后重新回报。',
].join('\n')

/**
 * Worker role text: roster 「角色负责什么」 plus the shared rules, re-read on every assembly.
 * @param role - the worker's display name and roster role description.
 * @returns the worker's `cadre-role` system-prompt section.
 */
export function workerDuty(role: { readonly name: string; readonly role: string }): string {
  return `你的角色：${role.name}——${role.role}\n${WORKER_POLICY}`
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
export function apply(ctx: HostContext, config: Config = {}): void {
  appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
    `apply tools=${String((ctx.tools as { register?: unknown }).register !== undefined)} pid=${process.pid} at=${new Date().toISOString()}
`)
  const databasePath = process.env.CADRE_LEDGER_PATH?.trim()
  if (databasePath === undefined || databasePath === '') {
    console.error('cadre-collab: CADRE_LEDGER_PATH is unset; collaboration tools are not registered')
    return
  }
  const ledger = new Ledger(databasePath)
  const tokenController = new TokenBudgetController({
    audit: record => {
      appendFileSync(`${databasePath}.plugin.log`, `${JSON.stringify({
        at: new Date().toISOString(), kind: 'token-budget', ...record,
      })}\n`, 'utf8')
    },
    notify: record => {
      // Severe budget overrun is an internal signal only; it never blocks a turn.
      console.error(`cadre-collab: token budget severe task=${record.taskId} action=${record.action}`)
    },
  })
  const controller = ctx.sessionController
  const questionRouter = new QuestionRouter({
    member: sessionId => ledger.member(sessionId),
    openTask: (projectId, workerSessionId) => ledger.openTask(projectId, workerSessionId),
    supervisor: projectId => ledger.supervisor(projectId),
    name: (projectId, sessionId) => ledger.name(projectId, sessionId),
    prompt: async (sessionId, text) => {
      await controller.prompt({
        requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }],
      }, AbortSignal.timeout(60_000))
    },
    log: message => appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
      `questions ${message} at=${new Date().toISOString()}
`),
    now: () => Date.now(),
    newId: () => randomUUID(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  }, {
    ...(config.questionTimeoutMs === undefined ? {} : { timeoutMs: config.questionTimeoutMs }),
    ...(config.questionMaxPendingPerWorker === undefined ? {} : { maxPendingPerWorker: config.questionMaxPendingPerWorker }),
  })
  ctx.effect(() => () => { questionRouter.dispose(); ledger.close() })

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
  const dispatchOne = async (item: unknown, dispatcher: string, projectId: string, signal: AbortSignal):
  Promise<{ ok: true; value: DispatchValue['dispatched'][number] } | { ok: false } & DispatchFailure> => {
    try {
      if (!isDispatchItem(item)) {
        return { ok: false, kind: 'invalid-item', reason: `任务条目格式无效（invalid_item）：需要对象，收到 ${dispatchItemType(item)}` }
      }
      const missing = (['employee', 'title', 'body', 'dueAt'] as const)
        .filter(field => bindableText(item[field], '') === '')
      if (missing.length > 0) {
        return { ok: false, kind: 'invalid-input', reason: `任务缺少必填字段：${missing.join('、')}；每条任务都要有非空的 employee/title/body/dueAt` }
      }
      if (Number.isNaN(Date.parse(item.dueAt))) {
        return { ok: false, kind: 'invalid-due-at', reason: `dueAt 不是合法时间：${item.dueAt}` }
      }
      let assignee: ReturnType<typeof ledger.resolveAssignee>
      try {
        assignee = ledger.resolveAssignee(projectId, item.employee)
      } catch (error) {
        if (signal.aborted) throw error
        return { ok: false, kind: 'missing-employee', reason: error instanceof Error ? error.message : String(error) }
      }
      const taskId = randomUUID()
      const normalized = normalizeTaskPacket(item.packet, { title: item.title, body: item.body })
      const initialContext = buildEmployeeContext(normalized.packet)
      const initialMetric = measureTokenBudget({
        taskId, sessionId: assignee.sessionId, estimatedTokens: estimateTokens(initialContext),
      })
      const decision = tokenController.evaluate(initialMetric, normalized.packet)
      const context = buildEmployeeContext(decision.packet)
      const fingerprint = createHash('sha256')
        .update([dispatcher, assignee.sessionId, item.title, item.body, item.dueAt, JSON.stringify(normalized.packet)].join('\n')).digest('hex')
      const idempotencyKey = `dispatch:${fingerprint}`
      const replay = ledger.db.prepare(`SELECT ledger_result_json FROM idempotency
        WHERE project_id = ? AND idempotency_key = ?`).get(projectId, idempotencyKey) as
        { ledger_result_json?: string } | undefined
      if (replay?.ledger_result_json !== undefined) {
        const prior = JSON.parse(replay.ledger_result_json) as { taskId: string }
        return { ok: true, value: {
          taskId: prior.taskId, assigneeName: assignee.name, role: 'worker', dueAt: item.dueAt,
          estimatedTokens: 0, warnings: [],
        } }
      }
      const overlapPaths = new Set(normalized.packet.fileRefs.map(ref => ref.path))
      const overlaps = overlapPaths.size === 0
        ? []
        : ledger.openFileRefs(projectId).flatMap((other) => {
          const shared = [...new Set(other.files)].filter(file => overlapPaths.has(file))
          return shared.map(file => ({ taskId: other.taskId, assignee: other.assignee, file }))
        })
      const messageId = randomUUID()
      const metric = measureTokenBudget({
        taskId, sessionId: assignee.sessionId, estimatedTokens: estimateTokens(context),
      })
      ledger.beginDispatch(projectId, { taskId, title: item.title, body: item.body, dueAt: item.dueAt,
        dispatcher, assignee: assignee.sessionId, idempotencyKey, messageId,
        fileRefs: normalized.packet.fileRefs })
      try {
        await controller.prompt({
          requestId: requestId(), sessionId: assignee.sessionId, mode: 'queue',
          content: [text([
            '【主管任务】', `任务号：${taskId}`, `标题：${item.title}`,
            `截止：${item.dueAt}`, '', context, '',
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
      return {
        ok: true,
        value: {
          taskId, assigneeName: assignee.name, role: 'worker', dueAt: item.dueAt,
          estimatedTokens: metric.estimatedTokens, warnings: metric.warnings,
          ...(overlaps.length === 0 ? {} : { overlaps }),
        },
      }
    } catch (error) {
      if (signal.aborted) throw error
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, kind: 'storage-failed', reason: `任务台账写入失败：${detail}` }
    }
  }

  /** Turn one failure into the tool-facing row, queueing retryable ones. */
  const failRow = (item: unknown, dispatcher: string, projectId: string, outcome: DispatchFailure): DispatchValue['failed'][number] => {
    const { kind, reason } = outcome
    const retryable = !NON_RETRYABLE_DISPATCH_KINDS.has(kind)
    const target = dispatchItemTarget(item)
    const fields = isDispatchItem(item) ? item : undefined
    // Backstop: never hand an unbindable value to the ledger, whatever the caller sent.
    const pendingId = retryable
      ? ledger.addPending(projectId, { dispatcher, employee: target,
        title: bindableText(fields?.title, '(未提供标题)'), body: bindableText(fields?.body, '(未提供正文)'),
        dueAt: bindableText(fields?.dueAt, '(未提供截止时间)'), reason, retryable })
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
      ...(row.overlaps === undefined ? {} : { overlaps: row.overlaps }),
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
              packet: {
                type: 'object', additionalProperties: false,
                description: 'Six-field TaskPacket; missing goal/acceptance fall back to title/body.',
                properties: {
                  goal: { type: 'string', description: 'One-sentence goal and completion definition.' },
                  constraints: { type: 'array', items: { type: 'string' } },
                  fileRefs: {
                    type: 'array',
                    items: {
                      type: 'object', additionalProperties: false, required: ['path'],
                      properties: {
                        path: { type: 'string' }, lines: { type: 'string' }, summary: { type: 'string' },
                      },
                    },
                  },
                  acceptance: { type: 'array', items: { type: 'string' } },
                  forbidden: { type: 'array', items: { type: 'string' } },
                  openQuestions: { type: 'array', items: { type: 'string' } },
                },
              },
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
        const overlap = value.dispatched.flatMap(row => (row.overlaps ?? []).map(item =>
          `文件重叠：${row.taskId} 与 ${item.taskId}（${item.assignee}）共用 ${item.file}；已照常派发，请留意并发写入。`))
        const bad = value.failed.map(row => `未派出「${row.target}」：${row.reason}`)
        return [text([...ok, ...overlap, ...bad].join('\n') || '没有任何任务被派出')]
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
        console.log(`cadre-collab: dispatch failed target=${dispatchItemTarget(item)} reason=${outcome.reason}`)
        // One bad item must not abort the rest of the batch: record it and go on.
        try {
          failed.push(failRow(item, dispatcher, projectId, outcome))
        } catch (error) {
          if (run.signal.aborted) throw error
          const detail = error instanceof Error ? error.message : String(error)
          console.log(`cadre-collab: dispatch failure not queued target=${String(item.employee)} reason=${detail}`)
          failed.push({ target: bindableText(item.employee, '(未指定员工)'),
            reason: `未能记录失败原因：${detail}`, retryable: false })
        }
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
    ledger.settlePending(record.pendingId, { reason: outcome.reason, retryable: !NON_RETRYABLE_DISPATCH_KINDS.has(outcome.kind) })
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
      const task = ledger.task(projectId, args.taskId)
      if (task === undefined) throw new Error(`任务不存在：${args.taskId}`)
      if (task.assignee !== reporter) throw new Error(`只能回报派给自己的任务（该任务属于 ${task.assignee}）`)
      if (task.status === 'verified' || task.status === 'failed' || task.status === 'cancelled') {
        const notice = ledger.terminalNotice(projectId, task.taskId, task.status)
        const at = notice?.at ?? '（时间未知）'
        const reason = notice?.reason?.trim() || '（主管未填写）'
        throw new Error(`任务已于 ${at} 被主管置为 ${task.status}，原因：${reason}，无需再回报。`)
      }
      if (typeof args.summary !== 'string' || args.summary.trim() === '') {
        throw new Error('汇报结论（summary）不能为空：必须写清做了什么与结果')
      }
      if (!Array.isArray(args.deliverables) || args.deliverables.length === 0) {
        throw new Error('汇报必须附交付物（deliverables 至少一条：文件路径或产物说明）')
      }
      const deliverables = args.deliverables ?? []
      const messageId = ledger.report(projectId, { taskId: task.taskId, summary: args.summary, deliverables, reporter })
      const finalStatus = ledger.task(projectId, task.taskId)?.status ?? 'unknown'
      const supervisor = ledger.supervisor(projectId)
      if (supervisor === undefined || supervisor === reporter) {
        appendFileSync(process.env.CADRE_LEDGER_PATH ? `${process.env.CADRE_LEDGER_PATH}.plugin.log` : 'cadre-collab-missing.log',
          `report supervisor=absent project=${projectId} task=${task.taskId} reporter=${reporter}
`)
        console.log(`cadre-collab: report ok task=${task.taskId} reporter=${reporter} supervisor=absent (no active supervisor session)`)
        return { taskId: task.taskId, status: finalStatus, supervisorNotified: false }
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
        return { taskId: task.taskId, status: finalStatus, supervisorNotified: true }
      } catch (error) {
        ledger.failReport(messageId, error instanceof Error ? error.message : String(error))
        console.log(`cadre-collab: report delivery failed task=${task.taskId} reason=${error instanceof Error ? error.message : String(error)}`)
        return { taskId: task.taskId, status: finalStatus, supervisorNotified: false }
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
      // P0-1: a rework, cancellation or failure must reach the assignee, not
      // only the ledger. The notice is sent only for a fresh transition: a
      // replay (same idempotencyKey, task already terminal) must not page the
      // employee twice. A delivery failure never rolls the status back — the
      // reason is already in task_events; the tool reports the failed notice.
      const notice = transitionNotice(args.to)
      let assigneeNotified: boolean | undefined
      let notifyError: string | undefined
      if (notice !== undefined && !outcome.replayed) {
        const task = ledger.task(member.projectId, args.taskId)
        if (task !== undefined) {
          const noticeReason = args.reason?.trim()
          try {
            await controller.prompt({
              requestId: requestId(),
              sessionId: task.assignee,
              mode: 'queue',
              content: [text([
                notice.title, `任务号：${task.taskId}`, `标题：${task.title}`, '',
                `${notice.reasonLabel}${noticeReason === undefined || noticeReason === '' ? '（主管未填写）' : noticeReason}`, '',
                notice.statusLine,
              ].join('\n'))],
            }, run.signal)
            assigneeNotified = true
          } catch (error) {
            assigneeNotified = false
            notifyError = error instanceof Error ? error.message : String(error)
            appendDiagnostic(`notify-failed task=${task.taskId} assignee=${task.assignee} status=${args.to} reason=${notifyError}`)
            console.log(`cadre-collab: notify failed task=${task.taskId} assignee=${task.assignee} status=${args.to} reason=${notifyError}`)
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
  ctx.tools.register({
    name: 'resolve_employee_question',
    description: 'Answer, reject, or escalate one employee question routed to this supervisor. Use the questionId from the 【员工请示】 message.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['questionId', 'action'],
      properties: {
        questionId: { type: 'string' },
        action: { type: 'string', enum: ['answer', 'reject', 'escalate'] },
        answers: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'selected'],
            properties: {
              id: { type: 'string' }, selected: { type: 'array', items: { type: 'string' } },
              custom: { type: 'string' },
            },
          },
        },
        reason: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          state: { type: 'string' },
          replayed: { type: 'boolean' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { ok: boolean; state?: string; code?: string; message?: string }) => [text(
        value.ok ? `员工请示已处理：${value.state ?? '完成'}` : `处理失败：${value.code ?? ''} ${value.message ?? ''}`.trim())],
    },
    isConcurrencySafe: () => false,
    execute: async (args: ResolveRequest, run: ToolRun) =>
      questionRouter.resolve(args, callerOf(run)),
  })

  ctx.on('user-questions/request', async (payload, next) => {
    const agent = payload.agent
    const questions = payload.questions
    if (agent === undefined || questions === undefined) return next()
    const request: RoutedRequest = {
      questions,
      ...(payload.signal === undefined ? {} : { signal: payload.signal }),
      ...(payload.wait === undefined ? {} : { wait: payload.wait }),
    }
    const answer: RoutedAnswer | undefined = await questionRouter.intercept(request, agent.id)
    return answer === undefined ? next() : answer
  }, { prepend: true })

  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload.agent
    if (agent === undefined) return next()
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
        const desired = role === 'worker' ? WORKER_TOOL_DENY : SUPERVISOR_TOOL_DENY
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

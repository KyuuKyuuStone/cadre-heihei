/**
 * Employee roster (ADR-0022 T1): session→template binding beside the cadre ledger.
 *
 * The table shares `cadre.sqlite` with the provider catalogue. The migration is
 * forward-only and additive: it creates a new table and index and never rewrites
 * ledger or provider tables. This table stores no credentials; `preferred_*`
 * columns are the employee's wishes, while the official `modelSelection`
 * projection stays the runtime authority (ADR-0022 U-25).
 */
import { DatabaseSync } from 'node:sqlite'

/** Session ids and project ids share the ledger's identifier alphabet. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
/** Registered preset ids: the `cadre-` prefix plus a lowercase slug (design/05 §2). */
const TEMPLATE_ID_PATTERN = /^cadre-[a-z0-9][a-z0-9-]{0,62}$/
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/+-]{1,200}$/
const MAX_DISPLAY_NAME = 80
const MAX_PERSONA_NOTE = 4_000
/** Reject C0/C1 controls and DEL in user-facing text; newlines/tabs stay legal in notes. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const ID_TEXT_UNSAFE = /[\u0000-\u001F\u007F-\u009F]/

/** One employee row; optional columns are absent rather than empty strings. */
export interface EmployeeRecord {
  readonly sessionId: string
  readonly projectId: string
  readonly displayName?: string
  readonly templateId?: string
  readonly personaNote?: string
  readonly preferredProviderId?: string
  readonly preferredModel?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One upsert request. `undefined` keeps the stored value on update (and stores
 * NULL on insert); `null` clears the column explicitly.
 */
export interface UpsertEmployeeInput {
  readonly sessionId: string
  readonly projectId: string
  readonly displayName?: string | null
  readonly templateId?: string | null
  readonly personaNote?: string | null
  readonly preferredProviderId?: string | null
  readonly preferredModel?: string | null
}

/** One roster write from the project 「＋」 creation flow. */
export interface SaveMemberInput {
  readonly sessionId: string
  readonly projectId: string
  readonly role: 'worker' | 'supervisor'
  readonly displayName?: string
}

export interface EmployeeFailure {
  readonly ok: false
  readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'STORAGE_ERROR'
  readonly message: string
  readonly field?: string
}

export type EmployeeResult<T> = ({ ok: true } & T) | EmployeeFailure

function fail(code: EmployeeFailure['code'], message: string, field?: string): EmployeeFailure {
  return { ok: false, code, message, ...(field === undefined ? {} : { field }) }
}

/** Collapse empty/whitespace-only text to `null` so the column stays NULL. */
function textOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function checkText(value: string | null | undefined, field: string, max: number): EmployeeFailure | undefined {
  if (value === null || value === undefined) return undefined
  if (value.length > max) return fail('INVALID_ARGUMENT', `${field} 最多 ${max} 字符`, field)
  return undefined
}

/** Validate one upsert before touching storage. Template or provider/model may be empty. */
export function validateEmployeeInput(input: UpsertEmployeeInput): EmployeeFailure | undefined {
  if (typeof input.sessionId !== 'string' || !ID_PATTERN.test(input.sessionId)) {
    return fail('INVALID_ARGUMENT', 'sessionId 不合法', 'sessionId')
  }
  if (typeof input.projectId !== 'string' || !ID_PATTERN.test(input.projectId)) {
    return fail('INVALID_ARGUMENT', 'projectId 不合法', 'projectId')
  }
  const displayName = textOrNull(input.displayName)
  const personaNote = textOrNull(input.personaNote)
  const templateId = textOrNull(input.templateId)
  const providerId = textOrNull(input.preferredProviderId)
  const model = textOrNull(input.preferredModel)
  if (displayName !== undefined && displayName !== null && ID_TEXT_UNSAFE.test(displayName)) {
    return fail('INVALID_ARGUMENT', 'displayName 含不可见控制字符', 'displayName')
  }
  const displayFailure = checkText(displayName, 'displayName', MAX_DISPLAY_NAME)
  if (displayFailure !== undefined) return displayFailure
  if (personaNote !== undefined && personaNote !== null && CONTROL_CHARACTERS.test(personaNote)) {
    return fail('INVALID_ARGUMENT', 'personaNote 含不可见控制字符', 'personaNote')
  }
  const personaFailure = checkText(personaNote, 'personaNote', MAX_PERSONA_NOTE)
  if (personaFailure !== undefined) return personaFailure
  if (templateId !== undefined && templateId !== null && !TEMPLATE_ID_PATTERN.test(templateId)) {
    return fail('INVALID_ARGUMENT', 'templateId 必须是 cadre-<小写 slug> 或留空', 'templateId')
  }
  if (providerId !== undefined && providerId !== null && !PROVIDER_ID_PATTERN.test(providerId)) {
    return fail('INVALID_ARGUMENT', 'preferredProviderId 仅允许小写字母、数字与连字符', 'preferredProviderId')
  }
  if (model !== undefined && model !== null && !MODEL_ID_PATTERN.test(model)) {
    return fail('INVALID_ARGUMENT', 'preferredModel 不合法', 'preferredModel')
  }
  return undefined
}

interface Row {
  session_id: string
  project_id: string
  display_name: string | null
  template_id: string | null
  persona_note: string | null
  preferred_provider_id: string | null
  preferred_model: string | null
  created_at: string
  updated_at: string
}

function toRecord(row: Row): EmployeeRecord {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.template_id === null ? {} : { templateId: row.template_id }),
    ...(row.persona_note === null ? {} : { personaNote: row.persona_note }),
    ...(row.preferred_provider_id === null ? {} : { preferredProviderId: row.preferred_provider_id }),
    ...(row.preferred_model === null ? {} : { preferredModel: row.preferred_model }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** SQLite-backed employee roster. One instance per database file. */
export class EmployeeStore {
  private readonly db: DatabaseSync

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  /** Forward-only and idempotent: creates the roster table and its project index. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        display_name TEXT,
        template_id TEXT,
        persona_note TEXT,
        preferred_provider_id TEXT,
        preferred_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS employees_project
        ON employees(project_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  /** @returns the row only when it belongs to `projectId` (when supplied). */
  get(sessionId: string, projectId?: string): EmployeeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM employees WHERE session_id = ?')
      .get(sessionId) as unknown as Row | undefined
    if (row === undefined) return undefined
    if (projectId !== undefined && row.project_id !== projectId) return undefined
    return toRecord(row)
  }

  list(projectId: string): readonly EmployeeRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM employees WHERE project_id = ? ORDER BY created_at, session_id',
    ).all(projectId) as unknown as Row[]
    return rows.map(toRecord)
  }

  /**
   * Mirror a saved employee into the ledger roster.
   *
   * The roster panel reads `members` (role/state authority), so an employee that
   * never gets a member row stays invisible in 花名册. The ledger schema is owned
   * by the collab library; this write is skipped when the table is absent (for
   * example a standalone employee database) and never downgrades a supervisor.
   * @param input - the employee write that just succeeded.
   * @param displayName - the stored display name, when any.
   * @param now - write timestamp.
   */
  private syncRosterMember(input: UpsertEmployeeInput, displayName: string | undefined, now: string): void {
    try {
      const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get()
      if (table === undefined) return
      this.db.prepare(`
        INSERT INTO members (project_id, session_id, role, display_name, state, created_at, updated_at)
        VALUES (?, ?, 'worker', ?, 'available', ?, ?)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          role = CASE WHEN members.role = 'supervisor' THEN 'supervisor' ELSE 'worker' END,
          display_name = COALESCE(excluded.display_name, members.display_name),
          state = CASE WHEN members.state = 'departed' THEN 'available' ELSE members.state END,
          updated_at = excluded.updated_at
      `).run(input.projectId, input.sessionId, displayName ?? null, now, now)
    } catch (error) {
      // Roster mirroring must not fail the employee write; the log keeps the cause inspectable.
      console.warn(`cadre-employees roster sync skipped reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Insert or update one roster member from the project creation flow.
   *
   * The ledger's `members` table is the authority for role. A project may hold
   * at most one supervisor that has not departed; this is enforced here, not
   * only by the disabled button. The employee preference row is not created —
   * it stays optional (description/model can be edited later).
   * @param input - session, project, role and optional display name.
   * @param now - write timestamp.
   * @returns the stored values, or a validation/conflict failure.
   */
  saveMember(input: SaveMemberInput, now: string): EmployeeResult<{ member: SaveMemberInput }> {
    if (typeof input.sessionId !== 'string' || !ID_PATTERN.test(input.sessionId)) {
      return fail('INVALID_ARGUMENT', 'sessionId 不合法', 'sessionId')
    }
    if (typeof input.projectId !== 'string' || !ID_PATTERN.test(input.projectId)) {
      return fail('INVALID_ARGUMENT', 'projectId 不合法', 'projectId')
    }
    if (input.role !== 'worker' && input.role !== 'supervisor') {
      return fail('INVALID_ARGUMENT', 'role 只能是 worker 或 supervisor', 'role')
    }
    const displayName = input.displayName?.trim()
    if (displayName !== undefined && displayName.length > MAX_DISPLAY_NAME) {
      return fail('INVALID_ARGUMENT', `displayName 最多 ${MAX_DISPLAY_NAME} 字符`, 'displayName')
    }
    if (displayName !== undefined && CONTROL_CHARACTERS.test(displayName)) {
      return fail('INVALID_ARGUMENT', 'displayName 含非法控制字符', 'displayName')
    }
    try {
      const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get()
      if (table === undefined) return fail('STORAGE_ERROR', 'members 表不存在')
      if (input.role === 'supervisor') {
        const occupied = this.db.prepare(`SELECT session_id FROM members
          WHERE project_id = ? AND role = 'supervisor' AND state != 'departed'
            AND session_id != ? AND session_id != 'sup-1' LIMIT 1`)
          .get(input.projectId, input.sessionId) as { session_id?: string } | undefined
        if (occupied !== undefined) {
          return fail('INVALID_ARGUMENT', `本项目已有主管（${String(occupied.session_id)}），请先办理离职`, 'role')
        }
      }
      this.db.prepare(`
        INSERT INTO members (project_id, session_id, role, display_name, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          role = excluded.role,
          display_name = COALESCE(excluded.display_name, members.display_name),
          state = 'available',
          updated_at = excluded.updated_at
      `).run(input.projectId, input.sessionId, input.role, displayName ?? null, now, now)
      return { ok: true, member: { ...input, ...(displayName === undefined ? {} : { displayName }) } }
    } catch (error) {
      return fail('STORAGE_ERROR', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Departure: mark the roster row departed and keep every historical row.
   * @param sessionId - member session.
   * @param projectId - owning project.
   * @param now - write timestamp.
   * @returns success even when no row matched (idempotent).
   */
  retireMember(sessionId: string, projectId: string, now: string): EmployeeResult<{ retired: true }> {
    if (!ID_PATTERN.test(sessionId) || !ID_PATTERN.test(projectId)) {
      return fail('INVALID_ARGUMENT', 'sessionId/projectId 不合法')
    }
    try {
      this.db.prepare("UPDATE members SET state = 'departed', updated_at = ? WHERE project_id = ? AND session_id = ?")
        .run(now, projectId, sessionId)
      return { ok: true, retired: true }
    } catch (error) {
      return fail('STORAGE_ERROR', error instanceof Error ? error.message : String(error))
    }
  }

  /** Mark a removed employee's roster row as departed; task history stays untouched. */
  private retireRosterMember(sessionId: string, projectId: string, now: string): void {
    try {
      const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get()
      if (table === undefined) return
      this.db.prepare("UPDATE members SET state = 'departed', updated_at = ? WHERE project_id = ? AND session_id = ?")
        .run(now, projectId, sessionId)
    } catch (error) {
      console.warn(`cadre-employees roster retire skipped reason=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Insert or update one employee, keeping `created_at` across updates. */
  upsert(input: UpsertEmployeeInput, now: string): EmployeeResult<{ employee: EmployeeRecord }> {
    const invalid = validateEmployeeInput(input)
    if (invalid !== undefined) return invalid
    const existing = this.get(input.sessionId)
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return fail('INVALID_ARGUMENT', '该会话已属于其他项目', 'projectId')
    }
    const next = (value: string | null | undefined, current: string | undefined): string | null => {
      if (value === undefined) return current ?? null
      return textOrNull(value) ?? null
    }
    const createdAt = existing?.createdAt ?? now
    try {
      this.db.prepare(`
        INSERT INTO employees (session_id, project_id, display_name, template_id, persona_note,
          preferred_provider_id, preferred_model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_id = excluded.project_id,
          display_name = excluded.display_name,
          template_id = excluded.template_id,
          persona_note = excluded.persona_note,
          preferred_provider_id = excluded.preferred_provider_id,
          preferred_model = excluded.preferred_model,
          updated_at = excluded.updated_at
      `).run(
        input.sessionId,
        input.projectId,
        next(input.displayName, existing?.displayName),
        next(input.templateId, existing?.templateId),
        next(input.personaNote, existing?.personaNote),
        next(input.preferredProviderId, existing?.preferredProviderId),
        next(input.preferredModel, existing?.preferredModel),
        createdAt,
        now,
      )
    } catch (error) {
      return fail('STORAGE_ERROR', `员工保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const employee = this.get(input.sessionId)
    if (employee === undefined) return fail('STORAGE_ERROR', '保存后读取失败', 'sessionId')
    this.syncRosterMember(input, employee.displayName, now)
    return { ok: true, employee }
  }

  /** Delete one employee; a project mismatch leaves the row untouched. */
  delete(sessionId: string, projectId: string): EmployeeResult<{ deleted: true }> {
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return fail('INVALID_ARGUMENT', 'sessionId 不合法', 'sessionId')
    }
    if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) {
      return fail('INVALID_ARGUMENT', 'projectId 不合法', 'projectId')
    }
    const existing = this.get(sessionId)
    if (existing === undefined || existing.projectId !== projectId) {
      return fail('NOT_FOUND', '员工不存在', 'sessionId')
    }
    try {
      this.db.prepare('DELETE FROM employees WHERE session_id = ? AND project_id = ?')
        .run(sessionId, projectId)
    } catch (error) {
      return fail('STORAGE_ERROR', `员工删除失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.retireRosterMember(sessionId, projectId, new Date().toISOString())
    return { ok: true, deleted: true }
  }
}

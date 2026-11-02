/**
 * Read-only task memory for context assembly and on-demand search. Rows are
 * written by the ledger when a task reaches a terminal status; the reader never
 * copies full transcripts or secrets into the context.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'

/** One archived terminal task summary. */
export interface TaskMemorySummary {
  readonly taskId: string
  readonly projectId: string
  readonly name: string
  readonly status: string
  readonly summary: string
  readonly decisions: readonly string[]
  readonly artifacts: readonly string[]
  readonly transcriptRef: string
  readonly updatedAt: string
}

/** One ongoing task projection, kept brief. */
export interface OngoingTask {
  readonly taskId: string
  readonly name: string
  readonly status: string
  readonly preview: string
  readonly assigneeSessionId: string
}

/** Context bundle for supervisors/employees. */
export interface TaskMemoryContext {
  readonly ongoing: readonly OngoingTask[]
  readonly completed: readonly TaskMemorySummary[]
  readonly rendered: string
}

/** Task memory reader over the shared cadre ledger. */
export class TaskMemoryReader {
  readonly #db: DatabaseSync

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath, { readOnly: true })
    this.#db.exec('PRAGMA busy_timeout = 5000')
  }

  /**
   * Build the default context for one actor: ongoing tasks plus relevant
   * completed summaries. Employees only see their own tasks.
   * @param input - project, actor and result limit.
   * @returns structured context and a compact rendered block.
   */
  context(input: {
    readonly projectId: string
    readonly actorSessionId: string
    readonly limit?: number
  }): TaskMemoryContext {
    const role = this.#role(input.projectId, input.actorSessionId)
    const supervisor = role === 'supervisor'
    const limit = Math.min(20, Math.max(1, input.limit ?? 5))
    const ongoing = this.#db.prepare(`SELECT task_id, title, status, body, assignee_session_id FROM tasks
      WHERE project_id = ? AND status NOT IN ('verified', 'failed', 'cancelled')
        AND (? = 1 OR assignee_session_id = ?)
      ORDER BY updated_at DESC LIMIT ?`).all(
      input.projectId, supervisor ? 1 : 0, input.actorSessionId, limit,
    ) as Record<string, unknown>[]
    const completed = this.#db.prepare(`SELECT m.task_id, m.project_id, m.name, m.status, m.summary,
        m.decisions_json, m.artifacts_json, m.transcript_ref, m.updated_at
      FROM task_memory m JOIN tasks t ON t.task_id = m.task_id
      WHERE m.project_id = ? AND (? = 1 OR t.assignee_session_id = ?)
      ORDER BY m.updated_at DESC LIMIT ?`).all(
      input.projectId, supervisor ? 1 : 0, input.actorSessionId, limit,
    ) as Record<string, unknown>[]
    const ongoingRows = ongoing.map(row => ({
      taskId: String(row.task_id), name: String(row.title), status: String(row.status),
      preview: String(row.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200),
      assigneeSessionId: String(row.assignee_session_id),
    }))
    const completedRows = completed.map(memoryFromRow)
    return {
      ongoing: ongoingRows,
      completed: completedRows,
      rendered: renderContext(ongoingRows, completedRows),
    }
  }

  /**
   * Search archived summaries by taskId, name or keyword. Returns summaries only;
   * callers request raw snippets explicitly.
   * @param input - project, actor, query and optional snippet request.
   * @returns matching memories, newest first.
   */
  search(input: {
    readonly projectId: string
    readonly actorSessionId: string
    readonly query: string
    readonly includeSnippet?: boolean
  }): readonly TaskMemorySummary[] {
    const role = this.#role(input.projectId, input.actorSessionId)
    const supervisor = role === 'supervisor'
    const like = `%${input.query.trim()}%`
    const rows = this.#db.prepare(`SELECT m.task_id, m.project_id, m.name, m.status, m.summary,
        m.decisions_json, m.artifacts_json, m.transcript_ref, m.updated_at
      FROM task_memory m JOIN tasks t ON t.task_id = m.task_id
      WHERE m.project_id = ? AND (? = 1 OR t.assignee_session_id = ?)
        AND (m.task_id = ? OR m.name LIKE ? OR m.summary LIKE ? OR m.decisions_json LIKE ?)
      ORDER BY m.updated_at DESC LIMIT 20`).all(
      input.projectId, supervisor ? 1 : 0, input.actorSessionId,
      input.query.trim(), like, like, like,
    ) as Record<string, unknown>[]
    return rows.map(memoryFromRow)
  }

  close(): void {
    this.#db.close()
  }

  #role(projectId: string, sessionId: string): string | undefined {
    const row = this.#db.prepare(`SELECT role FROM members WHERE project_id = ? AND session_id = ?`)
      .get(projectId, sessionId) as { role?: unknown } | undefined
    return typeof row?.role === 'string' ? row.role : undefined
  }
}

function memoryFromRow(row: Record<string, unknown>): TaskMemorySummary {
  return {
    taskId: String(row.task_id), projectId: String(row.project_id), name: String(row.name),
    status: String(row.status), summary: String(row.summary),
    decisions: parseList(row.decisions_json), artifacts: parseList(row.artifacts_json),
    transcriptRef: String(row.transcript_ref), updatedAt: String(row.updated_at),
  }
}

function parseList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown[]
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(item => item !== '') : []
  } catch {
    return []
  }
}

function renderContext(ongoing: readonly OngoingTask[], completed: readonly TaskMemorySummary[]): string {
  const lines: string[] = []
  if (ongoing.length > 0) {
    lines.push('【进行中任务】')
    for (const task of ongoing) lines.push(`- ${task.name}（${task.status}）：${task.preview}`)
  }
  if (completed.length > 0) {
    lines.push('【相关已完成摘要】')
    for (const task of completed) {
      lines.push(`- ${task.name}（${task.status}）：${task.summary}`)
      if (task.artifacts.length > 0) lines.push(`  产物：${task.artifacts.join('；')}`)
    }
  }
  return lines.join('\n')
}

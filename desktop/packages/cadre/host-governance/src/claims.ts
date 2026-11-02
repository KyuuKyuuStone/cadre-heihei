/**
 * Supervisor "already dispatched" claim verification. Claims are checked against
 * the ledger and recorded as JSON lines; this never blocks or rewrites a message.
 * @module
 */
import type { WatchMember, WatchTask } from './types.ts'

/** One claim assertion written to the audit and exposed to the UI. */
export interface ClaimRecord {
  readonly at: string
  readonly projectId: string
  readonly sessionId: string
  readonly seq?: number
  readonly claim: string
  readonly taskIds: readonly string[]
  readonly exists: boolean
  readonly assigneeMatch: boolean
  readonly verdict: 'verified' | 'unverified' | 'historical'
  readonly pending: boolean
  readonly reason?: 'missing' | 'assignee' | 'terminal' | 'cross_project' | 'no_task_id'
  readonly upgraded?: boolean
}

interface SessionEventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
}

/** Ledger access required by the verifier. */
export interface ClaimLedgerPort {
  /** Any task by id, including terminal tasks. */
  task(taskId: string): WatchTask | undefined
  /** Active roster members for the declaring project. */
  members(projectId: string): readonly WatchMember[]
}

const CLAIM_WORDS = /(已派|已安排|已交给|已分配)/u
const TASK_ID = /\b(?:t\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,})\b/giu
const TERMINAL = new Set(['verified', 'failed', 'cancelled'])

/** Extracted, de-duplicated task ids from one message. */
export function extractTaskIds(text: string): string[] {
  return [...new Set([...text.matchAll(TASK_ID)].map(match => match[0].toLowerCase()))]
}

/** Extract readable assistant text from a session event. */
export function messageText(event: SessionEventLike): string {
  if (typeof event.data !== 'object' || event.data === null) return ''
  const data = event.data as { content?: unknown; message?: { content?: unknown } }
  const content = Array.isArray(data.content) ? data.content : data.message?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => {
    if (typeof part !== 'object' || part === null) return []
    const item = part as { type?: unknown; text?: unknown }
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
}

/** Verify supervisor dispatch claims against the ledger. */
export class ClaimVerifier {
  readonly #projectOf: (sessionId: string) => string | undefined
  readonly #ledger: ClaimLedgerPort
  readonly #appendAudit: (record: ClaimRecord) => void
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #pollMs: number
  readonly #onChange: ((record: ClaimRecord) => void) | undefined
  readonly #records: ClaimRecord[] = []
  readonly #timers = new Map<string, unknown>()

  constructor(options: {
    readonly projectOf: (sessionId: string) => string | undefined
    readonly ledger: ClaimLedgerPort
    readonly appendAudit: (record: ClaimRecord) => void
    readonly now?: () => number
    readonly setTimer?: (callback: () => void, ms: number) => unknown
    readonly clearTimer?: (handle: unknown) => void
    readonly pollMs?: number
    readonly onChange?: (record: ClaimRecord) => void
  }) {
    this.#projectOf = options.projectOf
    this.#ledger = options.ledger
    this.#appendAudit = options.appendAudit
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.#clearTimer = options.clearTimer ?? (handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
    this.#pollMs = Math.min(60_000, Math.max(15_000, options.pollMs ?? 15_000))
    this.#onChange = options.onChange
  }

  /** Process one committed session event. Never throws into the event loop. */
  handle(sessionId: string, event: SessionEventLike): void {
    try {
      this.#handle(sessionId, event)
    } catch {
      // Claim audit is observational; a bad message must never block the session.
    }
  }

  /** Recent claims for one project, newest first. */
  snapshot(projectId: string): readonly ClaimRecord[] {
    return this.#records.filter(record => record.projectId === projectId).slice(-50).reverse()
  }

  dispose(): void {
    for (const timer of this.#timers.values()) this.#clearTimer(timer)
    this.#timers.clear()
  }

  #handle(sessionId: string, event: SessionEventLike): void {
    if (event.type !== 'assistant/message') return
    const projectId = this.#projectOf(sessionId)
    if (projectId === undefined) return
    const text = messageText(event)
    const claim = text.match(CLAIM_WORDS)?.[1]
    if (claim === undefined) return
    const taskIds = extractTaskIds(text)
    if (taskIds.length === 0) {
      this.#record({
        at: new Date(this.#now()).toISOString(), projectId, sessionId,
        ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        claim, taskIds: [], exists: false, assigneeMatch: false,
        verdict: 'unverified', pending: false, reason: 'no_task_id',
      })
      return
    }
    const members = this.#ledger.members(projectId)
    const mentioned = members.filter(member => member.displayName.trim() !== '' && text.includes(member.displayName))
    const records = taskIds.map(taskId => this.#verifyTask(projectId, sessionId, claim, taskId, members, mentioned))
    const overall: ClaimRecord = {
      ...records[0]!,
      claim,
      taskIds,
      verdict: records.some(record => record.verdict === 'unverified')
        ? 'unverified'
        : records.every(record => record.verdict === 'historical') ? 'historical' : 'verified',
      exists: records.some(record => record.exists),
      assigneeMatch: records.every(record => record.assigneeMatch),
      pending: records.some(record => record.pending),
      ...(records.find(record => record.reason !== undefined)?.reason === undefined
        ? {} : { reason: records.find(record => record.reason !== undefined)!.reason }),
    }
    this.#record(overall)
    if (overall.pending) this.#scheduleUpgrade(overall)
  }

  #verifyTask(
    projectId: string,
    sessionId: string,
    claim: string,
    taskId: string,
    members: readonly WatchMember[],
    mentioned: readonly WatchMember[],
  ): ClaimRecord {
    const base = {
      at: new Date(this.#now()).toISOString(), projectId, sessionId, claim,
    } as const
    const task = this.#ledger.task(taskId)
    if (task === undefined) {
      return { ...base, taskIds: [taskId], exists: false, assigneeMatch: false, verdict: 'unverified', pending: true, reason: 'missing' }
    }
    if (task.projectId !== projectId) {
      return { ...base, taskIds: [taskId], exists: true, assigneeMatch: false, verdict: 'historical', pending: false, reason: 'cross_project' }
    }
    if (TERMINAL.has(task.status)) {
      return { ...base, taskIds: [taskId], exists: true, assigneeMatch: false, verdict: 'historical', pending: false, reason: 'terminal' }
    }
    const assignee = members.find(member => member.sessionId === task.assigneeSessionId && member.state !== 'departed')
    const expected = mentioned.length > 0 ? mentioned : undefined
    const assigneeMatch = assignee !== undefined && (expected === undefined || expected.some(member => member.sessionId === assignee.sessionId))
    return {
      ...base, taskIds: [taskId], exists: true, assigneeMatch,
      verdict: assigneeMatch ? 'verified' : 'unverified', pending: false,
      ...(assigneeMatch ? {} : { reason: 'assignee' }),
    }
  }

  #scheduleUpgrade(record: ClaimRecord): void {
    const key = `${record.sessionId}:${record.taskIds.join(',')}`
    if (this.#timers.has(key)) return
    const timer = this.#setTimer(() => {
      this.#timers.delete(key)
      const task = record.taskIds.length === 1 ? this.#ledger.task(record.taskIds[0]!) : undefined
      if (task === undefined) return
      const members = this.#ledger.members(record.projectId)
      const verified = members.some(member => member.sessionId === task.assigneeSessionId && member.state !== 'departed')
      const upgraded: ClaimRecord = {
        ...record,
        at: new Date(this.#now()).toISOString(),
        exists: true,
        assigneeMatch: verified,
        verdict: task.projectId !== record.projectId || TERMINAL.has(task.status)
          ? 'historical' : verified ? 'verified' : 'unverified',
        pending: false,
        upgraded: true,
        ...(task.projectId !== record.projectId ? { reason: 'cross_project' as const }
          : TERMINAL.has(task.status) ? { reason: 'terminal' as const }
            : verified ? {} : { reason: 'assignee' as const }),
      }
      this.#record(upgraded)
    }, this.#pollMs)
    this.#timers.set(key, timer)
  }

  #record(record: ClaimRecord): void {
    this.#records.push(record)
    if (this.#records.length > 500) this.#records.splice(0, this.#records.length - 500)
    try {
      this.#appendAudit(record)
    } catch {
      // Audit failure is observational only.
    }
    this.#onChange?.(record)
  }
}

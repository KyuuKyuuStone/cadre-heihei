/**
 * Lightweight token usage ledger. Collects `assistant/message` usage by
 * session/role/task/round, appends JSON lines without message text, and exposes
 * cumulative snapshots plus one automatic 80% threshold signal per task.
 * @module
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Raw usage fields an assistant event may carry. */
export interface UsageTokens {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One persisted usage row, never containing message content. */
export interface UsageRecord {
  readonly kind: 'usage'
  readonly at: string
  readonly projectId: string
  readonly sessionId: string
  readonly role: string
  readonly taskId?: string
  readonly round: number
  readonly uncachedInput: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/** Usage rows written before the four disjoint provider buckets were retained. */
interface LegacyUsageRecord {
  readonly kind: 'usage'
  readonly at: string
  readonly projectId: string
  readonly sessionId: string
  readonly role?: string
  readonly taskId?: string
  readonly round: number
  readonly uncachedInput?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly output?: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/** One completed or failed compaction observation, without summary content. */
export interface CompactionRecord {
  readonly kind: 'compaction'
  readonly at: string
  readonly projectId: string
  readonly sessionId: string
  readonly role: string
  readonly taskId?: string
  readonly round: number | null
  readonly error?: string
}

/** One round aggregate. */
export interface RoundUsage {
  readonly round: number
  readonly uncachedInput: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly compacted: boolean
  readonly compactionCount: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/** Snapshot returned to the host/UI; no text or keys are retained. */
export interface UsageSnapshot {
  readonly taskId?: string
  readonly sessionId?: string
  readonly role?: string
  readonly uncachedInput: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  /** False when a legacy row lacks the exact cache-read/cache-write split. */
  readonly rawUsageComplete: boolean
  readonly compactionCount: number
  /** Successful compactions between turns, which cannot be assigned to a round. */
  readonly unattributedCompactions: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  /** cacheRead / (uncachedInput + cacheRead + cacheWrite), 0 for an empty denominator. */
  readonly cacheHitRatio: number
  readonly rounds: readonly RoundUsage[]
  readonly recent: readonly RoundUsage[]
  readonly top: readonly { readonly kind: string; readonly estimatedTokens: number }[]
}

/** One automatic threshold audit row. */
export interface UsageThresholdRecord {
  readonly kind: 'threshold'
  readonly at: string
  readonly projectId: string
  readonly sessionId: string
  readonly taskId: string
  readonly tokens: number
  readonly threshold: 'task-80%'
  readonly action: 'compress+continue'
}

interface AggregateState {
  role: string | undefined
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  rawUsageComplete: boolean
  compactionCount: number
  unattributedCompactions: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  totalTokens: number
  readonly rounds: Map<number, RoundUsage>
}

/** Cumulative usage state for one task. */
interface TaskState extends AggregateState {
  readonly projectId: string
  readonly sessionId: string
  readonly taskId: string
}

interface SessionState extends AggregateState {
  readonly projectId: string
  readonly sessionId: string
}

interface UsageIdentity {
  readonly projectId: string
  readonly sessionId: string
  readonly role?: string
  readonly taskId?: string
}

/** Advisory task budget used for the cross-round threshold. */
const TASK_BUDGET = 30_000
const WARN_RATIO = 0.8

/** In-memory usage aggregation with append-only JSONL persistence. */
export class TokenUsageLedger {
  readonly #file: string
  readonly #tasks = new Map<string, TaskState>()
  readonly #sessions = new Map<string, SessionState>()
  readonly #warned = new Set<string>()
  readonly #onThreshold: ((record: UsageThresholdRecord) => void) | undefined
  readonly #now: () => number

  constructor(options: {
    readonly file: string
    readonly onThreshold?: (record: UsageThresholdRecord) => void
    readonly now?: () => number
  }) {
    this.#file = options.file
    this.#onThreshold = options.onThreshold
    this.#now = options.now ?? Date.now
    this.#load()
  }

  /**
   * Record one assistant usage observation.
   * @param input - Identity, round and provider usage counters.
   * @returns the persisted usage row, or undefined when usage is absent.
   */
  ingest(input: {
    readonly projectId: string
    readonly sessionId: string
    readonly role: string
    readonly taskId?: string
    readonly round: number
    readonly usage: UsageTokens
  }): UsageRecord | undefined {
    const uncachedInput = positive(input.usage.inputTokens)
    const cacheRead = positive(input.usage.cacheReadTokens)
    const cacheWrite = positive(input.usage.cacheWriteTokens)
    const output = positive(input.usage.outputTokens)
    const cachedTokens = cacheRead + cacheWrite
    const totalTokens = positive(input.usage.totalTokens) || uncachedInput + cachedTokens + output
    if (uncachedInput + output + cachedTokens === 0) return undefined
    const record: UsageRecord = {
      kind: 'usage', at: new Date(this.#now()).toISOString(), projectId: input.projectId,
      sessionId: input.sessionId, role: input.role,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      round: input.round, uncachedInput, cacheRead, cacheWrite, output,
      promptTokens: uncachedInput, cachedTokens, completionTokens: output, totalTokens,
    }
    this.#append(record)
    this.#apply(record)
    return record
  }

  /**
   * Record a compaction end event. Failed attempts stay in JSONL but do not
   * increment completed-compaction counts or mark a round as compacted.
   * @param input - Session identity, current task and the event's owning turn.
   * @returns the persisted compaction row.
   */
  ingestCompaction(input: {
    readonly projectId: string
    readonly sessionId: string
    readonly role: string
    readonly taskId?: string
    readonly round: number | null
    readonly error?: string
  }): CompactionRecord {
    const record: CompactionRecord = {
      kind: 'compaction', at: new Date(this.#now()).toISOString(), projectId: input.projectId,
      sessionId: input.sessionId, role: input.role,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }), round: input.round,
      ...(input.error === undefined ? {} : { error: input.error }),
    }
    this.#append(record)
    this.#applyCompaction(record)
    return record
  }

  /** Cumulative snapshot for one task or session. */
  snapshot(predicate: { readonly taskId?: string; readonly sessionId?: string }, recentLimit = 5): UsageSnapshot {
    const task = predicate.taskId === undefined ? undefined : this.#tasks.get(predicate.taskId)
    const session = predicate.sessionId === undefined ? undefined : this.#sessions.get(predicate.sessionId)
    const state = task ?? session
    const rounds = state === undefined ? [] : [...state.rounds.values()].sort((left, right) => left.round - right.round)
    const denominator = (state?.uncachedInput ?? 0) + (state?.cacheRead ?? 0) + (state?.cacheWrite ?? 0)
    return {
      ...(predicate.taskId === undefined ? {} : { taskId: predicate.taskId }),
      ...(predicate.sessionId === undefined ? {} : { sessionId: predicate.sessionId }),
      ...(state?.role === undefined ? {} : { role: state.role }),
      uncachedInput: state?.uncachedInput ?? 0,
      cacheRead: state?.cacheRead ?? 0,
      cacheWrite: state?.cacheWrite ?? 0,
      output: state?.output ?? 0,
      rawUsageComplete: state?.rawUsageComplete ?? true,
      compactionCount: state?.compactionCount ?? 0,
      unattributedCompactions: state?.unattributedCompactions ?? 0,
      promptTokens: state?.promptTokens ?? 0,
      cachedTokens: state?.cachedTokens ?? 0,
      completionTokens: state?.completionTokens ?? 0,
      totalTokens: state?.totalTokens ?? 0,
      cacheHitRatio: denominator === 0 ? 0 : (state?.cacheRead ?? 0) / denominator,
      rounds,
      recent: rounds.slice(-Math.max(1, recentLimit)),
      // The provider usage only exposes aggregate counters, not per-content
      // attribution; the field stays present so consumers can render an empty
      // top-contribution section without inventing numbers.
      top: [],
    }
  }

  /** Whether a task has crossed the 80% threshold. */
  isPressured(taskId: string): boolean {
    return (this.#tasks.get(taskId)?.totalTokens ?? 0) >= TASK_BUDGET * WARN_RATIO
  }

  #session(input: UsageIdentity): SessionState {
    const existing = this.#sessions.get(input.sessionId)
    if (existing !== undefined) {
      existing.role = input.role ?? existing.role
      return existing
    }
    const created: SessionState = {
      projectId: input.projectId, sessionId: input.sessionId, ...emptyAggregate(input.role),
    }
    this.#sessions.set(input.sessionId, created)
    return created
  }

  #task(input: UsageIdentity & { readonly taskId: string }): TaskState {
    const existing = this.#tasks.get(input.taskId)
    if (existing !== undefined) {
      existing.role = input.role ?? existing.role
      return existing
    }
    const created: TaskState = {
      projectId: input.projectId, sessionId: input.sessionId, taskId: input.taskId,
      ...emptyAggregate(input.role),
    }
    this.#tasks.set(input.taskId, created)
    return created
  }

  #apply(record: UsageRecord | LegacyUsageRecord, emit = true): void {
    applyUsage(this.#session(record), record)
    if (record.taskId === undefined) return
    const task = this.#task({ ...record, taskId: record.taskId })
    applyUsage(task, record)
    if (emit && !this.#warned.has(record.taskId) && task.totalTokens >= TASK_BUDGET * WARN_RATIO) {
      this.#warned.add(record.taskId)
      const signal: UsageThresholdRecord = {
        kind: 'threshold', at: new Date(this.#now()).toISOString(), projectId: record.projectId,
        sessionId: record.sessionId, taskId: record.taskId, tokens: task.totalTokens,
        threshold: 'task-80%', action: 'compress+continue',
      }
      this.#append(signal)
      this.#onThreshold?.(signal)
    }
  }

  #applyCompaction(record: CompactionRecord): void {
    if (record.error !== undefined) return
    applyCompaction(this.#session(record), record.round)
    if (record.taskId !== undefined) {
      applyCompaction(this.#task({ ...record, taskId: record.taskId }), record.round)
    }
  }

  #append(value: UsageRecord | CompactionRecord | UsageThresholdRecord): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      appendFileSync(this.#file, `${JSON.stringify(value)}\n`, 'utf8')
    } catch {
      // Usage telemetry must never fail a model turn.
    }
  }

  #load(): void {
    if (!existsSync(this.#file)) return
    try {
      for (const line of readFileSync(this.#file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const value = JSON.parse(line) as UsageRecord | LegacyUsageRecord | CompactionRecord | UsageThresholdRecord
        if (value.kind === 'usage') this.#apply(value, false)
        if (value.kind === 'compaction') this.#applyCompaction(value)
      }
    } catch {
      // A corrupt telemetry file is ignored; live collection continues.
    }
  }
}

function emptyAggregate(role: string | undefined): AggregateState {
  return {
    role, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    rawUsageComplete: true, compactionCount: 0, unattributedCompactions: 0,
    promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0, rounds: new Map(),
  }
}

function applyUsage(state: AggregateState, record: UsageRecord | LegacyUsageRecord): void {
  const exact = hasRawUsage(record)
  state.promptTokens += record.promptTokens
  state.cachedTokens += record.cachedTokens
  state.completionTokens += record.completionTokens
  state.totalTokens += record.totalTokens
  if (exact) {
    state.uncachedInput += record.uncachedInput
    state.cacheRead += record.cacheRead
    state.cacheWrite += record.cacheWrite
    state.output += record.output
  } else {
    // cachedTokens in old rows combines reads and writes. Preserve the legacy
    // totals but exclude that unknowable split from the new raw-bucket ratio.
    state.rawUsageComplete = false
  }
  const previous = state.rounds.get(record.round) ?? emptyRound(record.round)
  state.rounds.set(record.round, {
    ...previous,
    uncachedInput: previous.uncachedInput + (exact ? record.uncachedInput : 0),
    cacheRead: previous.cacheRead + (exact ? record.cacheRead : 0),
    cacheWrite: previous.cacheWrite + (exact ? record.cacheWrite : 0),
    output: previous.output + (exact ? record.output : 0),
    promptTokens: previous.promptTokens + record.promptTokens,
    cachedTokens: previous.cachedTokens + record.cachedTokens,
    completionTokens: previous.completionTokens + record.completionTokens,
    totalTokens: previous.totalTokens + record.totalTokens,
  })
}

function applyCompaction(state: AggregateState, round: number | null): void {
  state.compactionCount++
  if (round === null) {
    state.unattributedCompactions++
    return
  }
  const previous = state.rounds.get(round) ?? emptyRound(round)
  state.rounds.set(round, {
    ...previous, compacted: true, compactionCount: previous.compactionCount + 1,
  })
}

function emptyRound(round: number): RoundUsage {
  return {
    round, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    compacted: false, compactionCount: 0,
    promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
  }
}

function hasRawUsage(record: UsageRecord | LegacyUsageRecord): record is UsageRecord {
  return typeof record.role === 'string'
    && isCounter(record.uncachedInput) && isCounter(record.cacheRead)
    && isCounter(record.cacheWrite) && isCounter(record.output)
}

function isCounter(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

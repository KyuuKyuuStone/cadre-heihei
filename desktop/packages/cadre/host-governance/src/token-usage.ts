/**
 * Lightweight token usage ledger. Collects `assistant/message` usage by
 * session/task/round, appends JSON lines without message text, and exposes
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
  readonly taskId?: string
  readonly round: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/** One round aggregate. */
export interface RoundUsage {
  readonly round: number
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

/** Snapshot returned to the host/UI; no text or keys are retained. */
export interface UsageSnapshot {
  readonly taskId?: string
  readonly sessionId?: string
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
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

/** Cumulative usage state for one task. */
interface TaskState {
  readonly projectId: string
  readonly sessionId: string
  readonly taskId: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  totalTokens: number
  readonly rounds: Map<number, RoundUsage>
}

/** Advisory task budget used for the cross-round threshold. */
const TASK_BUDGET = 30_000
const WARN_RATIO = 0.8

/** In-memory usage aggregation with append-only JSONL persistence. */
export class TokenUsageLedger {
  readonly #file: string
  readonly #tasks = new Map<string, TaskState>()
  readonly #sessions = new Map<string, { promptTokens: number; cachedTokens: number; completionTokens: number; totalTokens: number }>()
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
    readonly taskId?: string
    readonly round: number
    readonly usage: UsageTokens
  }): UsageRecord | undefined {
    const promptTokens = positive(input.usage.inputTokens)
    const cachedTokens = positive(input.usage.cacheReadTokens) + positive(input.usage.cacheWriteTokens)
    const completionTokens = positive(input.usage.outputTokens)
    const totalTokens = positive(input.usage.totalTokens) || promptTokens + cachedTokens + completionTokens
    if (promptTokens + completionTokens + cachedTokens === 0) return undefined
    const record: UsageRecord = {
      kind: 'usage', at: new Date(this.#now()).toISOString(), projectId: input.projectId,
      sessionId: input.sessionId, ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      round: input.round, promptTokens, cachedTokens, completionTokens, totalTokens,
    }
    this.#append(record)
    this.#apply(record)
    return record
  }

  /** Cumulative snapshot for one task or session. */
  snapshot(predicate: { readonly taskId?: string; readonly sessionId?: string }, recentLimit = 5): UsageSnapshot {
    const task = predicate.taskId === undefined ? undefined : this.#tasks.get(predicate.taskId)
    const session = predicate.sessionId === undefined ? undefined : this.#sessions.get(predicate.sessionId)
    const rounds = task === undefined ? [] : [...task.rounds.values()].sort((left, right) => left.round - right.round)
    return {
      ...(predicate.taskId === undefined ? {} : { taskId: predicate.taskId }),
      ...(predicate.sessionId === undefined ? {} : { sessionId: predicate.sessionId }),
      promptTokens: task?.promptTokens ?? session?.promptTokens ?? 0,
      cachedTokens: task?.cachedTokens ?? session?.cachedTokens ?? 0,
      completionTokens: task?.completionTokens ?? session?.completionTokens ?? 0,
      totalTokens: task?.totalTokens ?? session?.totalTokens ?? 0,
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

  #apply(record: UsageRecord, emit = true): void {
    const session = this.#sessions.get(record.sessionId) ?? {
      promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
    }
    session.promptTokens += record.promptTokens
    session.cachedTokens += record.cachedTokens
    session.completionTokens += record.completionTokens
    session.totalTokens += record.totalTokens
    this.#sessions.set(record.sessionId, session)
    if (record.taskId === undefined) return
    const task = this.#tasks.get(record.taskId) ?? {
      projectId: record.projectId, sessionId: record.sessionId, taskId: record.taskId,
      promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
      rounds: new Map(),
    }
    task.promptTokens += record.promptTokens
    task.cachedTokens += record.cachedTokens
    task.completionTokens += record.completionTokens
    task.totalTokens += record.totalTokens
    const round = task.rounds.get(record.round) ?? {
      round: record.round, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0,
    }
    task.rounds.set(record.round, {
      round: record.round,
      promptTokens: round.promptTokens + record.promptTokens,
      cachedTokens: round.cachedTokens + record.cachedTokens,
      completionTokens: round.completionTokens + record.completionTokens,
      totalTokens: round.totalTokens + record.totalTokens,
    })
    this.#tasks.set(record.taskId, task)
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

  #append(value: UsageRecord | UsageThresholdRecord): void {
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
        const value = JSON.parse(line) as UsageRecord | UsageThresholdRecord
        if (value.kind === 'usage') this.#applyLoaded(value)
      }
    } catch {
      // A corrupt telemetry file is ignored; live collection continues.
    }
  }

  #applyLoaded(record: UsageRecord): void {
    this.#apply(record, false)
  }
}

function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

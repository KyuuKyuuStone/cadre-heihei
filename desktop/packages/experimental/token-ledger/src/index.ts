/**
 * Token usage ledger plugin: mirrors provider usage already committed on
 * `assistant/message` events into `plugin:token-ledger/usage` records and
 * answers per-Session and process-wide cumulative totals from them.
 *
 * The record is an ignorable plugin record. It never enters the model-visible
 * surface, does not change `SESSION_FORMAT_VERSION`, and survives surface
 * compaction, fork, and resume; a reader without this plugin retains and skips
 * it. The ledger keeps the provider's exact token buckets, so its totals are
 * additive across turns and reprocessable after a restart.
 *
 * @module @deepseek-ai/dsh-experimental-token-ledger
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord,
  pluginRecordOf,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  TokenLedgerEntry,
  TokenLedgerGlobalReport,
  TokenLedgerReport,
  TokenLedgerState,
  TokenLedgerTotals,
  TokenUsageRecord,
} from './types.ts'

/** The projection key owning one Session's folded ledger. */
const PROJECTION_KEY = 'tokenLedger'

/** Provider buckets as a durable read may spell them: absent or explicitly undefined. */
interface UsageBuckets {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number | undefined
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
}

/** A stored sequence number, branded on read from the durable log. */
const seqSchema = z.number().int().nonnegative().transform((value): SessionSeq => SessionSeq(value))

/** Provider-reported buckets, normalized to the {@link TokenUsage} contract. */
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
}).strict().transform((usage): TokenUsage => copyUsage(usage))

/** The durable record payload; a restored record carries what an earlier build wrote. */
const recordSchema = z.object({
  sourceSeq: seqSchema,
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  usage: usageSchema,
}).strict()

/** One folded row, including the ledger record's own position and commit time. */
const entrySchema = z.object({
  sourceSeq: seqSchema,
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  usage: usageSchema,
  seq: seqSchema,
  time: z.number().int().nonnegative(),
}).strict()

/** Cumulative counts folded from ledger rows. */
const totalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  billedTokens: z.number().int().nonnegative(),
}).strict()

/** Validates a persisted projection checkpoint before it seeds a fold. */
const ledgerStateSchema: z.ZodType<TokenLedgerState> = z.object({
  entries: z.array(entrySchema),
  totals: totalsSchema,
}).strict()

/**
 * Copy the provider's buckets without undefined-valued properties, which are
 * not losslessly JSON-serializable.
 * @param usage - provider-reported buckets of one model call.
 * @returns a copy carrying exactly the reported buckets.
 */
function copyUsage(usage: UsageBuckets): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
    ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
    ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
  }
}

/**
 * The billed total of one model call: the disjoint input, cache, and output
 * buckets. Reasoning tokens are part of `outputTokens` and are not added again.
 * @param usage - provider-reported buckets of one model call.
 * @returns the billable token count.
 */
function billedTokensOf(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens
    + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** All-zero totals, the value for a Session without ledger records. */
function zeroTotals(): TokenLedgerTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    billedTokens: 0,
  }
}

/**
 * Add one model call's buckets to running totals.
 * @param totals - totals before the call.
 * @param usage - provider-reported buckets of the call.
 * @returns totals including the call.
 */
function addUsage(totals: TokenLedgerTotals, usage: TokenUsage): TokenLedgerTotals {
  return {
    requests: totals.requests + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (usage.reasoningTokens ?? 0),
    billedTokens: totals.billedTokens + billedTokensOf(usage),
  }
}

/**
 * Add two totals values.
 * @param left - one totals set.
 * @param right - the other totals set.
 * @returns the elementwise sum.
 */
function addTotals(left: TokenLedgerTotals, right: TokenLedgerTotals): TokenLedgerTotals {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    billedTokens: left.billedTokens + right.billedTokens,
  }
}

/** The state of a Session with no ledger records. */
function emptyState(): TokenLedgerState {
  return { entries: [], totals: zeroTotals() }
}

/**
 * Fold one committed event into a Session's ledger: ledger records append a
 * row, every other event leaves the state reference unchanged. A duplicate
 * record for an already-counted source event (two recorder instances, or a
 * record appended after its source was already folded) is ignored.
 * @param state - state covering every prior event.
 * @param event - the next committed Session event.
 * @returns the next state, or `state` itself when the event is not a new record.
 * @throws when a committed record does not satisfy the ledger payload schema.
 */
function foldEvent(state: TokenLedgerState, event: SessionEvent): TokenLedgerState {
  const record = pluginRecordOf(event)
  if (record?.type !== 'plugin:token-ledger/usage') return state
  const parsed = recordSchema.safeParse(record.data)
  if (!parsed.success) {
    throw new Error(`token-ledger: invalid usage record at seq ${record.seq}: ${parsed.error.message}`)
  }
  if (state.entries.some(entry => entry.sourceSeq === parsed.data.sourceSeq)) return state
  const entry: TokenLedgerEntry = { ...parsed.data, seq: record.seq, time: record.time }
  return { entries: [...state.entries, entry], totals: addUsage(state.totals, entry.usage) }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Replay-aware token usage ledger; see {@link TokenLedger}. */
    tokenLedger: TokenLedger
  }
}

/**
 * `ctx.tokenLedger`: records provider usage as ignorable plugin records and
 * answers cumulative totals from those records.
 *
 * Totals are per Session log — live or retired — and process-wide over every
 * Session this process has observed. The process-wide view is intentionally
 * not durable across restarts: a restart recovers per-Session totals from each
 * Session's records when that Session is opened, and the global total starts
 * from the Sessions this process observes.
 *
 * The plugin is an effect-driven contribution: unloading its fiber removes the
 * projection unit and the event listener, so later turns append no records.
 */
export default class TokenLedger extends Service {
  static inject = ['sessions', 'sessionProjections']

  /** Folded state of Sessions that were disposed while this process ran. */
  private readonly retired = new Map<string, TokenLedgerState>()

  /**
   * Install the ledger projection unit, the usage recorder, and the disposal
   * snapshot that keeps a closed Session's totals queryable.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'tokenLedger')
    ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateSchema: ledgerStateSchema,
      stateVersion: 1,
      init: () => emptyState(),
      apply: foldEvent,
    })
    ctx.on('session/created', (session: Session) => {
      this.retired.delete(session.id)
    })
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.capture(session, event)
    })
    ctx.on('session/disposed', (session: Session) => {
      this.retire(session)
    })
  }

  /**
   * Read one live Session's ledger.
   * @param session - the live Session to report.
   * @returns its entries in commit order and their aggregate totals.
   */
  get(session: Session): TokenLedgerReport {
    return this.report(session.id, this.stateOf(session))
  }

  /**
   * Read a ledger by Session id, including a Session this process already
   * disposed.
   * @param sessionId - the Session to report.
   * @returns the report, or `undefined` when this process never observed it.
   */
  forSession(sessionId: SessionId): TokenLedgerReport | undefined {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return this.get(live)
    const retired = this.retired.get(sessionId)
    return retired === undefined ? undefined : this.report(sessionId, retired)
  }

  /**
   * Read cumulative totals across every Session this process has observed:
   * every live Session plus every Session disposed during this process.
   * @returns the contributing Session count and the process-wide totals.
   */
  global(): TokenLedgerGlobalReport {
    let totals = zeroTotals()
    let sessions = 0
    for (const session of this.ctx.sessions.list()) {
      const state = this.stateOf(session)
      if (state.totals.requests === 0) continue
      sessions += 1
      totals = addTotals(totals, state.totals)
    }
    for (const state of this.retired.values()) {
      if (state.totals.requests === 0) continue
      sessions += 1
      totals = addTotals(totals, state.totals)
    }
    return { sessions, totals }
  }

  /**
   * Mirror one committed `assistant/message` into a ledger record. The append
   * is deferred to a microtask because the Session refuses to publish a new
   * event from inside its own publication, where observers run.
   * @param session - the Session that committed the event.
   * @param event - the committed event.
   */
  private capture(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    const usage = event.data.usage
    if (usage === undefined) return
    const record: TokenUsageRecord = {
      sourceSeq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
      usage: copyUsage(usage),
    }
    queueMicrotask(() => {
      this.write(session, record)
    })
  }

  /**
   * Append one ledger record to a still-live Session. A Session disposed
   * before the deferred append ran loses that record; the failure is logged
   * and never rethrown into the microtask queue.
   * @param session - the Session that committed the mirrored usage.
   * @param record - the validated payload to append.
   */
  private write(session: Session, record: TokenUsageRecord): void {
    if (this.ctx.sessions.get(session.id) !== session) return
    try {
      appendPluginRecord(session, 'plugin:token-ledger/usage', record)
    } catch (error) {
      this.ctx.logger.warn('token-ledger: could not record usage for Session %s: %o', session.id, error)
    }
  }

  /**
   * Keep a disposed Session's folded totals queryable for the rest of the
   * process.
   * @param session - the Session being disposed.
   */
  private retire(session: Session): void {
    const state = this.ctx.sessionProjections.stateOf(session, PROJECTION_KEY)
    if (state !== undefined) this.retired.set(session.id, state)
  }

  /**
   * Read one Session's folded state, materializing it on first touch.
   * @param session - the Session whose state is read.
   * @returns the folded state, or the empty state when the unit is absent.
   */
  private stateOf(session: Session): TokenLedgerState {
    return this.ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? emptyState()
  }

  /**
   * Build the immutable report for one Session.
   * @param sessionId - the reported Session.
   * @param state - its folded state.
   * @returns the report.
   */
  private report(sessionId: SessionId, state: TokenLedgerState): TokenLedgerReport {
    return { sessionId, entries: state.entries, totals: state.totals }
  }
}

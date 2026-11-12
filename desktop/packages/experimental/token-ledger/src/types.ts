/**
 * Public records and query results of the token usage ledger.
 *
 * @module @deepseek-ai/dsh-experimental-token-ledger/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Durable payload of one `plugin:token-ledger/usage` record: the provider
 * usage already committed by one `assistant/message` event, copied into the
 * plugin namespace so later queries survive compaction of the model-visible
 * surface.
 */
export interface TokenUsageRecord {
  /** Sequence of the `assistant/message` event whose provider usage this record mirrors. */
  readonly sourceSeq: SessionSeq
  /** Turn number copied from the mirrored `assistant/message` event. */
  readonly turn: number
  /** Step number copied from the mirrored `assistant/message` event. */
  readonly step: number
  /** Provider route that produced the mirrored usage. */
  readonly provider: string
  /** Exact model id that produced the mirrored usage. */
  readonly model: string
  /** Provider-reported token buckets, disjoint as defined by {@link TokenUsage}. */
  readonly usage: TokenUsage
}

/** One folded ledger row, identified by its own event sequence and commit time. */
export interface TokenLedgerEntry extends TokenUsageRecord {
  /** Sequence of the ledger record itself, distinct from {@link sourceSeq}. */
  readonly seq: SessionSeq
  /** Commit time of the ledger record. */
  readonly time: number
}

/**
 * Additive token counts over a set of ledger entries; every count is zero when the set is empty.
 *
 * A provider-supplied `totalTokens` is not aggregated: a record may omit it, so a sum would add
 * complete and partial call totals together.
 */
export interface TokenLedgerTotals {
  /** Number of mirrored provider calls. */
  readonly requests: number
  /** Sum of uncached input tokens. */
  readonly inputTokens: number
  /** Sum of output tokens. */
  readonly outputTokens: number
  /** Sum of cache-read input tokens. */
  readonly cacheReadTokens: number
  /** Sum of cache-write input tokens. */
  readonly cacheWriteTokens: number
  /** Sum of reasoning tokens, which are already part of {@link outputTokens}. */
  readonly reasoningTokens: number
  /** Sum of the disjoint input, cache, and output buckets that providers bill. */
  readonly billedTokens: number
}

/** Ledger view of one Session. */
export interface TokenLedgerReport {
  /** Session whose durable log owns these records. */
  readonly sessionId: SessionId
  /** One row per mirrored provider call, in commit order. */
  readonly entries: readonly TokenLedgerEntry[]
  /** Aggregate over {@link entries}. */
  readonly totals: TokenLedgerTotals
}

/** Ledger view across every Session this service process has observed. */
export interface TokenLedgerGlobalReport {
  /** Sessions contributing to {@link totals}: live ones plus disposed ones observed by this process. */
  readonly sessions: number
  /** Aggregate over every contributing Session's ledger records. */
  readonly totals: TokenLedgerTotals
}

/**
 * Folded ledger state of one Session: the projection unit's plain-JSON value,
 * checkpointable and rebuildable from the Session log.
 */
export interface TokenLedgerState {
  /** One row per mirrored provider call, in commit order. */
  readonly entries: readonly TokenLedgerEntry[]
  /** Aggregate over {@link entries}. */
  readonly totals: TokenLedgerTotals
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Provider usage of one completed assistant step, retained outside the model-visible surface. */
    'plugin:token-ledger/usage': TokenUsageRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded token usage ledger of one Session. */
    tokenLedger: TokenLedgerState
  }
}

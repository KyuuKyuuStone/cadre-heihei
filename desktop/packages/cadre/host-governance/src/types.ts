/**
 * Stall watchdog for Cadre tasks (DF-014).
 *
 * Activity comes from real Session events and `task_events.at`; `tasks.updated_at`
 * is only a scan hint. No table, column, or Session event type is added.
 * @module @deepseek-ai/dsh-host-governance
 */

/** Stall thresholds and scan cadence; overridable from the plugin row config. */
export interface StallConfig {
  readonly suspectAfterMs: number
  readonly stalledAfterMs: number
  readonly recoverAfterMs: number
  readonly scanIntervalMs: number
  readonly consecutiveSamples: number
  readonly nudgeCooldownMs: number
  readonly escalateAfterMs: number
  readonly maxGoalRounds: number
}

/** Defaults match `前端-停摆治理交互规格.md`. */
export const DEFAULT_STALL_CONFIG: StallConfig = {
  suspectAfterMs: 180_000,
  stalledAfterMs: 600_000,
  recoverAfterMs: 30_000,
  scanIntervalMs: 15_000,
  consecutiveSamples: 2,
  nudgeCooldownMs: 60_000,
  escalateAfterMs: 1_800_000,
  maxGoalRounds: 20,
}

/** Task statuses that can stall; `delivered/review` wait for a human. */
export const STALLABLE_STATUSES = ['dispatched', 'accepted', 'in_progress', 'rework'] as const

/** Public stall states. */
export type StallState = 'normal' | 'possibly_stalled' | 'stalled'

/** Last-activity provenance, matching the front-end contract. */
export type ActivityKind = 'assistant' | 'tool' | 'report' | 'status'

/** One task row the watchdog needs from the ledger. */
export interface WatchTask {
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly dispatcherSessionId: string
  readonly version: number
  readonly updatedAt: string
  /** Dispatch or latest rework epoch ms; questions before it are historical. */
  readonly windowStartAt: number
}

/** Roster row used for permissions and display. */
export interface WatchMember {
  readonly sessionId: string
  readonly role: string
  readonly state: string
  readonly displayName: string
}

/** Activity resolved for one employee Session. */
export interface SessionActivity {
  readonly lastActivityAt?: number
  readonly kind?: ActivityKind
  /** True while an unanswered `ask_user_question` call owns the turn (DF-011). */
  readonly waitingQuestion: boolean
  /** Active step class from the additive turn lifecycle events. */
  readonly stepKind?: 'model_generation' | 'tool_execution'
  /** When the active step started (epoch ms). */
  readonly stepSince?: number
  /** Tool name when `stepKind` is `tool_execution`. */
  readonly toolName?: string
  /** A compaction window is open; stall detection pauses until it closes. */
  readonly compactionActive?: boolean
  /** First non-terminal chunk of the active model call (epoch ms). */
  readonly firstTokenAt?: number
  /** Output tokens observed for the active step, when a usage-bearing event exists. */
  readonly tokensSoFar?: number
  /** Seq of the event that establishes the active step / last activity. */
  readonly evidenceEventSeq?: number
  /** Seq of the latest real activity event (fallback for no_events). */
  readonly lastActivitySeq?: number
  /** True when the log predates additive turn lifecycle events. */
  readonly inferred?: boolean
}

/** Machine-readable basis for a stall/nudge decision. */
export interface StallBasis {
  readonly kind: 'model_generation' | 'tool_execution' | 'no_events'
  /** ISO UTC timestamp of the step or last activity. */
  readonly since: string
  readonly stepKind: 'model_generation' | 'tool_execution' | null
  readonly toolName: string | null
  readonly elapsedMs: number
  readonly heartbeatAgeMs: number
  readonly evidenceEventSeq: number | null
}

/** Task view returned to the Host/IPC surface. */
export interface StallTaskView {
  readonly taskId: string
  readonly title: string
  readonly taskStatus: string
  readonly assigneeSessionId: string
  readonly assigneeName: string
  readonly assigneeRole: string
  readonly lastActivityAt: number | null
  readonly lastActivityKind: ActivityKind | null
  readonly silenceMs: number | null
  readonly stallState: StallState | 'waiting_question'
  readonly stateSince: number
  readonly episodeId: string
  readonly nudgeCount: number
  readonly lastNudgedAt: number | null
  readonly suggestedAction: 'nudge' | 'reassign' | 'cancel' | 'escalate' | null
  readonly capabilities: { readonly nudge: boolean; readonly reassign: boolean; readonly cancel: boolean; readonly escalate: boolean }
  readonly version: number
  readonly stale: boolean
  readonly updatedAt: string
  /** Age of the active step; null when no step is active. */
  readonly elapsedMs: number | null
  /** Runtime heartbeat timestamp for the active step; null for old/no-step logs. */
  readonly heartbeatAt: number | null
  /** First token of the active model call; null when absent or not generated yet. */
  readonly firstTokenAt: number | null
  /** Output tokens observed so far, when the log carries usage. */
  readonly tokensSoFar: number | null
  /** Decision basis for the current state (also present for no_events). */
  readonly stallBasis: StallBasis | null
  /** True when additive turn events are absent and the view is inferred. */
  readonly inferred: boolean
}

/** Supported supervisor actions. */
export type StallAction = 'nudge' | 'reassign' | 'cancel' | 'escalate'

/** One action request; `expectedVersion` is the task view version. */
export interface StallActionRequest {
  readonly action: StallAction
  readonly projectId: string
  readonly taskId: string
  readonly episodeId: string
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly actorSessionId: string
  readonly toSessionId?: string
  readonly reason?: string
}

/** Action result; `ok:false` is surfaced to the caller, never swallowed. */
export type StallActionResult =
  | { readonly ok: true; readonly action: StallAction; readonly version: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Goal identity the plugin needs; the live activation is process-local. */
export interface GoalState {
  readonly id: string
  readonly revision: number
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly activation: 'armed' | 'disarmed'
}

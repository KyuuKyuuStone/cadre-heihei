/**
 * EnginePort: the four official engine capability groups the product layer may
 * call (models, sessions, presets, turn flow), expressed without policy.
 *
 * Every method forwards one documented official surface and returns its result
 * unchanged: no retry, no cache, no sorting or filtering, no state merging, no
 * business meaning (task states, acceptance, employee identity live above this
 * interface). Failures are values; the `code` is the official error code
 * whenever an official code exists.
 *
 * @module @deepseek-ai/dsh-cadre-engine/types
 */
import type { AgentPresetDocument, AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {
  ModelCatalog, ModelSelection, PromptContentPart, SessionAssistantStreamFrame, SessionCancelValue,
  SessionCreateValue, SessionListValue, SessionProjectionsValue, SessionPromptValue, SessionRenameValue,
  SessionRequestId, SessionWireHeader, SessionProjectionBaseline,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** One structured failure; official error codes pass through unchanged. */
export interface EngineError {
  /** Official error code, or `ENGINE_UNAVAILABLE` when the transport itself failed. */
  readonly code: string
  /** Human-readable diagnostic, never a user-facing command. */
  readonly message: string
  /** Request field the failure names, when the official failure carries one. */
  readonly field?: string
}

/** Success carries a value; failure carries an error. Neither throws. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineError }

/** One Session row; both bindings return the official summary untouched. */
export interface SessionState {
  /** List row, `undefined` when the Session is absent from the list surface. */
  readonly summary: SessionListValue['items'][number] | undefined
  /** Exact projection read; `null` when the Session has no stored projections. */
  readonly projections: SessionProjectionsValue
}

/** Engine-side read of one Session; task status is not part of this value. */
export type SessionSummaryView = SessionListValue['items'][number]

/** Model catalogue and its model-selection port. */
export interface ModelPort {
  /**
   * List routable models.
   * Official: Session Remote `modelCatalog`.
   * @returns groups, default selection, and per-provider failures unchanged.
   */
  listModels(): Promise<Result<ModelCatalog>>
  /**
   * Select one Session's model and record it as the default selection.
   * Official: Session Remote `selectModel`.
   * @param request - Session plus provider/model/reasoning choice.
   * @returns the Host-resolved selection.
   */
  selectModel(request: {
    readonly sessionId: SessionId
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<Result<{ readonly selected: ModelSelection }>>
}

/** Session lifecycle and state reads. */
export interface SessionPort {
  /**
   * List Sessions.
   * Official: Session Remote `list`.
   * @param query - optional opaque cursor.
   * @returns official summaries in Host order.
   */
  listSessions(query?: { readonly cursor?: string }): Promise<Result<readonly SessionSummaryView[]>>
  /**
   * Create (or reuse a blank) Session.
   * Official: Session Remote `create`.
   * @param request - target workspace/cwd and optional preset.
   * @returns the created or reused Session identity.
   */
  createSession(request: {
    readonly workspaceId?: WorkspaceId
    readonly cwd?: string
    readonly agentPreset?: string
  }): Promise<Result<SessionCreateValue>>
  /**
   * Rename one Session.
   * Official: Session Remote `rename`.
   * @param sessionId - Session to rename.
   * @param title - new title.
   * @returns the normalized title and its event position.
   */
  renameSession(sessionId: SessionId, title: string): Promise<Result<SessionRenameValue>>
  /**
   * Read one Session's list row and projections.
   * Official: Session Remote `list` and `projections`.
   * @param sessionId - Session to read.
   * @returns engine facts only; absence is reported as `summary: undefined`.
   */
  getSessionState(sessionId: SessionId): Promise<Result<SessionState>>
  /**
   * Subscribe to Session-list invalidations.
   * Official: Client `ctx.sessions.list` store (client binding) or Session
   * Remote `control` projection frames (host binding).
   * @param listener - receives the identity of each invalidated Session.
   * @returns unsubscribe function.
   */
  watchSessions(listener: (change: { readonly sessionId: SessionId }) => void): () => void
}

/** Agent-preset (employee template) reads and selection. */
export interface PresetPort {
  /**
   * List the whole preset roster.
   * Official: agent-preset Remote `agentPresets/list`.
   * @returns every declaration, including activation failures.
   */
  listPresets(): Promise<Result<readonly AgentPresetRow[]>>
  /**
   * Read one preset's declared composition.
   * Official: agent-preset Remote `agentPresets/read`.
   * @param presetId - preset identity.
   * @returns the rendered composition and published metadata.
   */
  readPreset(presetId: string): Promise<Result<AgentPresetDocument>>
  /**
   * Apply a preset to one Session.
   * Official: agent-preset Remote `agentPresets/select`.
   * @param sessionId - target Session.
   * @param presetId - preset to compose.
   * @returns the applied preset identity.
   */
  applyPreset(sessionId: SessionId, presetId: string): Promise<Result<{ readonly agentPreset: string }>>
}

/** One normalized follow frame; official frame names are preserved as `kind`. */
export type TurnFrame =
  | {
    readonly kind: 'opening'
    readonly cursor: number
    readonly header: SessionWireHeader
    readonly projections: SessionProjectionBaseline
  }
  | {
    readonly kind: 'event'
    readonly seq: number
    readonly type: string
    readonly data: JsonValue
  }
  | { readonly kind: 'assistant'; readonly frame: SessionAssistantStreamFrame }

/** Turn admission, cancellation, and the session event stream. */
export interface TurnPort {
  /**
   * Admit one prompt to the Session's Agent.
   * Official: Session Remote `prompt`.
   * @param request - target Session, client-minted request id, delivery mode, and content.
   * @returns the admission receipt.
   */
  runTurn(request: {
    readonly sessionId: SessionId
    readonly requestId: SessionRequestId
    readonly mode: 'queue' | 'steer'
    readonly content: readonly PromptContentPart[]
    readonly clientTimeZone?: string
  }): Promise<Result<SessionPromptValue>>
  /**
   * Cancel the Session's current turn.
   * Official: Session Remote `cancel`.
   * @param sessionId - Session to cancel.
   * @returns the cancellation receipt.
   */
  cancelTurn(sessionId: SessionId): Promise<Result<SessionCancelValue>>
  /**
   * Follow a Session's durable event log and live assistant stream.
   * Official: Session Remote `follow`.
   * @param request - target Session and abort signal.
   * @returns frames in official order; stream failures reject the iterator.
   */
  followTurn(request: {
    readonly sessionId: SessionId
    readonly signal: AbortSignal
  }): AsyncIterable<TurnFrame>
}

/** The four-port adapter surface. */
export interface EnginePort {
  readonly models: ModelPort
  readonly sessions: SessionPort
  readonly presets: PresetPort
  readonly turns: TurnPort
}

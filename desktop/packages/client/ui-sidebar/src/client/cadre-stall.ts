/**
 * DF-014 stall view adapter.
 *
 * Reads the host-governance snapshot route and posts its action route. This
 * module keeps the actual task fields (including epoch-ms activity times) and
 * the real request fields at one boundary; it owns no stall state transition.
 */
import type { SidebarKey } from './locales.ts'

type Translate = (key: SidebarKey, params?: Record<string, unknown>) => string

/** Host stall states plus the waiting-question display state. */
export type CadreStallLevel = 'normal' | 'possibly_stalled' | 'stalled' | 'waiting_question'

export type CadreStallActivityKind = 'assistant' | 'tool' | 'report' | 'status'

/** Execution states from the design; no_events is the only state that may stall. */
export type CadreExecutionState = 'model_generation' | 'tool_execution' | 'no_events' | 'waiting_question'

/** DF-017 pending: structured last tool error is not exposed by host-governance yet. */
export interface CadreStallError {
  readonly code: string
  readonly message: string
  /** ISO-8601 UTC timestamp; display converts it to the local zone. */
  readonly at: string
}

/** Derived display view over the real flat host fields. */
export interface CadreExecutionView {
  readonly state: CadreExecutionState
  readonly stepKind?: 'model_generation' | 'tool_execution'
  readonly toolName?: string | null
  readonly startedAt?: number | null
  readonly elapsedMs?: number | null
  readonly heartbeatAt?: number | null
  readonly firstTokenAt?: number | null
  readonly tokensSoFar?: number | null
}

/** Machine-readable basis carried by the real view and nudge. */
export interface CadreStallBasis {
  readonly kind: 'model_generation' | 'tool_execution' | 'no_events'
  readonly since: string
  readonly stepKind: 'model_generation' | 'tool_execution' | null
  readonly toolName: string | null
  readonly elapsedMs: number
  readonly heartbeatAgeMs: number
  readonly evidenceEventSeq: number | null
}

/** One task view matching host-governance `StallTaskView`. */
export interface CadreStallTaskView {
  readonly taskId: string
  readonly title: string
  readonly taskStatus: string
  readonly assigneeSessionId: string
  readonly assigneeName: string
  readonly assigneeRole: string
  readonly lastActivityAt: number | null
  readonly lastActivityKind: CadreStallActivityKind | null
  readonly silenceMs: number | null
  readonly stallState: CadreStallLevel
  readonly stateSince: number
  readonly episodeId: string
  readonly nudgeCount: number
  readonly lastNudgedAt: number | null
  readonly suggestedAction: 'nudge' | 'reassign' | 'cancel' | 'escalate' | null
  readonly capabilities: {
    readonly nudge: boolean
    readonly reassign: boolean
    readonly cancel: boolean
    readonly escalate: boolean
  }
  readonly version: number
  readonly stale: boolean
  readonly updatedAt: string
  /** Real host-governance fields. */
  readonly elapsedMs: number | null
  readonly heartbeatAt: number | null
  readonly firstTokenAt: number | null
  readonly tokensSoFar: number | null
  readonly stallBasis: CadreStallBasis | null
  readonly inferred: boolean
  /** DF-017 pending: the host has no lastError field yet. */
  readonly lastError?: CadreStallError | null
}

/** Employee aggregation consumed by the sidebar row. */
export interface CadreStallSummary {
  readonly worstState: CadreStallLevel
  readonly stalledCount: number
  readonly possiblyStalledCount: number
  readonly lastActivityAt: number | null
  readonly episodeIds: readonly string[]
  /** Present while a generation/tool/question owns the employee. */
  readonly execution?: CadreExecutionView | null
}

/** Host config fields; the view is allowed to omit any value. */
export interface CadreStallThresholds {
  readonly suspectAfterMs: number
  readonly stalledAfterMs: number
  readonly recoverAfterMs: number
  readonly scanIntervalMs: number
  readonly consecutiveSamples: number
  readonly nudgeCooldownMs: number
  readonly escalateAfterMs: number
  readonly maxGoalRounds: number
}

export const CADRE_STALL_DEFAULTS: CadreStallThresholds = {
  suspectAfterMs: 180_000,
  stalledAfterMs: 600_000,
  recoverAfterMs: 30_000,
  scanIntervalMs: 15_000,
  consecutiveSamples: 2,
  nudgeCooldownMs: 60_000,
  escalateAfterMs: 1_800_000,
  maxGoalRounds: 20,
}

/** Response of the real `POST /cadre/stall/snapshot` route. */
export interface CadreStallViewResponse {
  readonly tasks?: readonly CadreStallTaskView[]
  readonly thresholds?: Partial<CadreStallThresholds>
  readonly stale?: boolean
}

/** Fields supplied by the card; the adapter adds project/actor/action. */
export interface CadreStallActionBase {
  readonly taskId: string
  readonly episodeId: string
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly toSessionId?: string
  readonly reason?: string
}

export type CadreStallAction = 'nudge' | 'reassign' | 'cancel' | 'escalate'

/** Exact `/cadre/stall/action` request fields from host-governance. */
export interface CadreStallActionRequest extends CadreStallActionBase {
  readonly action: CadreStallAction
  readonly projectId: string
  readonly actorSessionId: string
}

export type CadreStallActionResult =
  | { readonly ok: true; readonly action: CadreStallAction; readonly version: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string }

const STALL_VIEW_FIELDS = [
  'taskId', 'title', 'taskStatus', 'assigneeSessionId', 'assigneeName', 'assigneeRole',
  'lastActivityAt', 'lastActivityKind', 'silenceMs', 'stallState', 'stateSince', 'episodeId',
  'nudgeCount', 'lastNudgedAt', 'suggestedAction', 'capabilities', 'version', 'stale', 'updatedAt',
  'elapsedMs', 'heartbeatAt', 'firstTokenAt', 'tokensSoFar', 'stallBasis', 'inferred',
] as const

/** Reject a view object that cannot be rendered; no invented fallback fields. */
export function assertCadreStallTaskView(value: unknown): asserts value is CadreStallTaskView {
  if (typeof value !== 'object' || value === null) throw new Error('STALL_VIEW_CONTRACT_NOT_OBJECT')
  const view = value as Record<string, unknown>
  for (const field of STALL_VIEW_FIELDS) {
    if (view[field] === undefined) throw new Error(`STALL_VIEW_CONTRACT_MISSING:${field}`)
  }
  if (view.stallBasis === null) throw new Error('STALL_VIEW_CONTRACT_MISSING:stallBasis')
  if (typeof view.stallBasis !== 'object') throw new Error('STALL_VIEW_CONTRACT_INVALID:stallBasis')
  {
    const basis = view.stallBasis as Record<string, unknown>
    if (basis.kind !== 'model_generation' && basis.kind !== 'tool_execution' && basis.kind !== 'no_events') {
      throw new Error('STALL_VIEW_CONTRACT_INVALID:stallBasis.kind')
    }
    if (basis.kind === 'no_events') return
    if (basis.stepKind !== 'model_generation' && basis.stepKind !== 'tool_execution') {
      throw new Error('STALL_VIEW_CONTRACT_MISSING:stallBasis.stepKind')
    }
    if (basis.stepKind === 'tool_execution' && (typeof basis.toolName !== 'string' || basis.toolName === '')) {
      throw new Error('STALL_VIEW_CONTRACT_MISSING:stallBasis.toolName')
    }
  }
}

/** POST one action to the real host-governance route. */
export async function fetchCadreStallView(request: {
  readonly projectId: string
  readonly actorSessionId: string
}): Promise<CadreStallViewResponse> {
  const response = await fetch('/cadre/stall/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const payload = await response.json().catch(() => undefined) as
    | (CadreStallViewResponse & { readonly ok?: false; readonly code?: string; readonly message?: string })
    | { readonly ok: false; readonly code?: string; readonly message?: string }
    | undefined
  if (payload === undefined) {
    throw new Error(`STALL_VIEW_EMPTY_RESPONSE · HTTP ${response.status}`)
  }
  if (!response.ok || payload.ok === false) {
    const failure = payload as { readonly code?: string; readonly message?: string }
    throw new Error(`${failure.code ?? 'STALL_VIEW_FAILED'} · ${failure.message ?? `HTTP ${response.status}`}`)
  }
  const view = payload as CadreStallViewResponse
  for (const task of view.tasks ?? []) assertCadreStallTaskView(task)
  return view
}

export async function actCadreStall(request: CadreStallActionRequest): Promise<CadreStallActionResult> {
  try {
    const response = await fetch('/cadre/stall/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const payload = await response.json().catch(() => undefined) as CadreStallActionResult | undefined
    if (payload === undefined) {
      return { ok: false, code: 'EMPTY_RESPONSE', message: `STALL_ACTION_EMPTY_RESPONSE · HTTP ${response.status}` }
    }
    return payload
  } catch (error) {
    return { ok: false, code: 'STALL_ACTION_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Derive the execution view from stallBasis plus the real progress fields. */
export function executionOf(task: CadreStallTaskView, _now = Date.now()): CadreExecutionView | null {
  const basis = task.stallBasis
  const state: CadreExecutionState | null = task.stallState === 'waiting_question'
    ? 'waiting_question'
    : basis !== null && basis.kind !== 'no_events' ? basis.kind : null
  if (state === null) return null
  const elapsed = task.elapsedMs ?? basis?.elapsedMs ?? null
  return {
    state,
    ...(basis?.stepKind === null || basis?.stepKind === undefined ? {} : { stepKind: basis.stepKind }),
    toolName: basis?.toolName ?? null,
    startedAt: basis === null ? null : Date.parse(basis.since),
    elapsedMs: elapsed,
    heartbeatAt: task.heartbeatAt,
    firstTokenAt: task.firstTokenAt,
    tokensSoFar: task.tokensSoFar,
  }
}

/** Derive the employee row aggregate from the task views. */
export function summarizeStalls(
  tasks: readonly CadreStallTaskView[],
  now = Date.now(),
): ReadonlyMap<string, CadreStallSummary> {
  const bySession = new Map<string, CadreStallTaskView[]>()
  for (const task of tasks) {
    const list = bySession.get(task.assigneeSessionId) ?? []
    list.push(task)
    bySession.set(task.assigneeSessionId, list)
  }
  const summaries = new Map<string, CadreStallSummary>()
  for (const [sessionId, own] of bySession) {
    const stalled = own.filter(task => task.stallState === 'stalled').length
    const possible = own.filter(task => task.stallState === 'possibly_stalled').length
    const waiting = own.some(task => task.stallState === 'waiting_question')
    const latest = own.reduce<number | null>((at, task) => task.lastActivityAt === null ? at
      : at === null || task.lastActivityAt > at ? task.lastActivityAt : at, null)
    const views = own.map(task => executionOf(task, now)).filter((view): view is CadreExecutionView => view !== null)
    const execution = views.find(view => view.state === 'waiting_question')
      ?? views.find(view => view.state === 'tool_execution')
      ?? views.find(view => view.state === 'model_generation')
      ?? null
    summaries.set(sessionId, {
      worstState: stalled > 0 ? 'stalled' : possible > 0 ? 'possibly_stalled' : waiting ? 'waiting_question' : 'normal',
      stalledCount: stalled,
      possiblyStalledCount: possible,
      lastActivityAt: latest,
      episodeIds: own.filter(task => task.stallState === 'stalled' || task.stallState === 'possibly_stalled')
        .map(task => task.episodeId),
      ...(execution === null ? {} : { execution }),
    })
  }
  return summaries
}

/** One project's normalized view state. */
export interface CadreStallProjectState {
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable'
  readonly tasks: readonly CadreStallTaskView[]
  readonly thresholds: CadreStallThresholds
  readonly stale: boolean
  readonly error: string | null
}

/** Reactive store shared by sidebar rows, ledger, and supervisor cards. */
export interface CadreStallState {
  readonly byProject: ReadonlyMap<string, CadreStallProjectState>
  readonly bySession: ReadonlyMap<string, CadreStallSummary>
}

export function relativeTime(value: number | null, t: Translate, now = Date.now()): string {
  if (value === null) return t('stall.time.unknown')
  const seconds = Math.max(0, Math.round((now - value) / 1000))
  if (seconds < 60) return t('stall.time.justNow')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('stall.time.minutesAgo', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('stall.time.hoursAgo', { count: hours })
  return t('stall.time.daysAgo', { count: Math.round(hours / 24) })
}

/** Human elapsed duration for generation/tool progress. */
export function elapsedText(milliseconds: number | null | undefined, t: Translate): string {
  if (milliseconds === null || milliseconds === undefined) return t('stall.time.unknown')
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return t('stall.elapsed.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('stall.elapsed.minutes', { count: minutes })
  return t('stall.elapsed.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/** One localized execution label; no_events intentionally has no progress label. */
export function executionText(execution: CadreExecutionView | null | undefined, t: Translate): string {
  if (execution === null || execution === undefined) return ''
  if (execution.state === 'model_generation') {
    return t('stall.execution.generating', { elapsed: elapsedText(execution.elapsedMs, t) })
  }
  if (execution.state === 'tool_execution') {
    return t('stall.execution.tool', {
      tool: execution.toolName ?? t('stall.execution.unknownTool'),
      elapsed: elapsedText(execution.elapsedMs, t),
    })
  }
  if (execution.state === 'waiting_question') {
    return t('stall.execution.waiting', { elapsed: elapsedText(execution.elapsedMs, t) })
  }
  return ''
}

/** Convert an ISO-8601 UTC timestamp for local display; invalid values stay unknown. */
export function localTime(value: string | number | null | undefined, t: Translate): string {
  if (value === null || value === undefined) return t('stall.time.unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('stall.time.unknown') : date.toLocaleString()
}

/** Write-guard denial codes that need a distinct visible surface. */
export function isWriteGuardError(code: string): boolean {
  return code === 'WRITE_EXTENSION_DENIED'
    || code === 'WRITE_PATH_DENIED'
    || code === 'WRITE_OFFICE_DENIED'
    || code === 'WRITE_SHELL_DENIED'
    || code === 'WRITE_POLICY_UNAVAILABLE'
    || code === 'WRITE_POLICY_TOOL_UNSUPPORTED'
    || code === 'WRITE_POLICY_DENIED'
}

export function silenceText(milliseconds: number | null, t: Translate): string {
  if (milliseconds === null) return t('stall.silence.unknown')
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (minutes < 1) return t('stall.silence.lessThanMinute')
  if (minutes < 60) return t('stall.silence.minutes', { count: minutes })
  return t('stall.silence.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

export function stallStateText(
  state: CadreStallLevel | undefined,
  lastActivityAt: number | null,
  t: Translate,
): string {
  const activity = relativeTime(lastActivityAt, t)
  if (state === 'stalled') return t('stall.state.stalled', { activity })
  if (state === 'possibly_stalled') return t('stall.state.possibly', { activity })
  if (state === 'waiting_question') return t('stall.state.waiting', { activity })
  if (state === 'normal') return t('stall.state.normal', { activity })
  return t('stall.state.unknown')
}

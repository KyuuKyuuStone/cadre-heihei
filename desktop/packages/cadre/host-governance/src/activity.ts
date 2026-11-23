/**
 * Session activity projection for the stall watchdog.
 *
 * `waitingQuestion` is scoped to the current task window so an old unanswered
 * question cannot freeze a newly dispatched (or reworked) task forever.
 * @module
 */
import type { ActivityKind, SessionActivity, TaskLastError } from './types.ts'

/** One raw Session event the projection needs. */
export interface ActivityEvent {
  readonly type: string
  readonly time: number
  readonly seq?: number
  readonly data?: unknown
}

/** Association between one task and the Session's currently open turn. */
export type TaskTurnAssociation =
  | { readonly kind: 'none' }
  | { readonly kind: 'current'; readonly turn: number }
  | { readonly kind: 'other'; readonly turn: number; readonly taskId: string }
  | { readonly kind: 'ambiguous'; readonly turn: number; readonly taskIds: readonly string[] }

/**
 * Return the exact task id from durable dispatch content.
 * @param content - message content parts to inspect in order.
 * @returns the first well-formed task identity, if present.
 */
export function dispatchTaskIdFromContent(
  content: readonly { readonly type?: unknown; readonly text?: unknown }[] | undefined,
): string | undefined {
  for (const part of content ?? []) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    const lines = part.text.split(/\r?\n/u)
    if (lines[0] !== '【主管任务】' || !lines[1]?.startsWith('任务号：')) continue
    const taskId = lines[1].slice('任务号：'.length).trim()
    if (taskId !== '') return taskId
  }
  return undefined
}

/** Return the exact task id from the Host's durable dispatch message framing. */
function dispatchTaskId(event: ActivityEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as { content?: readonly { type?: unknown; text?: unknown }[] } | undefined
  return dispatchTaskIdFromContent(data?.content)
}

/**
 * Associate a task only with dispatch messages inside the currently open turn.
 * Missing or multiple task identities are ambiguous and must not authorize a
 * runtime cancellation; a turn belonging only to another task stays untouched.
 * @param events - raw Session events in log order.
 * @param taskId - task being cancelled.
 * @returns the exact turn to cancel, an unrelated/idle result, or an ambiguity refusal.
 */
export function taskTurnAssociation(events: readonly ActivityEvent[], taskId: string): TaskTurnAssociation {
  let open: { turn: number; taskIds: Set<string> } | undefined
  for (const event of events) {
    const data = event.data as { turn?: unknown } | undefined
    if (event.type === 'turn/start' && typeof data?.turn === 'number') {
      open = { turn: data.turn, taskIds: new Set() }
      continue
    }
    if (event.type === 'turn/end' && data?.turn === open?.turn) {
      open = undefined
      continue
    }
    if (open === undefined) continue
    const associatedTaskId = dispatchTaskId(event)
    if (associatedTaskId !== undefined) open.taskIds.add(associatedTaskId)
  }
  if (open === undefined) return { kind: 'none' }
  const taskIds = [...open.taskIds].sort()
  if (taskIds.length === 1 && taskIds[0] === taskId) return { kind: 'current', turn: open.turn }
  if (taskIds.length === 1 && taskIds[0] !== undefined) return { kind: 'other', turn: open.turn, taskId: taskIds[0] }
  return { kind: 'ambiguous', turn: open.turn, taskIds }
}

function kindOf(event: ActivityEvent | undefined): ActivityKind | undefined {
  if (event === undefined) return undefined
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') return 'assistant'
  if (event.type === 'tool/call' || event.type === 'tool/result') return 'tool'
  if (event.type === 'user/message') return 'report'
  return undefined
}

/**
 * Whether an unanswered `ask_user_question` call owns the turn.
 * Calls before `windowStartAt` are historical and never freeze the task.
 * @param events - raw Session events in log order.
 * @param windowStartAt - task dispatch / current rework epoch ms; undefined keeps all history.
 * @returns true only for an in-window ask without a matching tool result.
 */
export function waitingQuestion(events: readonly ActivityEvent[], windowStartAt?: number): boolean {
  const results = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const data = event?.data as { callId?: unknown; name?: unknown } | undefined
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    if (event?.type === 'tool/result' && callId !== undefined) { results.add(callId); continue }
    if (event?.type === 'tool/call' && data?.name === 'ask_user_question' && callId !== undefined) {
      if (windowStartAt !== undefined && event.time < windowStartAt) continue
      return !results.has(callId)
    }
  }
  return false
}

/**
 * Project the last real activity and the windowed waiting-question flag.
 * @param events - raw Session events in log order.
 * @param windowStartAt - task dispatch / current rework epoch ms; undefined keeps all history.
 * @returns activity facts consumed by the watchdog.
 */
export function activityFrom(events: readonly ActivityEvent[], windowStartAt?: number): SessionActivity {
  const event = events.at(-1)
  const step = activeStep(events)
  const lastError = lastErrorOf(events, windowStartAt)
  return {
    ...(event === undefined ? {} : { lastActivityAt: event.time, kind: kindOf(event) ?? 'assistant' }),
    ...(event?.seq === undefined ? {} : { lastActivitySeq: event.seq }),
    waitingQuestion: waitingQuestion(events, windowStartAt),
    ...step,
    ...(step.stepSince === undefined ? {} : stepDetails(events, step.stepSince)),
    ...(compactionActive(events) ? { compactionActive: true } : {}),
    ...(lastError === undefined ? {} : { lastError }),
    ...(events.some(candidate => candidate.type.startsWith('turn/') || candidate.type.startsWith('model_call/'))
      ? {}
      : { inferred: true }),
  }
}

/** Turn a provider failure into a readable task-view error. */
export function readableModelError(code: string, message: string): { code: string; message: string } {
  const text = `${code} ${message}`
  if (/MODEL_CONFIG|thinking|not supported by this model|unsupported model|能力不匹配/iu.test(text)) {
    return {
      code: 'MODEL_CONFIG',
      message: '模型能力不匹配：当前模型不支持所选能力（如 thinking）。请切换模型或关闭思考后重试。',
    }
  }
  if (/AUTH|401|unauthori[sz]ed|api key/iu.test(text)) {
    return { code: 'AUTH', message: '模型鉴权失败：请检查 API Key 或登录状态。' }
  }
  if (/RATE_LIMIT|429|rate limit|too many requests/iu.test(text)) {
    return { code: 'RATE_LIMIT', message: '模型请求限流：请稍后重试。' }
  }
  if (/TIMEOUT|ETIMEDOUT|timed out/iu.test(text)) {
    return { code: 'TIMEOUT', message: '模型请求超时：请重试或切换模型。' }
  }
  return { code, message }
}

/** Latest terminal error in the task window, normalized for the view. */
function lastErrorOf(events: readonly ActivityEvent[], windowStartAt?: number): TaskLastError | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    if (windowStartAt !== undefined && event.time < windowStartAt) return undefined
    const reason = (event.data as { reason?: { kind?: unknown; error?: { code?: unknown; message?: unknown } } } | undefined)?.reason
    if (reason?.kind !== 'error') return undefined
    const code = typeof reason.error?.code === 'string' ? reason.error.code : 'UNKNOWN'
    const message = typeof reason.error?.message === 'string' ? reason.error.message : '模型请求失败'
    return { ...readableModelError(code, message), at: new Date(event.time).toISOString() }
  }
  return undefined
}

/** First token and latest usage inside the active step. */
function stepDetails(events: readonly ActivityEvent[], stepSince: number): Pick<SessionActivity, 'firstTokenAt' | 'tokensSoFar' | 'evidenceEventSeq'> {
  let firstTokenAt: number | undefined
  let tokensSoFar: number | undefined
  let evidenceEventSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.time < stepSince) continue
    if (event.type === 'model_call/first_token') {
      if (firstTokenAt === undefined) firstTokenAt = event.time
      if (evidenceEventSeq === undefined) evidenceEventSeq = event.seq
      continue
    }
    if (event.type === 'assistant/message' && tokensSoFar === undefined) {
      const data = event.data as { usage?: { outputTokens?: unknown } } | undefined
      if (typeof data?.usage?.outputTokens === 'number') tokensSoFar = data.usage.outputTokens
    }
  }
  return {
    ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
    ...(tokensSoFar === undefined ? {} : { tokensSoFar }),
    ...(evidenceEventSeq === undefined ? {} : { evidenceEventSeq }),
  }
}

/** Whether a compaction window opened and has not closed. */
function compactionActive(events: readonly ActivityEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'compaction/end') return false
    if (type === 'compaction/start') return true
  }
  return false
}

/** Classify the active step from additive turn lifecycle events (absent on old logs). */
function activeStep(events: readonly ActivityEvent[]): Pick<SessionActivity, 'stepKind' | 'stepSince' | 'toolName'> {
  let turnOpen = false
  let stepSince: number | undefined
  let pendingTool: { name: string; time: number } | undefined
  const answered = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const current = events[index]
    if (current === undefined) continue
    const data = current.data as { callId?: unknown; name?: unknown } | undefined
    const callId = typeof data?.callId === 'string' ? data.callId : undefined
    if (current.type === 'tool/result' && callId !== undefined) {
      answered.add(callId)
      continue
    }
    if (current.type === 'tool/call' && callId !== undefined && !answered.has(callId)) {
      pendingTool = { name: String(data?.name ?? 'tool'), time: current.time }
      break
    }
    if (current.type === 'turn/aborted' || current.type === 'turn/completed' || current.type === 'turn/end') {
      break
    }
    if (current.type === 'turn/start' || current.type === 'turn/received') {
      turnOpen = true
      break
    }
    if (current.type === 'model_call/started' || current.type === 'model_call/first_token') {
      turnOpen = true
      stepSince = current.time
      break
    }
  }
  if (pendingTool !== undefined) {
    return { stepKind: 'tool_execution', stepSince: pendingTool.time, toolName: pendingTool.name }
  }
  if (turnOpen) return { stepKind: 'model_generation', ...(stepSince === undefined ? {} : { stepSince }) }
  return {}
}

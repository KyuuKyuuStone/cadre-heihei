/**
 * Session activity projection for the stall watchdog.
 *
 * `waitingQuestion` is scoped to the current task window so an old unanswered
 * question cannot freeze a newly dispatched (or reworked) task forever.
 * @module
 */
import type { ActivityKind, SessionActivity } from './types.ts'

/** One raw Session event the projection needs. */
export interface ActivityEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
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
  return {
    ...(event === undefined ? {} : { lastActivityAt: event.time, kind: kindOf(event) ?? 'assistant' }),
    waitingQuestion: waitingQuestion(events, windowStartAt),
  }
}

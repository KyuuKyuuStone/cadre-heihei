/**
 * Supervisor-session idle reminder. After an assistant message, wait the
 * configured minutes; a user message cancels it. One reminder per idle segment.
 * @module
 */
import type { EmailEvent, EmailResult } from '@deepseek-ai/dsh-cadre-email-notify'

/** Idle policy read from the project's email config. */
export interface IdleReminderPolicy {
  readonly enabled: boolean
  readonly minutes: number
}

interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

interface IdleState {
  readonly title: string
  readonly summary: string
  timer: unknown
  sent: boolean
}

type TimerHandle = unknown

/** Testable idle reminder timer. */
export class IdleReminderService {
  readonly #isSupervisor: (sessionId: string) => boolean
  readonly #projectOf: (sessionId: string) => string | undefined
  readonly #policyOf: (projectId: string) => IdleReminderPolicy | undefined
  readonly #send: (event: EmailEvent) => Promise<EmailResult>
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, ms: number) => TimerHandle
  readonly #clearTimer: (handle: TimerHandle) => void
  readonly #log: (line: string) => void
  readonly #states = new Map<string, IdleState>()
  readonly #titles = new Map<string, string>()

  constructor(options: {
    readonly isSupervisor: (sessionId: string) => boolean
    readonly projectOf: (sessionId: string) => string | undefined
    readonly policyOf: (projectId: string) => IdleReminderPolicy | undefined
    readonly send: (event: EmailEvent) => Promise<EmailResult>
    readonly now?: () => number
    readonly setTimer?: (callback: () => void, ms: number) => TimerHandle
    readonly clearTimer?: (handle: TimerHandle) => void
    readonly log?: (line: string) => void
  }) {
    this.#isSupervisor = options.isSupervisor
    this.#projectOf = options.projectOf
    this.#policyOf = options.policyOf
    this.#send = options.send
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.#clearTimer = options.clearTimer ?? (handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
    this.#log = options.log ?? (line => { console.info(line) })
  }

  /** Apply one committed session event. */
  handle(sessionId: string, event: SessionEventLike): void {
    if (!this.#isSupervisor(sessionId)) return
    if (event.type === 'session/title') {
      const title = this.#titleOf(event)
      if (title !== undefined) this.#titles.set(sessionId, title)
      return
    }
    if (event.type === 'user/message') {
      this.#cancel(sessionId)
      return
    }
    if (event.type !== 'assistant/message') return
    const projectId = this.#projectOf(sessionId)
    if (projectId === undefined) return
    const policy = this.#policyOf(projectId)
    if (policy === undefined || !policy.enabled) {
      this.#cancel(sessionId)
      return
    }
    const existing = this.#states.get(sessionId)
    const title = this.#titles.get(sessionId) ?? `会话 ${sessionId.slice(0, 8)}`
    const summary = this.#summaryOf(event)
    if (existing?.sent === true) {
      this.#states.set(sessionId, { ...existing, title, summary })
      return
    }
    if (existing !== undefined) this.#clearTimer(existing.timer)
    const state: IdleState = { title, summary, timer: undefined, sent: false }
    state.timer = this.#setTimer(() => { void this.#fire(sessionId, projectId, policy, state) }, policy.minutes * 60_000)
    this.#states.set(sessionId, state)
    this.#log(`[idle-reminder] armed session=${sessionId} minutes=${String(policy.minutes)}`)
  }

  /** Cancel all pending reminders. */
  dispose(): void {
    for (const sessionId of [...this.#states.keys()]) this.#cancel(sessionId)
    this.#titles.clear()
  }

  async #fire(sessionId: string, projectId: string, policy: IdleReminderPolicy, state: IdleState): Promise<void> {
    if (state.sent || this.#states.get(sessionId) !== state) return
    state.sent = true
    state.timer = undefined
    const event: EmailEvent = {
      kind: 'idle-reminder',
      projectId,
      sessionId,
      title: state.title,
      summary: state.summary,
      idleMinutes: policy.minutes,
      at: new Date(this.#now()).toISOString(),
    }
    try {
      const result = await this.#send(event)
      this.#log(`[idle-reminder] sent session=${sessionId} status=${result.ok ? result.status : result.code}`)
    } catch (error) {
      this.#log(`[idle-reminder] send failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #cancel(sessionId: string): void {
    const state = this.#states.get(sessionId)
    if (state === undefined) return
    if (state.timer !== undefined) this.#clearTimer(state.timer)
    this.#states.delete(sessionId)
  }

  #titleOf(event: SessionEventLike): string | undefined {
    if (typeof event.data !== 'object' || event.data === null) return undefined
    const title = (event.data as { title?: unknown }).title
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  }

  #summaryOf(event: SessionEventLike): string {
    if (typeof event.data !== 'object' || event.data === null) return '（无文本回复）'
    const data = event.data as { content?: unknown; message?: { content?: unknown } }
    const content = Array.isArray(data.content) ? data.content : data.message?.content
    if (!Array.isArray(content)) return '（无文本回复）'
    const text = content.flatMap(part => {
      if (typeof part !== 'object' || part === null) return []
      const item = part as { type?: unknown; text?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    }).join('\n').trim()
    return text === '' ? '（无文本回复）' : text.slice(0, 300)
  }
}

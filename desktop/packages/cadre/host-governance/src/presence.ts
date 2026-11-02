/**
 * Short-lived "user is typing" presence. The frontend reports on a 300ms
 * debounce; entries expire after 5s unless refreshed. Auto-continuation reads
 * this service and waits instead of starting a turn.
 * @module
 */

/** One presence entry, exposed for route responses. */
export interface TypingState {
  readonly sessionId: string
  readonly typing: boolean
  readonly updatedAt: number
}

/** Default time a typing report remains valid without a refresh. */
export const TYPING_TTL_MS = 5_000

/** In-memory typing presence shared by the Host route and goal automation. */
export class SessionPresence {
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #entries = new Map<string, number>()
  readonly #timers = new Map<string, unknown>()
  readonly #waiters = new Map<string, Set<() => void>>()

  constructor(options: {
    readonly ttlMs?: number
    readonly now?: () => number
    readonly setTimer?: (callback: () => void, ms: number) => unknown
    readonly clearTimer?: (handle: unknown) => void
  } = {}) {
    this.#ttlMs = options.ttlMs ?? TYPING_TTL_MS
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.#clearTimer = options.clearTimer ?? (handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  /** Record or clear typing for one session. */
  mark(sessionId: string, typing: boolean): TypingState {
    this.#clearEntryTimer(sessionId)
    if (!typing) {
      this.#entries.delete(sessionId)
      this.#resolveWaiters(sessionId)
      return { sessionId, typing: false, updatedAt: this.#now() }
    }
    const updatedAt = this.#now()
    this.#entries.set(sessionId, updatedAt)
    const timer = this.#setTimer(() => {
      const current = this.#entries.get(sessionId)
      if (current !== updatedAt) return
      this.#entries.delete(sessionId)
      this.#timers.delete(sessionId)
      this.#resolveWaiters(sessionId)
    }, this.#ttlMs)
    this.#timers.set(sessionId, timer)
    return { sessionId, typing: true, updatedAt }
  }

  /** Whether the session currently has fresh typing/draft presence. */
  isTyping(sessionId: string): boolean {
    const at = this.#entries.get(sessionId)
    if (at === undefined) return false
    if (this.#now() - at < this.#ttlMs) return true
    this.#entries.delete(sessionId)
    this.#clearEntryTimer(sessionId)
    this.#resolveWaiters(sessionId)
    return false
  }

  /** Resolve once typing clears, expires, or the user sends. */
  whenIdle(sessionId: string): Promise<void> {
    if (!this.isTyping(sessionId)) return Promise.resolve()
    return new Promise(resolve => {
      const set = this.#waiters.get(sessionId) ?? new Set()
      set.add(resolve)
      this.#waiters.set(sessionId, set)
    })
  }

  /** Drop all presence and resolve waiting automation. */
  dispose(): void {
    for (const sessionId of [...this.#entries.keys()]) this.#clearEntryTimer(sessionId)
    this.#entries.clear()
    for (const sessionId of [...this.#waiters.keys()]) this.#resolveWaiters(sessionId)
  }

  #resolveWaiters(sessionId: string): void {
    const waiters = this.#waiters.get(sessionId)
    if (waiters === undefined) return
    this.#waiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }

  #clearEntryTimer(sessionId: string): void {
    const timer = this.#timers.get(sessionId)
    if (timer === undefined) return
    this.#timers.delete(sessionId)
    this.#clearTimer(timer)
  }
}

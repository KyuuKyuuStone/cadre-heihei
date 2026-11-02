/**
 * Explicit execution arm. Discussion is the default; dispatch is allowed only
 * after a user-triggered arm. The arm is consumed by the first successful
 * dispatch or expires after 10 minutes.
 * @module
 */

/** How long an arm remains valid without a dispatch. */
export const EXECUTION_ARM_TTL_MS = 10 * 60_000

/** One project arm record exposed by the query route. */
export interface ExecutionArmState {
  readonly projectId: string
  readonly sessionId: string
  readonly mode: 'single-batch' | 'ttl'
  readonly armedAt: number
  readonly expiresAt: number
  readonly armed: boolean
}

/** User-triggered arm plus automatic expiry/consumption. */
export class ExecutionArm {
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #audit: (record: {
    projectId: string; sessionId: string; action: 'arm' | 'consume' | 'expire'; mode: string; at: string
  }) => void
  readonly #entries = new Map<string, { sessionId: string; mode: 'single-batch' | 'ttl'; armedAt: number; expiresAt: number }>()

  constructor(options: {
    readonly audit: (record: {
      projectId: string; sessionId: string; action: 'arm' | 'consume' | 'expire'; mode: string; at: string
    }) => void
    readonly ttlMs?: number
    readonly now?: () => number
  }) {
    this.#ttlMs = options.ttlMs ?? EXECUTION_ARM_TTL_MS
    this.#now = options.now ?? Date.now
    this.#audit = options.audit
  }

  /** Arm one project after a user click. */
  arm(projectId: string, sessionId: string, mode: 'single-batch' | 'ttl' = 'single-batch'): ExecutionArmState {
    const armedAt = this.#now()
    const entry = { sessionId, mode, armedAt, expiresAt: armedAt + this.#ttlMs }
    this.#entries.set(projectId, entry)
    this.#audit({ projectId, sessionId, action: 'arm', mode, at: new Date(armedAt).toISOString() })
    return this.#state(projectId, entry)
  }

  /** Whether dispatch is currently allowed, expiring stale entries. */
  status(projectId: string): ExecutionArmState | undefined {
    const entry = this.#entries.get(projectId)
    if (entry === undefined) return undefined
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(projectId)
      this.#audit({
        projectId, sessionId: entry.sessionId, action: 'expire', mode: entry.mode,
        at: new Date(this.#now()).toISOString(),
      })
      return undefined
    }
    return this.#state(projectId, entry)
  }

  /** Consume a valid arm after the first successful dispatch. */
  consume(projectId: string): boolean {
    const state = this.status(projectId)
    if (state === undefined) return false
    this.#entries.delete(projectId)
    this.#audit({
      projectId, sessionId: state.sessionId, action: 'consume', mode: state.mode,
      at: new Date(this.#now()).toISOString(),
    })
    return true
  }

  #state(projectId: string, entry: { sessionId: string; mode: 'single-batch' | 'ttl'; armedAt: number; expiresAt: number }): ExecutionArmState {
    return {
      projectId, sessionId: entry.sessionId, mode: entry.mode,
      armedAt: entry.armedAt, expiresAt: entry.expiresAt, armed: true,
    }
  }
}

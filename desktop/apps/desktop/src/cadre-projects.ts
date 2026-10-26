/**
 * Per-project collaboration write stores.
 *
 * A project IS an official Workspace (DC-001 R2/R3), and the write library
 * binds its actor/project pair when the store opens. One shell therefore needs
 * one store per (Workspace, caller) pair instead of a single process-wide
 * project binding, and the caller must name its own Session: there is no
 * process identity to fall back to. Stores are opened on first use and closed
 * together at shutdown; the ledger file itself stays shared (`cadre.sqlite`),
 * which is what keeps reads and writes on the same database.
 */
import type { CadreCollab, CadreCollabOptions } from './cadre-collab-api.ts'
import type { CadreMemberRow } from './cadre-ledger.ts'

/** Opens the bundled write library for one project. */
export type CadreCollabOpener = (options: CadreCollabOptions) => CadreCollab | undefined

export interface CadreProjectRegistryOptions {
  readonly databasePath: string
  readonly open: CadreCollabOpener
  /**
   * SQLite lock wait for every per-project connection.
   *
   * Several (project, caller) handles share one `cadre.sqlite`; without a wait
   * a concurrent writer would surface `SQLITE_BUSY` as a failed dispatch.
   * Matches the ledger default rather than weakening it.
   */
  readonly busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 15_000

/** Lazily opened, cached write stores keyed by project (Workspace) and caller. */
export class CadreProjectRegistry {
  readonly #options: CadreProjectRegistryOptions
  readonly #stores = new Map<string, CadreCollab>()

  constructor(options: CadreProjectRegistryOptions) {
    this.#options = options
  }

  /**
   * Write store for one project and caller, opened on first use.
   * @param projectId - validated project (Workspace) id.
   * @param sessionId - the calling Session; required, never a default.
   * @returns the store, or undefined when the write library is unavailable.
   */
  forProject(projectId: string, sessionId: string): CadreCollab | undefined {
    const key = `${projectId}\u0000${sessionId}`
    const cached = this.#stores.get(key)
    if (cached !== undefined) return cached
    const opened = this.#options.open({
      databasePath: this.#options.databasePath,
      projectId,
      sessionId,
      busyTimeoutMs: this.#options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    })
    if (opened !== undefined) this.#stores.set(key, opened)
    return opened
  }

  /** Number of projects opened so far (diagnostics only). */
  get size(): number {
    return this.#stores.size
  }

  /** Close every open store; safe to call twice. */
  close(): void {
    for (const store of this.#stores.values()) store.close()
    this.#stores.clear()
  }
}

/**
 * The caller's roster row in one project, when it exists and has not departed.
 *
 * The roster is the ledger's authority for membership. A request naming a
 * project in which the caller has no row is a cross-project request, not an
 * implicit enrolment: enrolling belongs to the project-creation flow
 * (`cadreSaveMember`), never to a dispatch.
 * @param members - roster rows read from the ledger.
 * @param sessionId - caller session id.
 * @returns the member row, or undefined when the caller is foreign/departed.
 */
export function activeMember(
  members: readonly CadreMemberRow[],
  sessionId: string,
): CadreMemberRow | undefined {
  return members.find((member) => member.sessionId === sessionId && member.state !== 'departed')
}

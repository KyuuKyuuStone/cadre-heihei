/**
 * B③ write-path library entry.
 *
 * Bundled by `scripts/build-cadre-collab.mjs` into
 * `apps/desktop/lib/cadre-collab.cjs` and required from the desktop main
 * process. All state-machine, permission, idempotency and validation logic
 * comes from the desktop-owned snapshot in `cadre-collab/collab/**`; this file
 * only binds an actor identity and forwards calls to `DispatchService` /
 * `SqliteTaskLedger.transition`.
 */

import { DispatchService } from './collab/dispatch/dispatch-service.ts'
import { SqliteCollabStore } from './collab/dispatch/sqlite-dispatch.ts'

export interface CadreCollabOptions {
  readonly databasePath: string
  readonly projectId: string
  readonly sessionId: string
  readonly busyTimeoutMs?: number
}

export interface CadreDispatchInput {
  readonly to: string
  readonly title: string
  readonly body: string
  readonly idempotencyKey?: string
  readonly supersedesTaskId?: string
}

export interface CadreTransitionInput {
  readonly taskId: string
  /** Optional: when omitted the current status is read from the same write connection. */
  readonly from?: string
  readonly to: string
  readonly reason?: string
  readonly idempotencyKey?: string
}

export interface CadreCollab {
  readonly databasePath: string
  dispatch(input: CadreDispatchInput): unknown
  transition(input: CadreTransitionInput): unknown
  /** Post-commit snapshot from the write connection (WAL sees its own commit). */
  listTasks(): { projectId: string; rows: readonly unknown[] }
  close(): void
}

/**
 * Create the ledger schema without binding a project or seeding a roster.
 *
 * The desktop main process needs the tables before the first project is known
 * (its read-only connection and the employee roster open at startup). Opening
 * a real project store here would bind an actor to a project that may not
 * exist, so this only runs the forward-only migration.
 * @param databasePath - absolute path to `cadre.sqlite`.
 */
export function initCadreStore(databasePath: string): void {
  const store = new SqliteCollabStore({ databasePath })
  store.close()
}

/** Open the SQLite collaboration store with a fixed caller identity. */
export function openCadreCollab(options: CadreCollabOptions): CadreCollab {
  const store = new SqliteCollabStore({
    databasePath: options.databasePath,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  })
  console.log(`cadre-ledger roster project=${options.projectId} size=${store.listMembers(options.projectId as never).length}`)
  const service = new DispatchService(store)
  const binding = { projectId: options.projectId as never, sessionId: options.sessionId as never }
  /**
   * Actor kind from the roster, never from the caller or the process.
   *
   * The write path is the only place that names an actor kind, so an
   * environment variable (the old `CADRE_ROLE` fallback) or a renderer-supplied
   * role cannot grant supervisor rights: a roster `worker` maps to the
   * ledger's `assignee`, and the ledger still verifies that the session really
   * is the task's assignee or the project's supervisor (`validation.ts` +
   * `SqliteSupervisorResolver`). A session without a roster row gets no actor
   * kind at all.
   */
  const actorRole = (): 'supervisor' | 'assignee' | undefined => {
    // `sup-1` is the legacy placeholder row without a Session; it must never
    // act, or any caller naming that id could borrow supervisor rights.
    if (options.sessionId === 'sup-1') return undefined
    const member = store.listMembers(options.projectId as never)
      .find(row => row.sessionId === options.sessionId && (row.state as string) !== 'departed')
    if (member === undefined) return undefined
    return member.role === 'supervisor' ? 'supervisor' : 'assignee'
  }
  return {
    databasePath: options.databasePath,
    dispatch(input) {
      // Never enrol the target here: a hallucinated session id would become a
      // real "ghost employee" before the service can reject it. An unknown
      // target must fail as target-not-member on both tool and IPC paths.
      return service.dispatch(binding, {
        projectId: options.projectId as never,
        toSessionId: input.to as never,
        title: input.title,
        body: input.body,
        idempotencyKey: (input.idempotencyKey ?? crypto.randomUUID()) as never,
        ...(input.supersedesTaskId === undefined
          ? {}
          : { supersedesTaskId: input.supersedesTaskId as never }),
      })
    },
    transition(input) {
      // The panel sends only the target status; resolve the start status from
      // the same write connection so the ledger still validates it strictly.
      let from = input.from
      if (from === undefined) {
        const current = store.ledger.getTask(options.projectId as never, input.taskId as never)
        if (!current.ok) return current
        from = current.value.status
      }
      const role = actorRole()
      if (role === undefined) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN_ACTOR',
            message: '调用会话不在本项目花名册（或已离职），无法执行验收迁移',
            retryable: false,
            projectId: options.projectId,
            actorSessionId: options.sessionId,
            reasonCategory: 'not-member',
          },
        }
      }
      const actor = { kind: 'session' as const, sessionId: options.sessionId, role }
      // One-step accept: the panel's "通过验收" on a delivered task runs the
      // mandatory delivered→review→verified chain as two real ledger
      // transitions (two events). Each step still passes validation.ts and the
      // SQLite trigger; non-delivered starts keep the old single-step path.
      if (input.to === 'verified' && from === 'delivered') {
        const review = store.ledger.transition({
          projectId: options.projectId as never,
          taskId: input.taskId as never,
          from: 'delivered',
          to: 'review',
          actor: actor as never,
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:review` as never,
        })
        if (!review.ok) return review
        console.log(`cadre-ledger one-step review project=${options.projectId} task=${input.taskId}`)
        return store.ledger.transition({
          projectId: options.projectId as never,
          taskId: input.taskId as never,
          from: 'review',
          to: 'verified',
          actor: actor as never,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:verified` as never,
        })
      }
      // `SqliteTaskLedger.transition` applies `validation.ts`: start-status
      // match, legal rule, reason requirement, and actor permission via the
      // project roster (`SqliteSupervisorResolver`).
      return store.ledger.transition({
        projectId: options.projectId as never,
        taskId: input.taskId as never,
        from: from as never,
        to: input.to as never,
        actor: actor as never,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey: (input.idempotencyKey ?? crypto.randomUUID()) as never,
      })
    },
    listTasks() {
      // Newest first, same projection as the read-only IPC channel.
      const rows = [...store.ledger.listTasks(options.projectId as never)].reverse().map(task => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        assigneeSessionId: task.assigneeSessionId,
        updatedAt: task.updatedAt,
      }))
      return { projectId: options.projectId, rows }
    },
    close() {
      store.close()
    },
  }
}

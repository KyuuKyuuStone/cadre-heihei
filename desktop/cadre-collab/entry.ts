/**
 * B③ write-path library entry.
 *
 * Bundled by `scripts/build-cadre-collab.mjs` into
 * `apps/desktop/lib/cadre-collab.cjs` and required from the desktop main
 * process. All state-machine, permission, idempotency and validation logic
 * comes from `app/src/collab/**`; this file only binds an actor identity and
 * forwards calls to `DispatchService` / `SqliteTaskLedger.transition`.
 */

import { DispatchService } from '../../app/src/collab/dispatch/dispatch-service.ts'
import { SqliteCollabStore } from '../../app/src/collab/dispatch/sqlite-dispatch.ts'

export type CadreActorRole = 'supervisor' | 'assignee'

export interface CadreCollabOptions {
  readonly databasePath: string
  readonly projectId: string
  readonly sessionId: string
  /** Task-level actor kind; a roster `worker` maps to ledger `assignee`. */
  readonly role: CadreActorRole
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
  // A fresh shell database has no roster; without this the configured local
  // identity is rejected as FORBIDDEN_ACTOR and the first write never lands.
  // Seed only when the project roster is empty, never override existing rows.
  const existing = store.listMembers(options.projectId as never)
  if (existing.length === 0) {
    store.addMember({
      projectId: options.projectId as never,
      sessionId: options.sessionId as never,
      role: options.role === 'assignee' ? 'worker' : 'supervisor',
      state: 'available',
      displayName: options.sessionId,
    })
    console.log(`cadre-ledger roster seeded project=${options.projectId} session=${options.sessionId} role=${options.role}`)
  }
  console.log(`cadre-ledger roster project=${options.projectId} size=${store.listMembers(options.projectId as never).length}`)
  const service = new DispatchService(store)
  const binding = { projectId: options.projectId, sessionId: options.sessionId }
  return {
    databasePath: options.databasePath,
    dispatch(input) {
      // Never enrol the target here: a hallucinated session id would become a
      // real "ghost employee" before the service can reject it. An unknown
      // target must fail as target-not-member on both tool and IPC paths.
      return service.dispatch(binding, {
        projectId: options.projectId,
        toSessionId: input.to,
        title: input.title,
        body: input.body,
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
        ...(input.supersedesTaskId === undefined
          ? {}
          : { supersedesTaskId: input.supersedesTaskId }),
      })
    },
    transition(input) {
      // The panel sends only the target status; resolve the start status from
      // the same write connection so the ledger still validates it strictly.
      let from = input.from
      if (from === undefined) {
        const current = store.ledger.getTask(options.projectId, input.taskId)
        if (!current.ok) return current
        from = current.value.status
      }
      const actor = { kind: 'session' as const, sessionId: options.sessionId, role: options.role }
      // One-step accept: the panel's "通过验收" on a delivered task runs the
      // mandatory delivered→review→verified chain as two real ledger
      // transitions (two events). Each step still passes validation.ts and the
      // SQLite trigger; non-delivered starts keep the old single-step path.
      if (input.to === 'verified' && from === 'delivered') {
        const review = store.ledger.transition({
          projectId: options.projectId,
          taskId: input.taskId,
          from: 'delivered',
          to: 'review',
          actor,
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:review`,
        })
        if (!review.ok) return review
        console.log(`cadre-ledger one-step review project=${options.projectId} task=${input.taskId}`)
        return store.ledger.transition({
          projectId: options.projectId,
          taskId: input.taskId,
          from: 'review',
          to: 'verified',
          actor,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          idempotencyKey: `${input.idempotencyKey ?? crypto.randomUUID()}:verified`,
        })
      }
      // `SqliteTaskLedger.transition` applies `validation.ts`: start-status
      // match, legal rule, reason requirement, and actor permission via the
      // project roster (`SqliteSupervisorResolver`).
      return store.ledger.transition({
        projectId: options.projectId,
        taskId: input.taskId,
        from,
        to: input.to,
        actor,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
      })
    },
    listTasks() {
      // Newest first, same projection as the read-only IPC channel.
      const rows = [...store.ledger.listTasks(options.projectId)].reverse().map(task => ({
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

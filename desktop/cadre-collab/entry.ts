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

/** Open the SQLite collaboration store with a fixed caller identity. */
export function openCadreCollab(options: CadreCollabOptions): CadreCollab {
  const store = new SqliteCollabStore({
    databasePath: options.databasePath,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  })
  const service = new DispatchService(store)
  const binding = { projectId: options.projectId, sessionId: options.sessionId }
  return {
    databasePath: options.databasePath,
    dispatch(input) {
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
      // `SqliteTaskLedger.transition` applies `validation.ts`: start-status
      // match, legal rule, reason requirement, and actor permission via the
      // project roster (`SqliteSupervisorResolver`).
      return store.ledger.transition({
        projectId: options.projectId,
        taskId: input.taskId,
        from,
        to: input.to,
        actor: { kind: 'session', sessionId: options.sessionId, role: options.role },
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

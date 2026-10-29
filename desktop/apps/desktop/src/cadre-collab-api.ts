/** Types for the prebuilt `lib/cadre-collab.cjs` write-path library. */

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
  /** Optional: the write connection resolves the current status when omitted. */
  readonly from?: string
  readonly to: string
  readonly reason?: string
  readonly idempotencyKey?: string
}

export interface CadreTaskRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
}

export interface CadreCollab {
  readonly databasePath: string
  dispatch(input: CadreDispatchInput): unknown
  transition(input: CadreTransitionInput): unknown
  listTasks(): { projectId: string; rows: readonly CadreTaskRow[] }
  close(): void
}

/** Input of the DF-006 `return` disposition (reassign without a status change). */
export interface CadreReturnOpenTasksInput {
  readonly databasePath: string
  readonly projectId: string
  readonly fromSessionId: string
  readonly actorSessionId: string
  readonly taskIds: readonly string[]
  readonly reason?: string
}

/** Result of the DF-006 `return` disposition. */
export type CadreReturnOpenTasksResult =
  | { readonly ok: true; readonly returned: number; readonly replayed: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly taskId?: string }

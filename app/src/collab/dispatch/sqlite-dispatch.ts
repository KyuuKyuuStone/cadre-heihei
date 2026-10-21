/**
 * SQLite 派活/汇报仓储与服务。
 *
 * 与内存实现共用 `DispatchService` 业务逻辑；本文件只负责：
 * - 成员表读写；
 * - 消息落库；
 * - 派活/汇报回执幂等行（与台账级幂等共用 idempotency 表，键空间一致）；
 * - 任务 + 消息 + 审计事件同事务（BEGIN IMMEDIATE）。
 */
import {
  SqliteTaskLedger,
  type LedgerTransaction,
  type SqliteLedgerOptions,
} from '../ledger/index.ts'
import type { IdempotencyKey, IsoTimestamp, ProjectId, SessionId } from '../protocol/index.ts'
import {
  DEFAULT_NEW_ID,
  DEFAULT_NOW,
  DispatchService,
  type DispatchServiceOptions,
} from './dispatch-service.ts'
import type {
  DeliveredMessage,
  DispatchStorePort,
  DispatchTransaction,
  MessageRecord,
  ProjectMembership,
  StoredIdempotent,
} from './store-port.ts'

type Row = Record<string, unknown>

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function numberValue(value: unknown): number {
  return Number(value ?? 0)
}

export interface SqliteCollabStoreOptions {
  readonly databasePath: string
  readonly busyTimeoutMs?: number
  readonly now?: () => IsoTimestamp
  readonly newId?: () => string
}

export class SqliteCollabStore implements DispatchStorePort {
  readonly ledger: SqliteTaskLedger
  private readonly now: () => IsoTimestamp

  constructor(options: SqliteCollabStoreOptions) {
    const ledgerOptions: SqliteLedgerOptions = {
      databasePath: options.databasePath,
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
      now: options.now ?? DEFAULT_NOW,
      newId: options.newId ?? DEFAULT_NEW_ID,
    }
    this.ledger = new SqliteTaskLedger(ledgerOptions)
    this.now = ledgerOptions.now as () => IsoTimestamp
  }

  addMember(membership: ProjectMembership): void {
    const at = this.now()
    this.ledger.core.db
      .prepare(
        `INSERT INTO members (
           project_id, session_id, role, display_name, description, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(project_id, session_id) DO UPDATE SET
           role = excluded.role, state = excluded.state,
           display_name = excluded.display_name, updated_at = excluded.updated_at`,
      )
      .run(
        membership.projectId,
        membership.sessionId,
        membership.role,
        membership.displayName ?? null,
        membership.state,
        at,
        at,
      )
  }

  listMembers(projectId: ProjectId): readonly ProjectMembership[] {
    const rows = this.ledger.core.db
      .prepare(
        `SELECT project_id, session_id, role, state, display_name
         FROM members WHERE project_id = ? ORDER BY rowid ASC`,
      )
      .all(projectId) as Row[]
    return rows.map((row) => ({
      projectId: text(row.project_id) as ProjectId,
      sessionId: text(row.session_id) as SessionId,
      role: text(row.role) as ProjectMembership['role'],
      state: text(row.state) as ProjectMembership['state'],
      ...(row.display_name == null ? {} : { displayName: text(row.display_name) }),
    }))
  }

  listMessageRecords(projectId: ProjectId): readonly MessageRecord[] {
    const rows = this.ledger.core.db
      .prepare(
        `SELECT message_id, project_id, task_id, direction, channel,
                from_session_id, to_session_id, body, body_bytes, body_sha256,
                preview, deliverables_json, idempotency_key, delivered_at
         FROM messages WHERE project_id = ? ORDER BY rowid ASC`,
      )
      .all(projectId) as Row[]
    return rows.map((row) => ({
      messageId: text(row.message_id) as MessageRecord['messageId'],
      projectId: text(row.project_id) as ProjectId,
      taskId: text(row.task_id) as MessageRecord['taskId'],
      direction: text(row.direction) as MessageRecord['direction'],
      channel: text(row.channel) as MessageRecord['channel'],
      fromSessionId: text(row.from_session_id) as SessionId,
      ...(row.to_session_id == null
        ? {}
        : { toSessionId: text(row.to_session_id) as SessionId }),
      body: text(row.body),
      bodyBytes: numberValue(row.body_bytes),
      bodySha256: text(row.body_sha256),
      preview: text(row.preview),
      ...(row.deliverables_json == null
        ? {}
        : { deliverables: JSON.parse(text(row.deliverables_json)) as readonly string[] }),
      idempotencyKey: text(row.idempotency_key) as MessageRecord['idempotencyKey'],
      deliveredAt: text(row.delivered_at) as IsoTimestamp,
    }))
  }

  listMessages(projectId: ProjectId): readonly DeliveredMessage[] {
    const rows = this.ledger.core.db
      .prepare(
        `SELECT message_id, project_id, task_id, direction, channel,
                from_session_id, to_session_id, body_bytes, body_sha256, preview, delivered_at
         FROM messages WHERE project_id = ? ORDER BY rowid ASC`,
      )
      .all(projectId) as Row[]
    return rows.map((row) => ({
      messageId: text(row.message_id) as DeliveredMessage['messageId'],
      projectId: text(row.project_id) as ProjectId,
      taskId: text(row.task_id) as DeliveredMessage['taskId'],
      direction: text(row.direction) as DeliveredMessage['direction'],
      channel: text(row.channel) as DeliveredMessage['channel'],
      fromSessionId: text(row.from_session_id) as SessionId,
      ...(row.to_session_id == null
        ? {}
        : { toSessionId: text(row.to_session_id) as SessionId }),
      bodyBytes: numberValue(row.body_bytes),
      bodySha256: text(row.body_sha256),
      preview: text(row.preview),
      deliveredAt: text(row.delivered_at) as IsoTimestamp,
    }))
  }

  transaction<T>(fn: (tx: DispatchTransaction) => T): T {
    return this.ledger.withTransaction(() => fn(this.tx()))
  }

  close(): void {
    this.ledger.close()
  }

  integrityCheck(): string {
    return this.ledger.integrityCheck()
  }

  journalMode(): string {
    return this.ledger.journalMode()
  }

  private tx(): DispatchTransaction {
    const ledgerTx: LedgerTransaction = this.ledger.tx
    const db = this.ledger.core.db
    return {
      createTask: (command) => ledgerTx.createTask(command),
      transition: (command) => ledgerTx.transition(command),
      getTask: (projectId, taskId) => ledgerTx.getTask(projectId, taskId),
      listTasks: (projectId) => ledgerTx.listTasks(projectId),
      listEvents: (projectId, taskId) => ledgerTx.listEvents(projectId, taskId),
      findMember: (projectId: ProjectId, sessionId: SessionId) => {
        const row = db
          .prepare(
            `SELECT project_id, session_id, role, state, display_name
             FROM members WHERE project_id = ? AND session_id = ?`,
          )
          .get(projectId, sessionId) as Row | undefined
        if (!row) return undefined
        return {
          projectId: text(row.project_id) as ProjectId,
          sessionId: text(row.session_id) as SessionId,
          role: text(row.role) as ProjectMembership['role'],
          state: text(row.state) as ProjectMembership['state'],
          ...(row.display_name == null ? {} : { displayName: text(row.display_name) }),
        }
      },
      appendMessage: (message: MessageRecord) => {
        db.prepare(
          `INSERT INTO messages (
             message_id, project_id, task_id, direction, channel,
             from_session_id, to_session_id, body, body_bytes, body_sha256, preview,
             deliverables_json, idempotency_key, delivery_state, received_at, delivered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?)`,
        ).run(
          message.messageId,
          message.projectId,
          message.taskId,
          message.direction,
          message.channel,
          message.fromSessionId,
          message.toSessionId ?? null,
          message.body,
          message.bodyBytes,
          message.bodySha256,
          message.preview,
          message.deliverables === undefined ? null : JSON.stringify(message.deliverables),
          message.idempotencyKey,
          message.deliveredAt,
          message.deliveredAt,
        )
      },
      findIdempotent: (projectId: ProjectId, key: IdempotencyKey) => {
        const row = db
          .prepare('SELECT * FROM idempotency WHERE project_id = ? AND idempotency_key = ?')
          .get(projectId, key) as Row | undefined
        if (!row) return undefined
        const receiptJson = row.receipt_json == null ? null : text(row.receipt_json)
        return {
          operation: text(row.operation),
          fingerprint: text(row.fingerprint),
          ...(receiptJson === null
            ? {}
            : { receipt: JSON.parse(receiptJson) as StoredIdempotent['receipt'] }),
        }
      },
      saveIdempotent: (projectId: ProjectId, key: IdempotencyKey, entry: StoredIdempotent) => {
        db.prepare(
          `INSERT INTO idempotency (
             project_id, idempotency_key, operation, fingerprint,
             ledger_result_json, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(project_id, idempotency_key) DO NOTHING`,
        ).run(
          projectId,
          key,
          entry.operation,
          entry.fingerprint,
          JSON.stringify(entry.receipt),
          this.now(),
        )
      },
    }
  }
}

export interface SqliteDispatchOptions extends DispatchServiceOptions {
  readonly databasePath: string
  readonly busyTimeoutMs?: number
  readonly members?: readonly ProjectMembership[]
}

export class SqliteDispatchService extends DispatchService {
  readonly sqliteStore: SqliteCollabStore

  constructor(options: SqliteDispatchOptions) {
    const store = new SqliteCollabStore(options)
    super(store, options)
    this.sqliteStore = store
    for (const member of options.members ?? []) this.addMember(member)
  }

  close(): void {
    this.sqliteStore.close()
  }

  integrityCheck(): string {
    return this.sqliteStore.integrityCheck()
  }

  journalMode(): string {
    return this.sqliteStore.journalMode()
  }
}

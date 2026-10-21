/**
 * 内存派活/汇报仓储与默认服务。
 *
 * 业务逻辑在 `dispatch-service.ts`，本文件只提供内存实现，
 * 与 `sqlite-dispatch.ts` 跑同一套契约测试。
 */
import type { IdempotencyKey, ProjectId, SessionId } from '../protocol/index.ts'
import {
  InMemoryTaskLedger,
  type LedgerTransaction,
} from '../ledger/index.ts'
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

export interface InMemoryCollabStoreOptions {
  readonly ledger?: InMemoryTaskLedger
  readonly now?: () => ReturnType<typeof DEFAULT_NOW>
  readonly newId?: () => string
}

export class InMemoryCollabStore implements DispatchStorePort {
  readonly ledger: InMemoryTaskLedger
  private readonly members = new Map<string, Map<string, ProjectMembership>>()
  private readonly messages: MessageRecord[] = []
  private readonly idempotency = new Map<string, StoredIdempotent>()

  constructor(options: InMemoryCollabStoreOptions = {}) {
    this.ledger =
      options.ledger ??
      new InMemoryTaskLedger({
        now: options.now,
        newId: options.newId,
      })
  }

  addMember(membership: ProjectMembership): void {
    const byProject =
      this.members.get(membership.projectId) ?? new Map<string, ProjectMembership>()
    byProject.set(membership.sessionId, membership)
    this.members.set(membership.projectId, byProject)
  }

  listMessages(projectId: ProjectId): readonly DeliveredMessage[] {
    return this.messages
      .filter((message) => message.projectId === projectId)
      .map((message) => ({
        messageId: message.messageId,
        projectId: message.projectId,
        taskId: message.taskId,
        direction: message.direction,
        channel: message.channel,
        fromSessionId: message.fromSessionId,
        ...(message.toSessionId === undefined ? {} : { toSessionId: message.toSessionId }),
        bodyBytes: message.bodyBytes,
        bodySha256: message.bodySha256,
        preview: message.preview,
        deliveredAt: message.deliveredAt,
      }))
  }

  transaction<T>(fn: (tx: DispatchTransaction) => T): T {
    return this.ledger.transaction((ledgerTx) => fn(this.txFor(ledgerTx)))
  }

  private txFor(ledgerTx: LedgerTransaction): DispatchTransaction {
    return {
      createTask: (command) => ledgerTx.createTask(command),
      transition: (command) => ledgerTx.transition(command),
      getTask: (projectId, taskId) => ledgerTx.getTask(projectId, taskId),
      listTasks: (projectId) => ledgerTx.listTasks(projectId),
      listEvents: (projectId, taskId) => ledgerTx.listEvents(projectId, taskId),
      findMember: (projectId: ProjectId, sessionId: SessionId) =>
        this.members.get(projectId)?.get(sessionId),
      appendMessage: (message) => {
        this.messages.push(message)
      },
      findIdempotent: (projectId, key) => this.idempotency.get(this.idemKey(projectId, key)),
      saveIdempotent: (projectId, key, entry) => {
        this.idempotency.set(this.idemKey(projectId, key), entry)
      },
    }
  }

  private idemKey(projectId: ProjectId, key: IdempotencyKey): string {
    return `${projectId}\u0000${key}`
  }
}

export interface InMemoryDispatchOptions extends DispatchServiceOptions {
  readonly ledger?: InMemoryTaskLedger
  readonly members?: readonly ProjectMembership[]
}

/** 兼容 W1-06 的入口：默认使用内存仓储。 */
export class InMemoryDispatchService extends DispatchService {
  constructor(options: InMemoryDispatchOptions = {}) {
    const now = options.now ?? DEFAULT_NOW
    const newId = options.newId ?? DEFAULT_NEW_ID
    super(
      new InMemoryCollabStore({ ledger: options.ledger, now, newId }),
      { now, newId, serverVersion: options.serverVersion },
    )
    for (const member of options.members ?? []) this.addMember(member)
  }
}

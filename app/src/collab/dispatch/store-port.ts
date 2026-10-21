/**
 * 派活/汇报仓储端口与共享运行时类型。
 *
 * 内存与 SQLite 实现共享本接口；事务内的台账操作直接委托 `LedgerTransaction`，
 * 保证「任务 + 消息 + 审计事件 + 幂等回执」落在同一事务。
 */
import type { EmptyList, IdempotencyKey, IsoTimestamp, MemberRole, MemberState, MessageId, ProjectId, SessionId, TaskId } from '../protocol/index.ts'
import type { DispatchReceipt, ReportReceipt } from '../protocol/index.ts'
import type { LedgerTransaction, TaskLedgerPort } from '../ledger/index.ts'

export interface CallerBinding {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
}

export interface ProjectMembership {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly role: MemberRole
  readonly state: MemberState
  readonly displayName?: string
}

export interface DeliveredMessage {
  readonly messageId: MessageId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly direction: 'dispatch' | 'report'
  readonly channel: 'http'
  readonly fromSessionId: SessionId
  readonly toSessionId?: SessionId
  readonly bodyBytes: number
  readonly bodySha256: string
  readonly preview: string
  readonly deliveredAt: IsoTimestamp
}

/** 入库形态：比对外回执多正文与幂等键（messages 表字段）。 */
export interface MessageRecord extends DeliveredMessage {
  readonly body: string
  readonly idempotencyKey: IdempotencyKey
  /** 汇报交付物清单；派活消息缺省。 */
  readonly deliverables?: readonly string[]
}

export interface NonEmptyList<T> {
  readonly items: readonly T[]
  readonly empty: false
}

/** 列表返回：空时必须 `empty: true` + `reason` + `hint`（铁律 11）。 */
export type ListResult<T> = EmptyList<T> | NonEmptyList<T>

export interface StoredIdempotent {
  /** 台账级幂等行（create/transition）也在此表，故 operation 可能不是 dispatch/report。 */
  readonly operation: string
  readonly fingerprint: string
  /** 仅派活/汇报行有回执；台账级行缺省。 */
  readonly receipt?: DispatchReceipt | ReportReceipt
}

export interface DispatchTransaction extends LedgerTransaction {
  findMember(projectId: ProjectId, sessionId: SessionId): ProjectMembership | undefined
  appendMessage(message: MessageRecord): void
  findIdempotent(projectId: ProjectId, key: IdempotencyKey): StoredIdempotent | undefined
  saveIdempotent(projectId: ProjectId, key: IdempotencyKey, entry: StoredIdempotent): void
}

export interface DispatchStorePort {
  readonly ledger: TaskLedgerPort
  transaction<T>(fn: (tx: DispatchTransaction) => T): T
  listMessages(projectId: ProjectId): readonly DeliveredMessage[]
  /** 工具层详情用：含正文与交付物。 */
  listMessageRecords(projectId: ProjectId): readonly MessageRecord[]
  listMembers(projectId: ProjectId): readonly ProjectMembership[]
  addMember(membership: ProjectMembership): void
}

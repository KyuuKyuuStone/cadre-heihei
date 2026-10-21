/**
 * 汇报请求/回执契约。
 *
 * W1-04 类型草案；契约来源 `docs/product/backend/01` §2.3/§2.4。
 */
import type { ApiVersion, IdempotencyKey, IsoTimestamp, MessageId, ProjectId, TaskId } from './ids.ts'
import type { BodyReceipt, Channel, LedgerUpdate, ServerMeta } from './common.ts'
import type { TaskStatus } from './task-status.ts'

export interface ReportRequest {
  readonly projectId: ProjectId
  /** 汇报必须显式指定；不做自动匹配（用户已废弃「自动挂最老 open」）。 */
  readonly taskId: TaskId
  readonly body: string
  readonly idempotencyKey: IdempotencyKey
  /** 交付物路径清单；验收按铁律 4 做哈希查重 + 亲眼核。 */
  readonly deliverables: readonly string[]
}

/**
 * 入口校验形态：`taskId` 可缺失，缺失时必须返回 `MISSING_TASK_ID` + 候选，
 * 不得自动挂靠（backend/01 §2.4）。
 */
export type ReportRequestInput = Omit<ReportRequest, 'taskId'> & { readonly taskId?: TaskId }

/**
 * 汇报规则（backend/01 §2.4；`testing/01` §3.3）。
 */
export const REPORT_RULES = {
  taskIdRequired: true,
  autoMatchOldestOpen: false,
  candidateScope: 'same-project-and-same-assignee-non-terminal',
  candidateLimit: 10,
  /** 投递成功时系统以员工名义原子推进 in_progress → delivered。 */
  advanceOnDelivery: 'in_progress->delivered',
  advanceActor: 'system',
  duplicateIdempotencyKeyReturnsFirstReceipt: true,
} as const

export interface ReportReceiptBase extends BodyReceipt, ServerMeta {
  readonly ok: true
  readonly apiVersion: ApiVersion
  readonly messageId: MessageId
  readonly taskId: TaskId
  readonly projectId: ProjectId
  readonly channel: Channel
  /** 首次提交时的状态；重复 idempotencyKey 返回首次回执语义。 */
  readonly taskStatusBefore: TaskStatus
  /** 当前状态；重放时可能已是 delivered/verified 等。 */
  readonly taskStatusAfter: TaskStatus
  readonly deliveredAt: IsoTimestamp
}

/**
 * 汇报回执。消息已投递但状态推进失败时：`ok: true` + `ledgerUpdated: false` + `ledgerError`，
 * 不得伪报成功（backend/01 §2.3、铁律 8）。
 */
export type ReportReceipt = ReportReceiptBase & LedgerUpdate

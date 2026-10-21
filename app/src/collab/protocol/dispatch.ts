/**
 * 派活请求/回执契约。
 *
 * W1-04 类型草案；契约来源 `docs/product/backend/01` §2.1/§2.2、§3。
 */
import type { ApiVersion, IdempotencyKey, IsoTimestamp, MessageId, ProjectId, SessionId, TaskId } from './ids.ts'
import type { BodyReceipt, Channel, LedgerUpdate, ServerMeta } from './common.ts'

export interface DispatchRequest {
  /** 必须与调用方会话绑定一致；不一致即 CROSS_PROJECT_DENIED（backend/01 §3）。 */
  readonly projectId: ProjectId
  readonly toSessionId: SessionId
  readonly title: string
  /** 派活原文不裁剪；回执按实收正文计算 bodyBytes/bodySha256。 */
  readonly body: string
  /** 调用方生成，必填；`(project_id, idempotency_key)` 唯一。 */
  readonly idempotencyKey: IdempotencyKey
  /** 指定时旧任务自动 cancelled（reason=superseded），禁止静默并存。 */
  readonly supersedesTaskId?: TaskId
}

/**
 * 派活前置校验（backend/01 §2.1/§2.5、`05` 第 8 条）。
 * 拒绝空正文、客户端命令；目标必须属于本项目且非 offline。
 */
export const DISPATCH_PRECHECKS = {
  rejectEmptyBody: true,
  rejectClientCommands: true,
  requireTargetMemberOfProject: true,
  requireTargetNotOffline: true,
} as const

/** 取代语义（铁律 6）：旧任务置 cancelled，新任务指向旧任务。 */
export const DISPATCH_SUPERSEDE_RULE = {
  oldTaskStatus: 'cancelled',
  reason: 'superseded',
  silentCoexistence: false,
} as const

export interface DispatchReceiptBase extends BodyReceipt, ServerMeta {
  readonly ok: true
  readonly apiVersion: ApiVersion
  readonly taskId: TaskId
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly channel: Channel
  readonly taskStatus: 'dispatched'
  /** 已投递到目标会话的时间（服务端生成）。 */
  readonly deliveredAt: IsoTimestamp
}

/**
 * 派活回执。`ledgerUpdated: false` 时消息已发但台账未推进，必须带 `ledgerError`，
 * 不得伪报成功（backend/01 §2.3、铁律 8）。
 */
export type DispatchReceipt = DispatchReceiptBase & LedgerUpdate

/**
 * MCP 工具输出类型（U-MCP-06 裁决）。
 *
 * 只定义类型与注释，不含运行时逻辑。字段来源：
 * - `TaskSummary`：`backend/01` §1.2 `tasks` 表 + `frontend/01` §3.2 摘要项；
 * - `TransitionReceipt`：`backend/01` §1.2 `task_events` / §1.3 状态机 + `frontend/01` §3.2；
 * - `TaskDetail`：U-IPC-01 裁决，MCP `get_task` 与 IPC `collab:getTask` 共用；
 * - `SendMessageReceipt`：U-IPC-02 裁决，IPC `session:send` 回执。
 * 不在两处契约中出现的字段不得加入本文件。
 */
import type { EventId, IsoTimestamp, MessageId, ProjectId, SessionId, TaskId } from './ids.ts'
import type { BodyReceipt, LedgerUpdate } from './common.ts'
import type { TaskStatus } from './task-status.ts'

/**
 * `list_tasks` 的摘要项。不包含正文与汇报全文（详情走 `get_task`）。
 */
export interface TaskSummary {
  readonly taskId: TaskId
  readonly projectId: ProjectId
  /** 项目内自增序号（`UNIQUE(project_id, seq)`）。 */
  readonly seq: number
  readonly title: string
  readonly status: TaskStatus
  readonly assigneeSessionId: SessionId
  /** 展示用名称（`frontend/01` §3.2 的 workerName）；非持久化字段。 */
  readonly assigneeName?: string
  /** rework 次数；首次为 0。 */
  readonly attempt: number
  readonly updatedAt: IsoTimestamp
  readonly deliveredAt?: IsoTimestamp
}

/**
 * `review_task`（以及任何台账迁移工具）的推进回执。
 *
 * `ledgerUpdated: false` 时消息/命令已受理但台账未推进，必须附 `ledgerError`，
 * 不得伪报成功（`backend/01` §2.3、铁律 8）。
 */
export interface TransitionReceiptBase {
  readonly taskId: TaskId
  readonly from: TaskStatus
  readonly to: TaskStatus
  /** 迁移后的 attempt；rework 时 +1。 */
  readonly attempt: number
  readonly updatedAt: IsoTimestamp
  /** 本次迁移的原因；`rework` / `failed` / `cancelled` 必填。 */
  readonly reason?: string
  /** 审计事件 ID（`task_events.event_id`）。 */
  readonly eventId?: EventId
  /** 实际执行者会话；系统自动推进时为受委托的员工会话。 */
  readonly actorSessionId?: SessionId
  /** 迁移后的乐观锁版本（`tasks.version`）。 */
  readonly version?: number
}

export type TransitionReceipt = TransitionReceiptBase & LedgerUpdate

/**
 * 审计迁移记录（`backend/01` §1.2 `task_events`；`frontend/01` §3.2 详情 transitions）。
 */
export interface TaskTransitionRecord {
  /** 创建事件没有前态（`task_events.from_status` 可空）。 */
  readonly from: TaskStatus | null
  readonly to: TaskStatus
  readonly at: IsoTimestamp
  /** 系统自动推进时为 `'system'`（`task_events.actor_session_id`）。 */
  readonly actorSessionId: SessionId | 'system'
  readonly reason?: string
  readonly eventId?: EventId
}

/**
 * `get_task` 详情中的汇报摘要（`frontend/01` §3.2 的 report 字段）。
 */
export interface TaskReportSummary {
  /** 汇报正文（沿用 `frontend/01` §3.2 的字段名 `summary`）。 */
  readonly summary: string
  readonly deliverables: readonly string[]
  readonly bodyBytes: number
  readonly preview: string
  readonly messageId: MessageId
}

/**
 * `get_task`（MCP 工具）与 `collab:getTask`（IPC）共用的任务详情（U-IPC-01 裁决）。
 *
 * 字段来源：`TaskSummary` 全部字段 + `backend/01` §1.2 `tasks.body` / `tasks.version`
 * + `frontend/01` §3.2 详情项（transitions / report / sourceSessionId）。
 * `sourceSessionId` 等价于 `tasks.dispatcher_session_id`（派活来源会话），两者同义，
 * 本类型只保留 `sourceSessionId`，不重复定义 `dispatcherSessionId`。
 */
export interface TaskDetail extends TaskSummary {
  readonly body: string
  readonly transitions: readonly TaskTransitionRecord[]
  readonly report: TaskReportSummary | null
  readonly sourceSessionId: SessionId
  readonly version: number
}

/**
 * `session:send` 回执（U-IPC-02 裁决）：复用 `BodyReceipt` 的实收自证字段
 * （`bodyBytes` / `preview` / `bodySha256`），另加消息 ID 与受理时间。
 */
export interface SendMessageReceipt extends BodyReceipt {
  readonly messageId: MessageId
  readonly acceptedAt: IsoTimestamp
}

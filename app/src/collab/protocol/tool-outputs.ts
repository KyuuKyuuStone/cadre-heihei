/**
 * MCP 工具输出类型（U-MCP-06 裁决）。
 *
 * 只定义类型与注释，不含运行时逻辑。字段来源：
 * - `TaskSummary`：`backend/01` §1.2 `tasks` 表 + `frontend/01` §3.2 摘要项；
 * - `TransitionReceipt`：`backend/01` §1.2 `task_events` / §1.3 状态机 + `frontend/01` §3.2。
 * 不在两处契约中出现的字段不得加入本文件。
 */
import type { EventId, IsoTimestamp, ProjectId, SessionId, TaskId } from './ids.ts'
import type { LedgerUpdate } from './common.ts'
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

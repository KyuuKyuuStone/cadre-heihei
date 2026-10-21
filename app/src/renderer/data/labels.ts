import type { TextKey } from '../i18n/index.ts'
import type { TaskStatus } from '../../collab/protocol/task-status.ts'
import type { MemberRole, MemberState } from '../../collab/protocol/roster.ts'

/** 台账状态徽标文案（协议 TaskStatus 全量）。 */
export const TASK_STATUS_LABEL_KEYS: Record<TaskStatus, TextKey> = {
  dispatched: 'task.status.dispatched',
  accepted: 'task.status.accepted',
  in_progress: 'task.status.in_progress',
  delivered: 'task.status.delivered',
  review: 'task.status.review',
  verified: 'task.status.verified',
  rework: 'task.status.rework',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled',
}

/** 筛选值（UI 专用；协议常量是值导出，renderer 只允许 protocol 类型）。 */
export const TASK_FILTERS = [
  'all',
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'review',
  'verified',
  'rework',
  'failed',
  'cancelled',
] as const satisfies readonly (TaskStatus | 'all')[]

export const ROLE_LABEL_KEYS: Record<MemberRole, TextKey> = {
  supervisor: 'roster.role.supervisor',
  worker: 'roster.role.worker',
}

export const MEMBER_STATE_LABEL_KEYS: Record<MemberState, TextKey> = {
  available: 'roster.state.available',
  busy: 'roster.state.busy',
  offline: 'roster.state.offline',
}

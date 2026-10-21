/**
 * 台账状态机、迁移权限矩阵、review 必经、rework 与取代语义。
 *
 * W1-04 类型草案；契约唯一来源 `docs/product/backend/01-数据契约草案.md` §1.3。
 * 本文件只描述「允许什么」，不实现迁移函数（实现属 M1，W1-05 另行派单）。
 */
import type { IdempotencyKey, ProjectId, SessionId, TaskId } from './ids.ts'

export const TASK_STATUSES = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'review',
  'verified',
  'rework',
  'failed',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 终态不再迁移；重复请求返回当前状态，不改写（backend/01 §1.3）。 */
export const TERMINAL_TASK_STATUSES = ['verified', 'failed', 'cancelled'] as const
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number]

export const NON_TERMINAL_TASK_STATUSES = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'review',
  'rework',
] as const
export type NonTerminalTaskStatus = (typeof NON_TERMINAL_TASK_STATUSES)[number]

/**
 * 漏 taskId 时的候选范围（backend/01 §2.4）：
 * 同项目 + 同汇报会话 + 非终态，且**不含** delivered/review。
 */
export const OPEN_REPORT_CANDIDATE_STATUSES = ['dispatched', 'accepted', 'in_progress', 'rework'] as const

/** 迁移执行者：员工本人、主管、系统（以员工名义自动推进）。 */
export type TransitionActorKind = 'assignee' | 'supervisor' | 'system'

export interface TaskTransitionRule {
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly actors: readonly TransitionActorKind[]
  readonly note: string
}

/**
 * 迁移权限矩阵（单一事实源）。规则之外的组合一律 `INVALID_TRANSITION`；
 * 规则内但执行者不符一律 `FORBIDDEN_ACTOR`。
 */
export const TASK_TRANSITION_RULES: readonly TaskTransitionRule[] = [
  { from: 'dispatched', to: 'accepted', actors: ['assignee'], note: '员工接受派活' },
  { from: 'dispatched', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
  { from: 'accepted', to: 'in_progress', actors: ['assignee'], note: '员工开始执行' },
  { from: 'accepted', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
  {
    from: 'in_progress',
    to: 'delivered',
    actors: ['assignee', 'system'],
    note: '汇报投递成功时由系统以员工名义原子推进；员工手动交付亦允许',
  },
  { from: 'in_progress', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
  {
    from: 'delivered',
    to: 'review',
    actors: ['supervisor'],
    note: 'review 为必经态；由主管点名进入（review/01 §4）',
  },
  { from: 'delivered', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
  { from: 'review', to: 'verified', actors: ['supervisor'], note: '验收通过' },
  { from: 'review', to: 'rework', actors: ['supervisor'], note: '返工，保留同一 taskId' },
  { from: 'review', to: 'failed', actors: ['supervisor'], note: '验收失败' },
  { from: 'review', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
  { from: 'rework', to: 'in_progress', actors: ['assignee'], note: '返工继续，无需重新 accepted' },
  { from: 'rework', to: 'cancelled', actors: ['supervisor'], note: '非终态可取消' },
]

/**
 * 状态机不变量（判据文字化，供 W1-05 表驱动测试逐条断言）。
 */
export const TASK_LEDGER_RULES = {
  terminalStatesImmutable: true,
  reviewIsMandatory: true,
  deliveredCannotSkipReview: true,
  reworkKeepsTaskId: true,
  reworkAttemptIncrement: 1,
  transitionWritesAuditEvent: true,
  deliveredAdvanceIsAtomicWithReportDelivery: true,
} as const

/** rework 语义：同一 taskId、attempt +1、回到 in_progress。 */
export interface ReworkSemantics {
  readonly keepsTaskId: true
  readonly attemptIncrement: 1
  readonly returnsTo: 'in_progress'
}

/**
 * 取代语义：新派活可带 `supersedesTaskId`；旧任务自动置 cancelled。
 * 禁止静默并存两条冲突指令（铁律 6）。
 */
export interface TaskSupersedeLink {
  readonly supersedesTaskId?: TaskId
  readonly supersededByTaskId?: TaskId
}

export const SUPERSEDE_RULE = {
  oldTaskStatus: 'cancelled',
  reason: 'superseded',
  silentCoexistence: false,
} as const

/** 一次状态迁移命令（服务端校验权限与合法性后落库并写审计事件）。 */
export interface TaskTransitionCommand {
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly actor: TaskTransitionActor
  readonly reason?: string
  readonly idempotencyKey: IdempotencyKey
}

export type TaskTransitionActor =
  | {
      readonly kind: 'session'
      readonly sessionId: SessionId
      readonly role: 'assignee' | 'supervisor'
    }
  | {
      readonly kind: 'system'
      /** 系统自动推进时的员工会话（汇报投递成功 → delivered）。 */
      readonly onBehalfOf: SessionId
    }

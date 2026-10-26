/**
 * 台账状态机的纯规则查询层。
 *
 * 唯一事实源是 `protocol/task-status.ts` 的 `TASK_TRANSITION_RULES`；
 * 本文件不复制矩阵，只做查表与派生，供内存仓储与表驱动测试共用。
 */
import {
  TASK_STATUSES,
  TASK_TRANSITION_RULES,
  TERMINAL_TASK_STATUSES,
  type ReasonRequiredStatus,
  type TaskStatus,
  type TaskTransitionRule,
  type TransitionActorKind,
} from '../protocol/index.ts'

/** 目标态要求 reason 的状态（backend/01 §1.2，契约 errors.ts 的 ReasonRequiredStatus）。 */
export const REASON_REQUIRED_STATUSES: readonly ReasonRequiredStatus[] = ['rework', 'failed', 'cancelled']

export function requiresReason(to: TaskStatus): to is ReasonRequiredStatus {
  return (REASON_REQUIRED_STATUSES as readonly TaskStatus[]).includes(to)
}

export interface LegalTransition {
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly actors: readonly TransitionActorKind[]
}

/** 查一条迁移规则；不存在即非法迁移。 */
export function findTransitionRule(from: TaskStatus, to: TaskStatus): TaskTransitionRule | undefined {
  return TASK_TRANSITION_RULES.find((rule) => rule.from === from && rule.to === to)
}

export function isTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return findTransitionRule(from, to) !== undefined
}

/** 规则允许的执行者；非法迁移返回空数组（调用方应先判非法）。 */
export function allowedActorsFor(from: TaskStatus, to: TaskStatus): readonly TransitionActorKind[] {
  return findTransitionRule(from, to)?.actors ?? []
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status)
}

export function isKnownStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

export function listLegalTransitions(): readonly LegalTransition[] {
  return TASK_TRANSITION_RULES.map((rule) => ({
    from: rule.from,
    to: rule.to,
    actors: rule.actors,
  }))
}

/** 全部状态组合中不属于 `TASK_TRANSITION_RULES` 的部分（含自环与终态出边）。 */
export function listIllegalTransitionPairs(): readonly { from: TaskStatus; to: TaskStatus }[] {
  const legal = new Set(TASK_TRANSITION_RULES.map((rule) => `${rule.from}->${rule.to}`))
  const pairs: { from: TaskStatus; to: TaskStatus }[] = []
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      if (!legal.has(`${from}->${to}`)) pairs.push({ from, to })
    }
  }
  return pairs
}

/** review 必经：delivered 只允许进 review / cancelled，不得直达终态或 rework。 */
export function deliveredMustPassReview(): boolean {
  return (
    isTransitionAllowed('delivered', 'review') &&
    !isTransitionAllowed('delivered', 'verified') &&
    !isTransitionAllowed('delivered', 'rework') &&
    !isTransitionAllowed('delivered', 'failed')
  )
}

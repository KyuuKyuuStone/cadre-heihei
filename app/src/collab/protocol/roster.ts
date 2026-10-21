/**
 * 花名册、项目隔离与双口径（全局在册 vs 本项目可用）。
 *
 * W1-04 类型草案；契约来源 `docs/product/backend/01` §1.2/§3、
 * `docs/product/frontend/01` §1.3/§3.3、`docs/handover/02` 铁律 11。
 */
import type { ApiVersion, IsoTimestamp, ProjectId, SessionId } from './ids.ts'
import type { EmptyReason } from './common.ts'

export const MEMBER_ROLES = ['supervisor', 'worker'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const MEMBER_STATES = ['available', 'busy', 'offline'] as const
export type MemberState = (typeof MEMBER_STATES)[number]

export interface ProjectSummary {
  readonly projectId: ProjectId
  readonly name: string
  readonly current: boolean
  readonly updatedAt: IsoTimestamp
}

export interface MemberSummary {
  readonly sessionId: SessionId
  readonly displayName: string
  readonly role: MemberRole
  readonly state: MemberState
  readonly projectId: ProjectId
  /** 本项目内可派活；全局花名册恒为 false。 */
  readonly dispatchable: boolean
  readonly dispatchableReason?: string
}

/** 项目视图：只能看到本项目成员。 */
export interface ProjectScope {
  readonly kind: 'project'
  readonly projectId: ProjectId
}

/** 全局视图：只能读摘要，不可派活、不可进入会话（backend/01 §3）。 */
export interface GlobalScope {
  readonly kind: 'global'
  readonly projectMatched: false
  readonly dispatchable: false
}

export type RosterScope = ProjectScope | GlobalScope

/**
 * 双口径摘要：`globalCount` 与 `dispatchableCount` 必须同屏区分，不得混用；
 * 空结果必须带 `reason` 与下一步 `hint`（铁律 11）。
 */
export interface ScopeSummary {
  readonly scope: RosterScope
  readonly globalCount: number
  readonly dispatchableCount: number
  readonly projectMatched: boolean
  readonly reason?: EmptyReason
  readonly hint?: string
}

/** 全局摘要中本项目可派活数恒为 0。 */
export interface GlobalScopeSummary extends ScopeSummary {
  readonly scope: GlobalScope
  readonly dispatchableCount: 0
}

/**
 * 项目隔离策略（backend/01 §3）：
 * - project_id 取自调用方会话绑定，忽略请求体；
 * - 跨项目一律拒绝，错误不区分「不存在」与「无权」；
 * - 隔离由存储层强制，不依赖调用方过滤。
 */
export const PROJECT_ISOLATION_POLICY = {
  projectIdSource: 'caller-session-binding',
  ignoresRequestBodyProjectId: true,
  crossProject: 'deny-without-existence-disclosure',
  enforcedAt: 'storage-and-application',
} as const

/** 花名册查询的对外响应包装（成功态）。 */
export interface RosterResponse {
  readonly ok: true
  readonly apiVersion: ApiVersion
  readonly projects: readonly ProjectSummary[]
  readonly members: readonly MemberSummary[]
  readonly scope: ScopeSummary
}

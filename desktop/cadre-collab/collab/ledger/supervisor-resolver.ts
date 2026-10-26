/**
 * supervisor 判定抽象（ADR-0019）。
 *
 * 权威口径是项目花名册 `members(project_id, session_id, role='supervisor')`；
 * `dispatcherSessionId` 不参与权限判定，仅作审计。
 *
 * 同步接口：命令入口必须先解析，再把已解析的 actor.role 传入台账；
 * 解析失败必须 fail-closed，不得回退到 dispatcher 推断。
 */
import type { ProjectId, SessionId } from '../protocol/index.ts'

export interface SupervisorResolver {
  isSupervisor(projectId: ProjectId, sessionId: SessionId): boolean | 'unavailable'
}

/** 默认 fail-closed：没有可用花名册时不放行任何 supervisor 迁移。 */
export class UnavailableSupervisorResolver implements SupervisorResolver {
  isSupervisor(): 'unavailable' {
    return 'unavailable'
  }
}

export interface PrototypeSupervisorEntry {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
}

/**
 * **prototypeOnly，非产品默认**：静态 supervisor 名单。
 *
 * 限制（ADR-0019）：
 * - 仅适用于「单主管 / 无换届 / 无代派」的内存原型与单元测试；
 * - 不读取花名册，不支持主管上任/撤销、会话重建与多主管运维；
 * - 测试可在静态名单里登记多个 ID 以覆盖 ADR 验收场景，但这**不构成花名册权威**，
 *   生产（SQLite）必须使用 `SqliteSupervisorResolver` 查询 members 表；
 * - 一旦出现换届、代派或多主管运维，此桩立即失效。
 */
export class PrototypeOnlySupervisorResolver implements SupervisorResolver {
  readonly prototypeOnly = true
  private readonly supervisors: ReadonlyMap<string, ReadonlySet<string>>

  constructor(entries: readonly PrototypeSupervisorEntry[]) {
    const byProject = new Map<string, Set<string>>()
    for (const entry of entries) {
      const set = byProject.get(entry.projectId) ?? new Set<string>()
      set.add(entry.sessionId)
      byProject.set(entry.projectId, set)
    }
    this.supervisors = byProject
  }

  isSupervisor(projectId: ProjectId, sessionId: SessionId): boolean {
    return this.supervisors.get(projectId)?.has(sessionId) ?? false
  }
}

/** M2 工具层公共类型：注入身份与后端能力（不 import harness）。 */
import type {
  CallerBinding,
  DispatchOutcome,
  MessageRecord,
  ProjectMembership,
  ReportOutcome,
} from '../dispatch/index.ts'
import type { TaskLedgerPort } from '../ledger/index.ts'
import type { DispatchRequest, ProjectId, ReportRequestInput, SessionId } from '../protocol/index.ts'

export interface ToolIdentity {
  /** 启动时注入（args/env），唯一可信身份。 */
  readonly sessionId: SessionId
  readonly projectId: ProjectId
}

/**
 * 工具层依赖：`DispatchService` 结构上满足本接口。
 * 权限判定所需成员表与任务台账均从此读取，不复制业务规则。
 */
export interface ToolBackend {
  readonly ledger: TaskLedgerPort
  dispatch(binding: CallerBinding, request: DispatchRequest): DispatchOutcome
  report(binding: CallerBinding, request: ReportRequestInput): ReportOutcome
  listMembers(projectId: ProjectId): readonly ProjectMembership[]
  listMessageRecords(projectId: ProjectId): readonly MessageRecord[]
}

export interface ToolContext {
  readonly identity: ToolIdentity
  readonly backend: ToolBackend
}

export interface ToolCallResult {
  readonly payload: unknown
  readonly isError: boolean
}

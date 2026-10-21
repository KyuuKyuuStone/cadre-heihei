/**
 * 派活/汇报的内存实现（W1-06）。
 *
 * 只做运行时校验与投递编排：不接 HTTP、不接真实 harness、不落 SQLite。
 * 契约字段全部来自 `protocol/`；本文件不扩展协议字段。
 *
 * 校验顺序（各校验互不依赖，顺序仅决定多重错误时先报哪个）：
 *   会话绑定 → 幂等重放 → 空正文 → 客户端命令（仅派活）→ 目标成员（仅派活）
 *   → 台账操作 → 回执
 */
import {
  API_VERSION,
  CANDIDATE_LIMIT,
  OPEN_REPORT_CANDIDATE_STATUSES,
  type ApiError,
  type ClientCommandRejectedFailure,
  type CrossProjectDeniedFailure,
  type DispatchReceipt,
  type DispatchRequest,
  type EmptyBodyFailure,
  type EmptyList,
  type ForbiddenActorFailure,
  type IdempotencyConflictFailure,
  type InvalidTransitionFailure,
  type IsoTimestamp,
  type MemberRole,
  type MemberState,
  type MessageId,
  type MissingTaskIdFailure,
  type ProjectId,
  type ReportReceipt,
  type ReportRequestInput,
  type SessionId,
  type TaskCandidate,
  type TaskCandidateStatus,
  type TaskId,
  type TaskNotFoundFailure,
  type TaskStatus,
} from '../protocol/index.ts'
import { InMemoryTaskLedger, type LedgerError, type TaskRecord } from '../ledger/index.ts'
import { buildBodyReceipt } from './body-receipt.ts'
import { matchClientCommand } from './client-command.ts'

/** 调用方会话绑定：projectId 的唯一来源，忽略请求体中的 projectId。 */
export interface CallerBinding {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
}

export interface ProjectMembership {
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  readonly role: MemberRole
  readonly state: MemberState
}

export interface InMemoryDispatchOptions {
  readonly ledger?: InMemoryTaskLedger
  readonly now?: () => IsoTimestamp
  readonly newId?: () => string
  readonly serverVersion?: string
  readonly members?: readonly ProjectMembership[]
}

export interface DeliveredMessage {
  readonly messageId: MessageId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly direction: 'dispatch' | 'report'
  readonly channel: 'http'
  readonly fromSessionId: SessionId
  readonly toSessionId?: SessionId
  readonly bodyBytes: number
  readonly bodySha256: string
  readonly preview: string
  readonly deliveredAt: IsoTimestamp
}

export interface NonEmptyList<T> {
  readonly items: readonly T[]
  readonly empty: false
}

/** 列表返回：空时必须 `empty: true` + `reason` + `hint`（铁律 11）。 */
export type ListResult<T> = EmptyList<T> | NonEmptyList<T>

export type DispatchOutcome = DispatchReceipt | ApiError
export type ReportOutcome = ReportReceipt | ApiError

interface StoredReceipt {
  readonly operation: 'dispatch' | 'report'
  readonly fingerprint: string
  readonly receipt: DispatchReceipt | ReportReceipt
}

const DEFAULT_SERVER_VERSION = 'cadre-heihei-dev'
const MISSING_TASK_ID_HINT = '请从候选中选择一条并在汇报中显式提供 taskId 后重试'
const MISSING_TASK_ID_EMPTY_HINT = '当前没有可汇报的未结任务；请确认 taskId，或请主管重新派单'
const CANDIDATES_EMPTY_HINT = '暂无待汇报任务；任务派发后可在此查看'
const MESSAGES_EMPTY_HINT = '当前项目还没有投递记录'

function crossProjectDenied(projectId: ProjectId): CrossProjectDeniedFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'CROSS_PROJECT_DENIED',
      message: '跨项目请求已拒绝',
      retryable: false,
      projectId,
    },
  }
}

function emptyBody(): EmptyBodyFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: { code: 'EMPTY_BODY', message: '正文不能为空', retryable: false, field: 'body' },
  }
}

function clientCommandRejected(command: string): ClientCommandRejectedFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'CLIENT_COMMAND_REJECTED',
      message: `派活正文不得是客户端命令：${command}`,
      retryable: false,
      command,
    },
  }
}

function idempotencyConflict(idempotencyKey: DispatchRequest['idempotencyKey']): IdempotencyConflictFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: '同一幂等键已用于不同请求',
      retryable: false,
      idempotencyKey,
    },
  }
}

function forbiddenTarget(
  projectId: ProjectId,
  targetSessionId: SessionId,
  reasonCategory: 'target-not-member' | 'target-offline',
): ForbiddenActorFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'FORBIDDEN_ACTOR',
      message:
        reasonCategory === 'target-not-member' ? '目标会话不属于本项目' : '目标会话当前离线',
      retryable: false,
      projectId,
      targetSessionId,
      reasonCategory,
    },
  }
}

function taskNotFound(projectId: ProjectId, taskId: TaskId): TaskNotFoundFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'TASK_NOT_FOUND',
      message: `任务不存在：${taskId}`,
      retryable: false,
      projectId,
      taskId,
    },
  }
}

function internalError(message: string, rawCode?: string): ApiError {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'INTERNAL_ERROR',
      message,
      retryable: false,
      ...(rawCode === undefined ? {} : { rawCode }),
    },
  }
}

function invalidTransitionFromLedger(error: LedgerError, fallbackTaskId: TaskId): InvalidTransitionFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: {
      code: 'INVALID_TRANSITION',
      message: error.message,
      retryable: false,
      projectId: error.projectId,
      taskId: error.taskId ?? fallbackTaskId,
      from: error.from ?? 'dispatched',
      to: error.to ?? 'cancelled',
    },
  }
}

function ledgerFailureToApiError(error: LedgerError, request: DispatchRequest): ApiError {
  switch (error.code) {
    case 'TASK_NOT_FOUND':
      return taskNotFound(error.projectId, error.taskId ?? (request.supersedesTaskId as TaskId))
    case 'CROSS_PROJECT_DENIED':
      return crossProjectDenied(error.projectId)
    case 'INVALID_TRANSITION':
      return invalidTransitionFromLedger(
        error,
        error.taskId ?? request.supersedesTaskId ?? ('' as TaskId),
      )
    case 'MISSING_REASON':
      return internalError(error.message, 'MISSING_REASON')
    default:
      return internalError(error.message, error.code)
  }
}

function candidateOf(task: TaskRecord): TaskCandidate {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status as TaskCandidateStatus,
    updatedAt: task.updatedAt,
    assigneeSessionId: task.assigneeSessionId,
  }
}

export class InMemoryDispatchService {
  readonly ledger: InMemoryTaskLedger
  private readonly now: () => IsoTimestamp
  private readonly newId: () => string
  private readonly serverVersion: string
  private readonly members = new Map<string, Map<string, ProjectMembership>>()
  private readonly messages: DeliveredMessage[] = []
  private readonly idempotency = new Map<string, StoredReceipt>()

  constructor(options: InMemoryDispatchOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString() as IsoTimestamp)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION
    this.ledger = options.ledger ?? new InMemoryTaskLedger({ now: this.now, newId: this.newId })
    for (const member of options.members ?? []) this.addMember(member)
  }

  addMember(membership: ProjectMembership): void {
    const projectMembers = this.members.get(membership.projectId) ?? new Map<string, ProjectMembership>()
    projectMembers.set(membership.sessionId, membership)
    this.members.set(membership.projectId, projectMembers)
  }

  dispatch(binding: CallerBinding, request: DispatchRequest): DispatchOutcome {
    if (request.projectId !== binding.projectId) return crossProjectDenied(binding.projectId)

    const fingerprint = JSON.stringify([
      'dispatch',
      request.toSessionId,
      request.title,
      request.body,
      request.supersedesTaskId ?? '',
    ])
    const replay = this.lookupReplay<DispatchReceipt>(
      binding.projectId,
      request.idempotencyKey,
      'dispatch',
      fingerprint,
    )
    if (replay === 'conflict') return idempotencyConflict(request.idempotencyKey)
    if (replay !== 'miss') return replay

    if (request.body.trim() === '') return emptyBody()
    const command = matchClientCommand(request.body)
    if (command !== null) return clientCommandRejected(command)

    const member = this.members.get(binding.projectId)?.get(request.toSessionId)
    if (!member) return forbiddenTarget(binding.projectId, request.toSessionId, 'target-not-member')
    if (member.state === 'offline') {
      return forbiddenTarget(binding.projectId, request.toSessionId, 'target-offline')
    }

    const bodyReceipt = buildBodyReceipt(request.body)
    const deliveredAt = this.now()
    const taskId = this.newId() as TaskId
    const messageId = this.newId() as MessageId

    const created = this.ledger.createTask({
      projectId: binding.projectId,
      taskId,
      title: request.title,
      body: request.body,
      dispatcherSessionId: binding.sessionId,
      assigneeSessionId: request.toSessionId,
      ...(request.supersedesTaskId === undefined
        ? {}
        : { supersedesTaskId: request.supersedesTaskId }),
      idempotencyKey: request.idempotencyKey,
    })
    if (!created.ok) return ledgerFailureToApiError(created.error, request)

    const task = created.value.task
    const receipt: DispatchReceipt = {
      ok: true,
      apiVersion: API_VERSION,
      taskId: task.taskId,
      projectId: binding.projectId,
      messageId,
      channel: 'http',
      taskStatus: 'dispatched',
      deliveredAt,
      ...bodyReceipt,
      ...(created.value.superseded === undefined
        ? {}
        : {
            supersededTask: {
              taskId: created.value.superseded.taskId,
              status: 'cancelled' as const,
              reason: 'superseded' as const,
            },
          }),
      ledgerUpdated: true,
      serverVersion: this.serverVersion,
    }

    this.recordMessage({
      messageId,
      projectId: binding.projectId,
      taskId: task.taskId,
      direction: 'dispatch',
      channel: 'http',
      fromSessionId: binding.sessionId,
      toSessionId: request.toSessionId,
      bodyBytes: bodyReceipt.bodyBytes,
      bodySha256: bodyReceipt.bodySha256,
      preview: bodyReceipt.preview,
      deliveredAt,
    })
    this.storeReceipt(binding.projectId, request.idempotencyKey, {
      operation: 'dispatch',
      fingerprint,
      receipt,
    })
    return receipt
  }

  report(binding: CallerBinding, request: ReportRequestInput): ReportOutcome {
    if (request.projectId !== binding.projectId) return crossProjectDenied(binding.projectId)

    const fingerprint = JSON.stringify([
      'report',
      request.taskId ?? '',
      request.body,
      request.deliverables,
    ])
    const replay = this.lookupReplay<ReportReceipt>(
      binding.projectId,
      request.idempotencyKey,
      'report',
      fingerprint,
    )
    if (replay === 'conflict') return idempotencyConflict(request.idempotencyKey)
    if (replay !== 'miss') return replay

    if (request.taskId === undefined) return this.missingTaskId(binding)
    if (request.body.trim() === '') return emptyBody()

    const taskId = request.taskId
    const found = this.ledger.getTask(binding.projectId, taskId)
    if (!found.ok) {
      if (found.error.code === 'TASK_NOT_FOUND') return taskNotFound(binding.projectId, taskId)
      if (found.error.code === 'CROSS_PROJECT_DENIED') return crossProjectDenied(binding.projectId)
      return internalError(found.error.message, found.error.code)
    }

    const bodyReceipt = buildBodyReceipt(request.body)
    const deliveredAt = this.now()
    const messageId = this.newId() as MessageId
    const before = found.value.status

    const advanced = this.ledger.transition({
      projectId: binding.projectId,
      taskId,
      from: before,
      to: 'delivered',
      actor: { kind: 'system', onBehalfOf: binding.sessionId },
      idempotencyKey: request.idempotencyKey,
    })

    const after = advanced.ok ? 'delivered' : (this.currentStatus(binding.projectId, taskId) ?? before)
    const ledgerUpdate = advanced.ok
      ? ({ ledgerUpdated: true } as const)
      : ({
          ledgerUpdated: false,
          ledgerError: `${advanced.error.code}: ${advanced.error.message}`,
        } as const)

    const receipt: ReportReceipt = {
      ok: true,
      apiVersion: API_VERSION,
      messageId,
      taskId,
      projectId: binding.projectId,
      channel: 'http',
      taskStatusBefore: before,
      taskStatusAfter: after,
      deliveredAt,
      ...bodyReceipt,
      ...ledgerUpdate,
      serverVersion: this.serverVersion,
    }

    this.recordMessage({
      messageId,
      projectId: binding.projectId,
      taskId,
      direction: 'report',
      channel: 'http',
      fromSessionId: binding.sessionId,
      bodyBytes: bodyReceipt.bodyBytes,
      bodySha256: bodyReceipt.bodySha256,
      preview: bodyReceipt.preview,
      deliveredAt,
    })
    this.storeReceipt(binding.projectId, request.idempotencyKey, {
      operation: 'report',
      fingerprint,
      receipt,
    })
    return receipt
  }

  listMessages(projectId: ProjectId): ListResult<DeliveredMessage> {
    const items = this.messages.filter((message) => message.projectId === projectId)
    if (items.length === 0) {
      return { items: [], empty: true, reason: 'no_messages', hint: MESSAGES_EMPTY_HINT }
    }
    return { items: [...items], empty: false }
  }

  /** 汇报候选：同项目 + 同汇报会话 + 非终态（不含 delivered/review），updatedAt DESC。 */
  listReportCandidates(binding: CallerBinding): ListResult<TaskCandidate> {
    const { items } = this.collectCandidates(binding.projectId, binding.sessionId)
    if (items.length === 0) {
      return { items: [], empty: true, reason: 'no_candidates', hint: CANDIDATES_EMPTY_HINT }
    }
    return { items, empty: false }
  }

  private collectCandidates(
    projectId: ProjectId,
    sessionId: SessionId,
  ): { items: TaskCandidate[]; candidateCount: number; truncated: boolean } {
    const openStatuses = OPEN_REPORT_CANDIDATE_STATUSES as readonly string[]
    const matched = this.ledger
      .listTasks(projectId)
      .filter((task) => task.assigneeSessionId === sessionId && openStatuses.includes(task.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq)
    return {
      items: matched.slice(0, CANDIDATE_LIMIT).map(candidateOf),
      candidateCount: matched.length,
      truncated: matched.length > CANDIDATE_LIMIT,
    }
  }

  private missingTaskId(binding: CallerBinding): MissingTaskIdFailure {
    const { items, candidateCount, truncated } = this.collectCandidates(
      binding.projectId,
      binding.sessionId,
    )
    return {
      ok: false,
      apiVersion: API_VERSION,
      error: {
        code: 'MISSING_TASK_ID',
        message: '汇报必须显式指定 taskId；不做自动匹配',
        retryable: false,
        projectId: binding.projectId,
        candidates: items,
        candidateCount,
        truncated,
        hint: candidateCount === 0 ? MISSING_TASK_ID_EMPTY_HINT : MISSING_TASK_ID_HINT,
      },
    }
  }

  private currentStatus(projectId: ProjectId, taskId: TaskId): TaskStatus | undefined {
    const current = this.ledger.getTask(projectId, taskId)
    return current.ok ? current.value.status : undefined
  }

  private recordMessage(message: DeliveredMessage): void {
    this.messages.push(message)
  }

  private lookupReplay<T extends DispatchReceipt | ReportReceipt>(
    projectId: ProjectId,
    key: DispatchRequest['idempotencyKey'],
    operation: 'dispatch' | 'report',
    fingerprint: string,
  ): 'miss' | 'conflict' | T {
    const stored = this.idempotency.get(this.idemKey(projectId, key))
    if (!stored) return 'miss'
    if (stored.operation !== operation || stored.fingerprint !== fingerprint) return 'conflict'
    return stored.receipt as T
  }

  private storeReceipt(
    projectId: ProjectId,
    key: DispatchRequest['idempotencyKey'],
    stored: StoredReceipt,
  ): void {
    this.idempotency.set(this.idemKey(projectId, key), stored)
  }

  private idemKey(projectId: ProjectId, key: DispatchRequest['idempotencyKey']): string {
    return `${projectId}\u0000${key}`
  }
}

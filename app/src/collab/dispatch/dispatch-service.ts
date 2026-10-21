/**
 * 派活/汇报运行时逻辑（实现无关）。
 *
 * 内存与 SQLite 共用本文件；存储差异由 `DispatchStorePort` 承担，
 * 因此校验、幂等、候选、回执口径不会出现两份。
 *
 * 校验顺序：会话绑定 → 幂等重放 → 空正文 → 客户端命令（仅派活）
 * → 目标成员（仅派活）→ 台账操作 → 回执。
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
  type ForbiddenActorFailure,
  type IdempotencyConflictFailure,
  type IdempotencyKey,
  type InvalidTransitionFailure,
  type IsoTimestamp,
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
} from '../protocol/index.ts'
import type { LedgerError, TaskLedgerPort, TaskRecord } from '../ledger/index.ts'
import { buildBodyReceipt } from './body-receipt.ts'
import { matchClientCommand } from './client-command.ts'
import type {
  CallerBinding,
  DeliveredMessage,
  DispatchStorePort,
  ListResult,
  MessageRecord,
  ProjectMembership,
} from './store-port.ts'

export type DispatchOutcome = DispatchReceipt | ApiError
export type ReportOutcome = ReportReceipt | ApiError

export interface DispatchServiceOptions {
  readonly now?: () => IsoTimestamp
  readonly newId?: () => string
  readonly serverVersion?: string
}

const DEFAULT_SERVER_VERSION = 'cadre-heihei-dev'
const MISSING_TASK_ID_HINT = '请从候选中选择一条并在汇报中显式提供 taskId 后重试'
const MISSING_TASK_ID_EMPTY_HINT = '当前没有可汇报的未结任务；请确认 taskId，或请主管重新派单'
const CANDIDATES_EMPTY_HINT = '暂无待汇报任务；任务派发后可在此查看'
const MESSAGES_EMPTY_HINT = '当前项目还没有投递记录'

export const DEFAULT_NOW = (): IsoTimestamp => new Date().toISOString() as IsoTimestamp
export const DEFAULT_NEW_ID = (): string => crypto.randomUUID()

function crossProjectDenied(projectId: ProjectId): CrossProjectDeniedFailure {
  return {
    ok: false,
    apiVersion: API_VERSION,
    error: { code: 'CROSS_PROJECT_DENIED', message: '跨项目请求已拒绝', retryable: false, projectId },
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

function idempotencyConflict(idempotencyKey: IdempotencyKey): IdempotencyConflictFailure {
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
      message: reasonCategory === 'target-not-member' ? '目标会话不属于本项目' : '目标会话当前离线',
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

export class DispatchService {
  protected readonly store: DispatchStorePort
  protected readonly now: () => IsoTimestamp
  protected readonly newId: () => string
  protected readonly serverVersion: string

  constructor(store: DispatchStorePort, options: DispatchServiceOptions = {}) {
    this.store = store
    this.now = options.now ?? DEFAULT_NOW
    this.newId = options.newId ?? DEFAULT_NEW_ID
    this.serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION
  }

  get ledger(): TaskLedgerPort {
    return this.store.ledger
  }

  addMember(membership: ProjectMembership): void {
    this.store.addMember(membership)
  }

  dispatch(binding: CallerBinding, request: DispatchRequest): DispatchOutcome {
    if (request.projectId !== binding.projectId) return crossProjectDenied(binding.projectId)

    return this.store.transaction((tx) => {
      const fingerprint = JSON.stringify([
        'dispatch',
        request.toSessionId,
        request.title,
        request.body,
        request.supersedesTaskId ?? '',
      ])
      const replay = tx.findIdempotent(binding.projectId, request.idempotencyKey)
      if (replay) {
        return replay.operation === 'dispatch' && replay.fingerprint === fingerprint && replay.receipt
          ? (replay.receipt as DispatchReceipt)
          : idempotencyConflict(request.idempotencyKey)
      }

      if (request.body.trim() === '') return emptyBody()
      const command = matchClientCommand(request.body)
      if (command !== null) return clientCommandRejected(command)

      const member = tx.findMember(binding.projectId, request.toSessionId)
      if (!member) return forbiddenTarget(binding.projectId, request.toSessionId, 'target-not-member')
      if (member.state === 'offline') {
        return forbiddenTarget(binding.projectId, request.toSessionId, 'target-offline')
      }

      const bodyReceipt = buildBodyReceipt(request.body)
      const deliveredAt = this.now()
      const taskId = this.newId() as TaskId
      const messageId = this.newId() as MessageId

      const created = tx.createTask({
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

      this.appendMessage(tx, {
        messageId,
        projectId: binding.projectId,
        taskId: task.taskId,
        direction: 'dispatch',
        channel: 'http',
        fromSessionId: binding.sessionId,
        toSessionId: request.toSessionId,
        body: request.body,
        bodyBytes: bodyReceipt.bodyBytes,
        bodySha256: bodyReceipt.bodySha256,
        preview: bodyReceipt.preview,
        deliveredAt,
        idempotencyKey: request.idempotencyKey,
      })
      tx.saveIdempotent(binding.projectId, request.idempotencyKey, {
        operation: 'dispatch',
        fingerprint,
        receipt,
      })
      return receipt
    })
  }

  report(binding: CallerBinding, request: ReportRequestInput): ReportOutcome {
    if (request.projectId !== binding.projectId) return crossProjectDenied(binding.projectId)

    return this.store.transaction((tx) => {
      const fingerprint = JSON.stringify([
        'report',
        request.taskId ?? '',
        request.body,
        request.deliverables,
      ])
      const replay = tx.findIdempotent(binding.projectId, request.idempotencyKey)
      if (replay) {
        return replay.operation === 'report' && replay.fingerprint === fingerprint && replay.receipt
          ? (replay.receipt as ReportReceipt)
          : idempotencyConflict(request.idempotencyKey)
      }

      if (request.taskId === undefined) return this.missingTaskId(binding)
      if (request.body.trim() === '') return emptyBody()

      const taskId = request.taskId
      const found = tx.getTask(binding.projectId, taskId)
      if (!found.ok) {
        if (found.error.code === 'TASK_NOT_FOUND') return taskNotFound(binding.projectId, taskId)
        if (found.error.code === 'CROSS_PROJECT_DENIED') return crossProjectDenied(binding.projectId)
        return internalError(found.error.message, found.error.code)
      }

      const bodyReceipt = buildBodyReceipt(request.body)
      const deliveredAt = this.now()
      const messageId = this.newId() as MessageId
      const before = found.value.status

      const advanced = tx.transition({
        projectId: binding.projectId,
        taskId,
        from: before,
        to: 'delivered',
        actor: { kind: 'system', onBehalfOf: binding.sessionId },
        idempotencyKey: request.idempotencyKey,
      })

      const after = advanced.ok ? 'delivered' : (this.currentStatus(tx, binding.projectId, taskId) ?? before)
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

      this.appendMessage(tx, {
        messageId,
        projectId: binding.projectId,
        taskId,
        direction: 'report',
        channel: 'http',
        fromSessionId: binding.sessionId,
        body: request.body,
        bodyBytes: bodyReceipt.bodyBytes,
        bodySha256: bodyReceipt.bodySha256,
        preview: bodyReceipt.preview,
        deliveredAt,
        idempotencyKey: request.idempotencyKey,
      })
      tx.saveIdempotent(binding.projectId, request.idempotencyKey, {
        operation: 'report',
        fingerprint,
        receipt,
      })
      return receipt
    })
  }

  listMessages(projectId: ProjectId): ListResult<DeliveredMessage> {
    const items = this.store.listMessages(projectId)
    if (items.length === 0) {
      return { items: [], empty: true, reason: 'no_messages', hint: MESSAGES_EMPTY_HINT }
    }
    return { items: [...items], empty: false }
  }

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
    const matched = this.store.ledger
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

  private currentStatus(
    tx: { getTask(projectId: ProjectId, taskId: TaskId): ReturnType<TaskLedgerPort['getTask']> },
    projectId: ProjectId,
    taskId: TaskId,
  ) {
    const current = tx.getTask(projectId, taskId)
    return current.ok ? current.value.status : undefined
  }

  private appendMessage(
    tx: { appendMessage(message: MessageRecord): void },
    message: MessageRecord,
  ): void {
    tx.appendMessage(message)
  }
}

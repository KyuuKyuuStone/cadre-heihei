/**
 * M2 六个工具的运行时 handler。
 *
 * 权限判定在 handler 入口、先于任何业务写：
 * - 身份只取 server 注入值，忽略工具参数中的 sessionId/projectId；
 * - 角色取自项目 members（ADR-0019），supervisor-only 工具先判角色再解析目标；
 * - 跨项目/不存在不得泄露候选或任务字段；
 * - 所有校验是前置拒绝，不存在「等待审批」中间态。
 *
 * 状态机与派活/汇报规则不在本文件复制：review 走 ledger.transition，
 * 派活/汇报走 DispatchService。
 */
import {
  API_VERSION,
  TASK_STATUSES,
  type ApiFailure,
  type DispatchReceipt,
  type EmptyReason,
  type ReportReceipt,
  type TaskStatus,
  type TaskSummary,
  type TransitionReceipt,
} from '../protocol/index.ts'
import type { ProjectMembership } from '../dispatch/index.ts'
import type { TaskRecord } from '../ledger/index.ts'
import {
  crossProjectDenied,
  failure,
  forbiddenNotAssignee,
  forbiddenNotSupervisor,
  invalidArgument,
  mapLedgerError,
} from './errors.ts'
import type { TaskId } from '../protocol/index.ts'
import type { ToolCallResult, ToolContext } from './types.ts'

type Args = Record<string, unknown>
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure }

const NON_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'dispatched',
  'accepted',
  'in_progress',
  'delivered',
  'review',
  'rework',
]
const STATUS_SET = new Set<string>(TASK_STATUSES)
const ACTIONS = ['enter_review', 'verify', 'rework', 'fail'] as const
type ReviewAction = (typeof ACTIONS)[number]

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value }
}
function bad(field: string, reason: string): Parsed<never> {
  return { ok: false, failure: invalidArgument(field, reason) }
}

function stringArg(args: Args, field: string, options: { require?: boolean; allowEmpty?: boolean } = {}): Parsed<string | undefined> {
  const value = args[field]
  if (value === undefined) {
    return options.require ? bad(field, '缺少必填参数') : ok(undefined)
  }
  if (typeof value !== 'string') return bad(field, '必须是字符串')
  if (options.require && value === '' && options.allowEmpty !== true) return bad(field, '不得为空')
  return ok(value)
}

function stringArrayArg(args: Args, field: string, require: boolean): Parsed<readonly string[] | undefined> {
  const value = args[field]
  if (value === undefined) return require ? bad(field, '缺少必填参数') : ok(undefined)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return bad(field, '必须是字符串数组')
  }
  return ok(value as readonly string[])
}

function result(payload: unknown): ToolCallResult {
  const okFlag = (payload as { ok?: boolean }).ok !== false
  return { payload, isError: !okFlag }
}

function callerMember(ctx: ToolContext): ProjectMembership | undefined {
  return ctx.backend
    .listMembers(ctx.identity.projectId)
    .find((member) => member.sessionId === ctx.identity.sessionId)
}

/** 身份必须属于注入项目；否则一律跨项目拒绝，不泄露存在性。 */
function requireCaller(ctx: ToolContext): ProjectMembership | ApiFailure {
  const member = callerMember(ctx)
  return member ?? crossProjectDenied(ctx.identity.projectId)
}

function isFailure(value: ProjectMembership | ApiFailure): value is ApiFailure {
  return (value as ApiFailure).ok === false
}

function requireSupervisor(ctx: ToolContext, taskId?: string): ProjectMembership | ApiFailure {
  const caller = requireCaller(ctx)
  if (isFailure(caller)) return caller
  if (caller.role !== 'supervisor') {
    return forbiddenNotSupervisor(ctx.identity.projectId, ctx.identity.sessionId, taskId as TaskId | undefined)
  }
  return caller
}

function summaryOf(task: TaskRecord, members: readonly ProjectMembership[]): TaskSummary {
  const assignee = members.find((member) => member.sessionId === task.assigneeSessionId)
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    seq: task.seq,
    title: task.title,
    status: task.status,
    assigneeSessionId: task.assigneeSessionId,
    ...(assignee?.displayName === undefined ? {} : { assigneeName: assignee.displayName }),
    attempt: task.attempt,
    updatedAt: task.updatedAt,
    ...(task.deliveredAt === undefined ? {} : { deliveredAt: task.deliveredAt }),
  }
}

function parseStatuses(args: Args): Parsed<readonly TaskStatus[]> {
  const raw = args.status
  if (raw === undefined) return ok(NON_TERMINAL_STATUSES)
  const values = Array.isArray(raw) ? raw : [raw]
  if (values.length === 0 || values.some((value) => typeof value !== 'string')) {
    return bad('status', '必须是状态字符串或状态数组')
  }
  const invalid = values.find((value) => !STATUS_SET.has(value as string))
  if (invalid !== undefined) return bad('status', `未知状态：${String(invalid)}`)
  return ok([...new Set(values as TaskStatus[])])
}

function parseLimit(args: Args): Parsed<number> {
  const raw = args.limit
  if (raw === undefined) return ok(20)
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 100) {
    return bad('limit', '必须是 1..100 的整数')
  }
  return ok(raw)
}

function parseSince(args: Args): Parsed<{ updatedAt: string; seq: number } | undefined> {
  const raw = args.since
  if (raw === undefined) return ok(undefined)
  if (typeof raw !== 'object' || raw === null) return bad('since', '必须是 {updatedAt, seq} 对象')
  const cursor = raw as Record<string, unknown>
  if (typeof cursor.updatedAt !== 'string' || cursor.updatedAt === '') {
    return bad('since.updatedAt', '必须是非空时间戳')
  }
  if (typeof cursor.seq !== 'number' || !Number.isInteger(cursor.seq) || cursor.seq < 0) {
    return bad('since.seq', '必须是非负整数')
  }
  return ok({ updatedAt: cursor.updatedAt, seq: cursor.seq })
}

function afterCursor(task: TaskRecord, cursor: { updatedAt: string; seq: number }): boolean {
  if (task.updatedAt > cursor.updatedAt) return true
  return task.updatedAt === cursor.updatedAt && task.seq > cursor.seq
}

function toolDispatch(ctx: ToolContext, args: Args): ToolCallResult {
  const supervisor = requireSupervisor(ctx)
  if (isFailure(supervisor)) return result(supervisor)

  const toSessionId = stringArg(args, 'toSessionId', { require: true })
  if (!toSessionId.ok) return result(toSessionId.failure)
  const title = stringArg(args, 'title', { require: true })
  if (!title.ok) return result(title.failure)
  const body = stringArg(args, 'body', { require: true, allowEmpty: true })
  if (!body.ok) return result(body.failure)
  const idempotencyKey = stringArg(args, 'idempotencyKey', { require: true })
  if (!idempotencyKey.ok) return result(idempotencyKey.failure)
  const supersedesTaskId = stringArg(args, 'supersedesTaskId', { require: false })
  if (!supersedesTaskId.ok) return result(supersedesTaskId.failure)

  const outcome: DispatchReceipt | ApiFailure = ctx.backend.dispatch(
    { projectId: ctx.identity.projectId, sessionId: ctx.identity.sessionId },
    {
      projectId: ctx.identity.projectId,
      toSessionId: toSessionId.value as never,
      title: title.value as string,
      body: body.value as string,
      idempotencyKey: idempotencyKey.value as never,
      ...(supersedesTaskId.value === undefined
        ? {}
        : { supersedesTaskId: supersedesTaskId.value as never }),
    },
  )
  return result(outcome)
}

function toolReport(ctx: ToolContext, args: Args): ToolCallResult {
  const caller = requireCaller(ctx)
  if (isFailure(caller)) return result(caller)

  const body = stringArg(args, 'body', { require: true, allowEmpty: true })
  if (!body.ok) return result(body.failure)
  const deliverables = stringArrayArg(args, 'deliverables', true)
  if (!deliverables.ok) return result(deliverables.failure)
  const idempotencyKey = stringArg(args, 'idempotencyKey', { require: true })
  if (!idempotencyKey.ok) return result(idempotencyKey.failure)
  const taskId = stringArg(args, 'taskId', { require: false })
  if (!taskId.ok) return result(taskId.failure)

  const binding = { projectId: ctx.identity.projectId, sessionId: ctx.identity.sessionId }
  const base = {
    projectId: ctx.identity.projectId,
    body: body.value as string,
    deliverables: deliverables.value as readonly string[],
    idempotencyKey: idempotencyKey.value as never,
  }

  if (taskId.value !== undefined) {
    const task = ctx.backend.ledger.getTask(ctx.identity.projectId, taskId.value as never)
    if (!task.ok) return result(mapLedgerError(task.error))
    if (task.value.assigneeSessionId !== ctx.identity.sessionId) {
      return result(
        forbiddenNotAssignee(ctx.identity.projectId, ctx.identity.sessionId, task.value.taskId),
      )
    }
  }

  const outcome: ReportReceipt | ApiFailure = ctx.backend.report(binding, {
    ...base,
    ...(taskId.value === undefined ? {} : { taskId: taskId.value as never }),
  })
  return result(outcome)
}

function toolListTasks(ctx: ToolContext, args: Args): ToolCallResult {
  const caller = requireCaller(ctx)
  if (isFailure(caller)) return result(caller)

  const statuses = parseStatuses(args)
  if (!statuses.ok) return result(statuses.failure)
  const limit = parseLimit(args)
  if (!limit.ok) return result(limit.failure)
  const since = parseSince(args)
  if (!since.ok) return result(since.failure)
  const assigneeArg = stringArg(args, 'assigneeSessionId', { require: false })
  if (!assigneeArg.ok) return result(assigneeArg.failure)

  if (
    caller.role !== 'supervisor' &&
    assigneeArg.value !== undefined &&
    assigneeArg.value !== ctx.identity.sessionId
  ) {
    return result(
      failure('FORBIDDEN_ACTOR', 'worker 只能读取本人任务', {
        projectId: ctx.identity.projectId,
        actorSessionId: ctx.identity.sessionId,
        reasonCategory: 'not-assignee',
        requiredActor: 'assignee',
      }),
    )
  }

  const members = ctx.backend.listMembers(ctx.identity.projectId)
  const all = ctx.backend.ledger.listTasks(ctx.identity.projectId)
  const isSupervisor = caller.role === 'supervisor'
  const assignee: string | undefined = isSupervisor
    ? assigneeArg.value
    : ctx.identity.sessionId

  const matched = all
    .filter((task) => (isSupervisor ? true : task.assigneeSessionId === ctx.identity.sessionId))
    .filter((task) => (assignee === undefined ? true : task.assigneeSessionId === assignee))
    .filter((task) => statuses.value.includes(task.status))
    .filter((task) => (since.value === undefined ? true : afterCursor(task, since.value)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq)

  const total = matched.length
  const items = matched.slice(0, limit.value).map((task) => summaryOf(task, members))
  const changedAt = matched[0]?.updatedAt ?? new Date().toISOString()
  const base = { since: since.value ?? null, changedAt, total }

  if (items.length === 0) {
    const reason: EmptyReason = all.length === 0 ? 'no_tasks' : 'no_tasks_for_filter'
    return result({
      ok: true,
      apiVersion: API_VERSION,
      items: [],
      empty: true,
      reason,
      hint:
        reason === 'no_tasks'
          ? '本项目还没有任务；主管派活后可在此查看'
          : '没有符合筛选条件的任务；可调整 status/assignee/since 后重试',
      ...base,
    })
  }
  return result({ ok: true, apiVersion: API_VERSION, items, ...base })
}

function toolGetTask(ctx: ToolContext, args: Args): ToolCallResult {
  const caller = requireCaller(ctx)
  if (isFailure(caller)) return result(caller)

  const taskId = stringArg(args, 'taskId', { require: true })
  if (!taskId.ok) return result(taskId.failure)

  const task = ctx.backend.ledger.getTask(ctx.identity.projectId, taskId.value as never)
  if (!task.ok) return result(mapLedgerError(task.error))
  if (
    caller.role !== 'supervisor' &&
    task.value.assigneeSessionId !== ctx.identity.sessionId
  ) {
    return result(forbiddenNotAssignee(ctx.identity.projectId, ctx.identity.sessionId, task.value.taskId))
  }

  const events = ctx.backend.ledger.listEvents(ctx.identity.projectId, task.value.taskId)
  if (!events.ok) return result(mapLedgerError(events.error))
  const transitions = events.value.map((event) => ({
    from: event.fromStatus ?? null,
    to: event.toStatus,
    at: event.at,
    actorSessionId: event.actorSessionId,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    eventId: event.eventId,
  }))
  const report = [...ctx.backend.listMessageRecords(ctx.identity.projectId)]
    .filter((message) => message.taskId === task.value.taskId && message.direction === 'report')
    .at(-1)
  const assignee = ctx.backend
    .listMembers(ctx.identity.projectId)
    .find((member) => member.sessionId === task.value.assigneeSessionId)

  return result({
    ok: true,
    apiVersion: API_VERSION,
    taskId: task.value.taskId,
    projectId: task.value.projectId,
    seq: task.value.seq,
    title: task.value.title,
    body: task.value.body,
    status: task.value.status,
    ...(assignee?.displayName === undefined ? {} : { assigneeName: assignee.displayName }),
    assigneeSessionId: task.value.assigneeSessionId,
    dispatcherSessionId: task.value.dispatcherSessionId,
    attempt: task.value.attempt,
    version: task.value.version,
    createdAt: task.value.createdAt,
    updatedAt: task.value.updatedAt,
    ...(task.value.acceptedAt === undefined ? {} : { acceptedAt: task.value.acceptedAt }),
    ...(task.value.startedAt === undefined ? {} : { startedAt: task.value.startedAt }),
    ...(task.value.deliveredAt === undefined ? {} : { deliveredAt: task.value.deliveredAt }),
    ...(task.value.closedAt === undefined ? {} : { closedAt: task.value.closedAt }),
    ...(task.value.supersedesTaskId === undefined
      ? {}
      : { supersedesTaskId: task.value.supersedesTaskId }),
    ...(task.value.supersededByTaskId === undefined
      ? {}
      : { supersededByTaskId: task.value.supersededByTaskId }),
    transitions,
    report:
      report === undefined
        ? null
        : {
            summary: report.body,
            deliverables: report.deliverables ?? [],
            bodyBytes: report.bodyBytes,
            preview: report.preview,
            messageId: report.messageId,
            deliveredAt: report.deliveredAt,
          },
  })
}

function toolListRoster(ctx: ToolContext, args: Args): ToolCallResult {
  const caller = requireCaller(ctx)
  if (isFailure(caller)) return result(caller)

  const scopeArg = args.scope
  if (scopeArg !== undefined && scopeArg !== 'project' && scopeArg !== 'global') {
    return result(invalidArgument('scope', '只能是 project 或 global'))
  }
  const scope = (scopeArg as 'project' | 'global' | undefined) ?? 'project'
  const forSession = stringArg(args, 'forSession', { require: false })
  if (!forSession.ok) return result(forSession.failure)
  if (forSession.value !== undefined && forSession.value !== ctx.identity.sessionId) {
    return result(crossProjectDenied(ctx.identity.projectId))
  }

  const members = ctx.backend.listMembers(ctx.identity.projectId)
  const globalCount = members.length
  const isDispatchable = (member: ProjectMembership): boolean =>
    member.role === 'worker' && member.state !== 'offline'
  const dispatchableCount = members.filter(isDispatchable).length
  const reason: EmptyReason | undefined =
    dispatchableCount === 0 ? 'no_workers_in_project' : undefined
  const hint =
    dispatchableCount === 0 ? '本项目暂无可派活的 worker；请先在花名册登记后再派活' : undefined

  const now = new Date().toISOString()
  if (scope === 'global') {
    return result({
      ok: true,
      apiVersion: API_VERSION,
      projects: [],
      members: [],
      scope: {
        kind: 'global',
        projectMatched: false,
        dispatchable: false,
        globalCount,
        dispatchableCount: 0,
        ...(reason === undefined ? {} : { reason, hint }),
      },
    })
  }

  return result({
    ok: true,
    apiVersion: API_VERSION,
    projects: [
      {
        projectId: ctx.identity.projectId,
        name: ctx.identity.projectId,
        current: true,
        updatedAt: now,
      },
    ],
    members: members.map((member) => ({
      sessionId: member.sessionId,
      displayName: member.displayName ?? member.sessionId,
      role: member.role,
      state: member.state,
      projectId: member.projectId,
      dispatchable: isDispatchable(member),
      ...(member.state === 'offline'
        ? { dispatchableReason: 'offline' }
        : member.role !== 'worker'
          ? { dispatchableReason: 'not-worker' }
          : {}),
    })),
    scope: {
      kind: 'project',
      projectId: ctx.identity.projectId,
      globalCount,
      dispatchableCount,
      projectMatched: true,
      ...(reason === undefined ? {} : { reason, hint }),
    },
  })
}

function toolReview(ctx: ToolContext, args: Args): ToolCallResult {
  const supervisor = requireSupervisor(ctx, typeof args.taskId === 'string' ? args.taskId : undefined)
  if (isFailure(supervisor)) return result(supervisor)

  const taskId = stringArg(args, 'taskId', { require: true })
  if (!taskId.ok) return result(taskId.failure)
  const action = args.action
  if (typeof action !== 'string' || !ACTIONS.includes(action as ReviewAction)) {
    return result(invalidArgument('action', '只能是 enter_review/verify/rework/fail'))
  }
  const idempotencyKey = stringArg(args, 'idempotencyKey', { require: true })
  if (!idempotencyKey.ok) return result(idempotencyKey.failure)
  const reason = stringArg(args, 'reason', { require: false })
  if (!reason.ok) return result(reason.failure)

  const to: TaskStatus =
    action === 'enter_review'
      ? 'review'
      : action === 'verify'
        ? 'verified'
        : action === 'rework'
          ? 'rework'
          : 'failed'

  const current = ctx.backend.ledger.getTask(ctx.identity.projectId, taskId.value as never)
  if (!current.ok) return result(mapLedgerError(current.error))

  /*
   * 幂等重放必须在「按当前状态计算 from」之前命中：
   * transitionFingerprint 含 from，若先调 transition，状态已变会导致指纹不同而报冲突。
   * 台账事件持久化 idempotencyKey，跨重启仍可按 key 找到首次结果。
   *
   * 作用域说明：本段事件扫描是「同 task 重放」的恢复路径；键的项目级唯一性由
   * ledger.transition 的 (project_id, idempotency_key) 幂等表兜底。同键用于另一 task
   * 时事件扫描不会命中，随后 transition 因指纹不同返回 IDEMPOTENCY_CONFLICT——
   * 符合契约「同键不同请求即冲突」，因此不在此处扩大为项目级扫描。
   */
  const events = ctx.backend.ledger.listEvents(ctx.identity.projectId, taskId.value as never)
  if (!events.ok) return result(mapLedgerError(events.error))
  const replay = events.value.find((event) => event.idempotencyKey === idempotencyKey.value)
  if (replay !== undefined) {
    const actorSessionId =
      replay.actorSessionId === 'system' ? ctx.identity.sessionId : replay.actorSessionId
    const sameRequest =
      replay.toStatus === to &&
      actorSessionId === ctx.identity.sessionId &&
      (replay.reason ?? '') === (reason.value ?? '')
    if (!sameRequest) {
      return result({
        ok: false,
        apiVersion: API_VERSION,
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: `幂等键已被不同请求占用：${idempotencyKey.value}`,
          retryable: false,
          projectId: ctx.identity.projectId,
        },
      })
    }
    const replayReceipt: TransitionReceipt = {
      taskId: current.value.taskId,
      from: replay.fromStatus ?? current.value.status,
      to: replay.toStatus,
      attempt: current.value.attempt,
      updatedAt: replay.at,
      ...(replay.reason === undefined ? {} : { reason: replay.reason }),
      eventId: replay.eventId,
      ...(replay.actorSessionId === 'system'
        ? {}
        : { actorSessionId: replay.actorSessionId }),
      version: current.value.version,
      ledgerUpdated: true,
    }
    return result({ ok: true, apiVersion: API_VERSION, ...replayReceipt })
  }

  const transition = ctx.backend.ledger.transition({
    projectId: ctx.identity.projectId,
    taskId: taskId.value as never,
    from: current.value.status,
    to,
    actor: { kind: 'session', sessionId: ctx.identity.sessionId, role: 'supervisor' },
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    idempotencyKey: idempotencyKey.value as never,
  })
  if (!transition.ok) return result(mapLedgerError(transition.error))

  const receipt: TransitionReceipt = {
    taskId: transition.value.task.taskId,
    from: transition.value.event.fromStatus ?? current.value.status,
    to: transition.value.task.status,
    attempt: transition.value.task.attempt,
    updatedAt: transition.value.task.updatedAt,
    ...(transition.value.event.reason === undefined ? {} : { reason: transition.value.event.reason }),
    eventId: transition.value.event.eventId,
    ...(transition.value.event.actorSessionId === 'system'
      ? {}
      : { actorSessionId: transition.value.event.actorSessionId }),
    version: transition.value.task.version,
    ledgerUpdated: true,
  }
  return result({ ok: true, apiVersion: API_VERSION, ...receipt })
}

export function handleToolCall(ctx: ToolContext, name: string, args: Args): ToolCallResult {
  switch (name) {
    case 'dispatch_task':
      return toolDispatch(ctx, args)
    case 'report_task':
      return toolReport(ctx, args)
    case 'list_tasks':
      return toolListTasks(ctx, args)
    case 'get_task':
      return toolGetTask(ctx, args)
    case 'list_roster':
      return toolListRoster(ctx, args)
    case 'review_task':
      return toolReview(ctx, args)
    default:
      return result(invalidArgument('name', `未知工具：${name}`))
  }
}

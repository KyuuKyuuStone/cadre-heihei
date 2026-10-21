/** MCP 测试种子：成员表与固定任务（内存 fixture 与 SQLite 共用）。 */
import type { DispatchService, ProjectMembership } from '../../src/collab/dispatch/index.ts'
import type { LedgerActor } from '../../src/collab/ledger/index.ts'
import type {
  IdempotencyKey,
  ProjectId,
  SessionId,
  TaskId,
  TaskStatus,
} from '../../src/collab/protocol/index.ts'

export const P1 = 'mcp-project-1' as ProjectId
export const P2 = 'mcp-project-2' as ProjectId

export const SUP = 'mcp-supervisor' as SessionId
export const SUP_B = 'mcp-supervisor-b' as SessionId
export const SUP_NEW = 'mcp-supervisor-new' as SessionId
export const SUP_OLD = 'mcp-supervisor-old' as SessionId
export const EMP = 'mcp-employee' as SessionId
export const EMP2 = 'mcp-employee-2' as SessionId
export const EMP3 = 'mcp-employee-3' as SessionId
export const OFFLINE = 'mcp-offline' as SessionId
export const STRANGER = 'mcp-stranger' as SessionId
export const SUP2 = 'mcp-supervisor-p2' as SessionId
export const EMP_P2 = 'mcp-employee-p2' as SessionId

export const MCP_MEMBERS: readonly ProjectMembership[] = [
  { projectId: P1, sessionId: SUP, role: 'supervisor', state: 'available', displayName: '主管' },
  { projectId: P1, sessionId: SUP_B, role: 'supervisor', state: 'available', displayName: '主管B' },
  { projectId: P1, sessionId: SUP_NEW, role: 'supervisor', state: 'available', displayName: '新主管' },
  { projectId: P1, sessionId: SUP_OLD, role: 'worker', state: 'available', displayName: '旧主管' },
  { projectId: P1, sessionId: EMP, role: 'worker', state: 'available', displayName: '员工' },
  { projectId: P1, sessionId: EMP2, role: 'worker', state: 'available', displayName: '员工二' },
  { projectId: P1, sessionId: EMP3, role: 'worker', state: 'available', displayName: '员工三' },
  { projectId: P1, sessionId: OFFLINE, role: 'worker', state: 'offline', displayName: '离线员工' },
  { projectId: P2, sessionId: SUP2, role: 'supervisor', state: 'available', displayName: '主管P2' },
  { projectId: P2, sessionId: EMP_P2, role: 'worker', state: 'available', displayName: '员工P2' },
]

export const TASK = {
  inProgress: 'seed-in-progress' as TaskId,
  review: 'seed-review' as TaskId,
  delivered: 'seed-delivered' as TaskId,
  verified: 'seed-verified' as TaskId,
  reviewB: 'seed-review-b' as TaskId,
  workerDispatched: 'seed-worker-dispatched' as TaskId,
  p2: 'seed-p2-task' as TaskId,
} as const

const ASSIGNEE: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
const SYSTEM: LedgerActor = { kind: 'system', onBehalfOf: EMP }
function supervisor(sessionId: SessionId): LedgerActor {
  return { kind: 'session', sessionId, role: 'supervisor' }
}

let keySeq = 0
function key(): IdempotencyKey {
  return `seed-key-${++keySeq}` as IdempotencyKey
}

function create(
  service: DispatchService,
  taskId: TaskId,
  options: {
    readonly projectId?: ProjectId
    readonly dispatcherSessionId?: SessionId
    readonly assigneeSessionId?: SessionId
    readonly title: string
  },
): void {
  const result = service.ledger.createTask({
    projectId: options.projectId ?? P1,
    taskId,
    title: options.title,
    body: `${options.title}正文`,
    dispatcherSessionId: options.dispatcherSessionId ?? SUP,
    assigneeSessionId: options.assigneeSessionId ?? EMP,
    idempotencyKey: key(),
  })
  if (!result.ok) throw new Error(`seed create ${taskId}: ${result.error.code}`)
}

function advance(
  service: DispatchService,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
  reason?: string,
): void {
  const current = service.ledger.getTask(P1, taskId)
  if (!current.ok) throw new Error(`seed get ${taskId}: ${current.error.code}`)
  const result = service.ledger.transition({
    projectId: P1,
    taskId,
    from: current.value.status,
    to,
    actor,
    ...(reason === undefined ? {} : { reason }),
    idempotencyKey: key(),
  })
  if (!result.ok) throw new Error(`seed transition ${taskId} -> ${to}: ${result.error.code}`)
}

function toReview(service: DispatchService, taskId: TaskId): void {
  advance(service, taskId, 'accepted', ASSIGNEE)
  advance(service, taskId, 'in_progress', ASSIGNEE)
  advance(service, taskId, 'delivered', SYSTEM)
  advance(service, taskId, 'review', supervisor(SUP))
}

/** 固定种子任务；每次测试在新服务上调用，互不影响。 */
export function seedTasks(service: DispatchService): void {
  create(service, TASK.inProgress, { title: '进行中任务' })
  advance(service, TASK.inProgress, 'accepted', ASSIGNEE)
  advance(service, TASK.inProgress, 'in_progress', ASSIGNEE)

  create(service, TASK.review, { title: '待验收任务' })
  toReview(service, TASK.review)

  create(service, TASK.delivered, { title: '已交付任务' })
  advance(service, TASK.delivered, 'accepted', ASSIGNEE)
  advance(service, TASK.delivered, 'in_progress', ASSIGNEE)
  advance(service, TASK.delivered, 'delivered', SYSTEM)

  create(service, TASK.verified, { title: '已验收任务' })
  toReview(service, TASK.verified)
  advance(service, TASK.verified, 'verified', supervisor(SUP))

  create(service, TASK.reviewB, { title: '双主管任务' })
  toReview(service, TASK.reviewB)

  create(service, TASK.workerDispatched, {
    title: '员工代派任务',
    dispatcherSessionId: EMP2,
  })
  toReview(service, TASK.workerDispatched)

  const p2 = service.ledger.createTask({
    projectId: P2,
    taskId: TASK.p2,
    title: 'P2 任务',
    body: 'P2 正文',
    dispatcherSessionId: SUP2,
    assigneeSessionId: EMP_P2,
    idempotencyKey: key(),
  })
  if (!p2.ok) throw new Error(`seed create p2: ${p2.error.code}`)
}

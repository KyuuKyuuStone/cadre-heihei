/**
 * dispatch 测试公共件：确定性时钟/ID、成员表、回执断言辅助。
 * 本文件不是测试文件（不匹配 *.test.ts），不会被 runner 收集。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  InMemoryTaskLedger,
  type LedgerActor,
  type TaskRecord,
} from '../../src/collab/ledger/index.ts'
import {
  InMemoryDispatchService,
  type CallerBinding,
  type DispatchOutcome,
  type DispatchService,
  type ProjectMembership,
  type ReportOutcome,
} from '../../src/collab/dispatch/index.ts'
import type {
  ApiError,
  DispatchReceipt,
  DispatchRequest,
  IdempotencyKey,
  IsoTimestamp,
  ProjectId,
  ReportReceipt,
  ReportRequestInput,
  SessionId,
  TaskId,
  TaskStatus,
} from '../../src/collab/protocol/index.ts'

export const P1 = 'project-1' as ProjectId
export const P2 = 'project-2' as ProjectId
export const GHOST = 'project-ghost' as ProjectId

export const SUP = 'session-supervisor' as SessionId
export const EMP = 'session-employee' as SessionId
export const EMP2 = 'session-employee-2' as SessionId
export const OFFLINE = 'session-offline' as SessionId
export const STRANGER = 'session-stranger' as SessionId
export const SUP2 = 'session-supervisor-2' as SessionId
export const EMP_P2 = 'session-employee-p2' as SessionId

export const BINDING_SUP: CallerBinding = { projectId: P1, sessionId: SUP }
export const BINDING_EMP: CallerBinding = { projectId: P1, sessionId: EMP }
export const BINDING_EMP2: CallerBinding = { projectId: P1, sessionId: EMP2 }
export const BINDING_SUP2: CallerBinding = { projectId: P2, sessionId: SUP2 }

export const ASSIGNEE_ACTOR: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
export const SUPERVISOR_ACTOR: LedgerActor = { kind: 'session', sessionId: SUP, role: 'supervisor' }
export const SYSTEM_ACTOR: LedgerActor = { kind: 'system', onBehalfOf: EMP }

export const TEST_MEMBERS: readonly ProjectMembership[] = [
  { projectId: P1, sessionId: SUP, role: 'supervisor', state: 'available' },
  { projectId: P1, sessionId: EMP, role: 'worker', state: 'available' },
  { projectId: P1, sessionId: EMP2, role: 'worker', state: 'available' },
  { projectId: P1, sessionId: OFFLINE, role: 'worker', state: 'offline' },
  { projectId: P2, sessionId: SUP2, role: 'supervisor', state: 'available' },
  { projectId: P2, sessionId: EMP_P2, role: 'worker', state: 'available' },
]

export interface TestService {
  readonly service: InMemoryDispatchService
  readonly ledger: InMemoryTaskLedger
}

export function makeService(): TestService {
  let tick = 0
  let id = 0
  const now = (): IsoTimestamp =>
    new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp
  const newId = (): string => `id-${++id}`
  const ledger = new InMemoryTaskLedger({ now, newId })
  const service = new InMemoryDispatchService({
    ledger,
    now,
    newId,
    serverVersion: 'test-server',
    members: TEST_MEMBERS,
  })
  return { service, ledger }
}

let keySeq = 0
export function nextKey(): IdempotencyKey {
  return `key-${++keySeq}` as IdempotencyKey
}

export function dispatchRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    projectId: P1,
    toSessionId: EMP,
    title: '测试任务',
    body: '请实现功能',
    idempotencyKey: nextKey(),
    ...overrides,
  }
}

export function reportInput(overrides: Partial<ReportRequestInput> = {}): ReportRequestInput {
  return {
    projectId: P1,
    body: '已完成',
    idempotencyKey: nextKey(),
    deliverables: [],
    ...overrides,
  }
}

export function expectDispatchOk(result: DispatchOutcome): DispatchReceipt {
  if (!result.ok) assert.fail(`期望派活成功，实际 ${result.error.code}: ${result.error.message}`)
  return result
}

export function expectDispatchError(result: DispatchOutcome): ApiError {
  if (result.ok) assert.fail('期望派活失败，实际成功')
  return result
}

export function expectReportOk(result: ReportOutcome): ReportReceipt {
  if (!result.ok) assert.fail(`期望汇报成功，实际 ${result.error.code}: ${result.error.message}`)
  return result
}

export function expectReportError(result: ReportOutcome): ApiError {
  if (result.ok) assert.fail('期望汇报失败，实际成功')
  return result
}

export function dispatchOk(
  service: DispatchService,
  binding: CallerBinding = BINDING_SUP,
  overrides: Partial<DispatchRequest> = {},
): DispatchReceipt {
  return expectDispatchOk(service.dispatch(binding, dispatchRequest(overrides)))
}

export function transitionTo(
  service: DispatchService,
  projectId: ProjectId,
  taskId: TaskId,
  to: TaskStatus,
  actor: LedgerActor,
  reason?: string,
): TaskRecord {
  const current = service.ledger.getTask(projectId, taskId)
  if (!current.ok) assert.fail(`取任务失败：${current.error.code}`)
  const result = service.ledger.transition({
    projectId,
    taskId,
    from: current.value.status,
    to,
    actor,
    ...(reason === undefined ? {} : { reason }),
    idempotencyKey: nextKey(),
  })
  if (!result.ok) assert.fail(`迁移 ${current.value.status} → ${to} 失败：${result.error.code}`)
  return result.value.task
}

export function driveToInProgress(
  service: DispatchService,
  projectId: ProjectId,
  taskId: TaskId,
): TaskRecord {
  transitionTo(service, projectId, taskId, 'accepted', ASSIGNEE_ACTOR)
  return transitionTo(service, projectId, taskId, 'in_progress', ASSIGNEE_ACTOR)
}

export function independentReceipt(body: string): {
  bodyBytes: number
  bodySha256: string
  preview: string
} {
  // 独立复算：先 trim → 前 50 个 code point → 有剩余才追加省略号。
  const trimmed = body.trim()
  const codePoints = Array.from(trimmed)
  return {
    bodyBytes: Buffer.from(body, 'utf8').length,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    preview: codePoints.length > 50 ? `${codePoints.slice(0, 50).join('')}…` : trimmed,
  }
}

export function assertEmptyList(
  result: { readonly items: readonly unknown[]; readonly empty?: boolean },
  reason: string,
): void {
  assert.equal(result.items.length, 0)
  assert.equal(result.empty, true)
  const list = result as { reason?: string; hint?: string }
  assert.equal(list.reason, reason)
  assert.equal(typeof list.hint, 'string')
  assert.ok((list.hint ?? '').length > 0, '空态必须给 hint')
}

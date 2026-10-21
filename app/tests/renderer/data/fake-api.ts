import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import type { ApiFailure, ErrorCode } from '../../../src/collab/protocol/errors.ts'
import type {
  IsoTimestamp,
  MessageId,
  ProjectId,
  SessionId,
  Sha256Hex,
  TaskId,
} from '../../../src/collab/protocol/ids.ts'
import type { TaskDetail, TaskSummary } from '../../../src/collab/protocol/tool-outputs.ts'

export const fakeIds = {
  projectId: 'project-1' as ProjectId,
  sessionId: 'session-1' as SessionId,
  taskId: 'task-1' as TaskId,
}

export const fakeTimestamp = '2026-10-21T10:00:00.000Z' as IsoTimestamp
export const fakeSha = 'a'.repeat(64) as Sha256Hex

export function fakeFailure(
  code: ErrorCode,
  message: string = code,
  detail: Record<string, unknown> = {},
): ApiFailure {
  return {
    ok: false,
    apiVersion: 'cadre-heihei/1',
    error: { code, message, retryable: code === 'DELIVERY_FAILED', ...detail } as ApiFailure['error'],
  }
}

export function fakeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    taskId: fakeIds.taskId,
    projectId: fakeIds.projectId,
    seq: 1,
    title: '实现台账列表',
    status: 'in_progress',
    assigneeSessionId: fakeIds.sessionId,
    assigneeName: '前端员工',
    attempt: 0,
    updatedAt: '2026-10-21T10:00:00.000Z' as TaskSummary['updatedAt'],
    ...overrides,
  }
}

export function fakeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...fakeTask(),
    body: '实现台账列表与详情',
    transitions: [
      { from: null, to: 'dispatched', at: fakeTimestamp, actorSessionId: 'system' },
    ],
    report: null,
    sourceSessionId: 'session-0' as SessionId,
    version: 1,
    ...overrides,
  }
}

/** 测试专用 CadreApi；不依赖 Electron/preload。 */
export function createFakeCadreApi(overrides: Partial<CadreApi> = {}): CadreApi {
  return {
    available: true,
    whoami: async () => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      projectId: fakeIds.projectId,
      sessionId: fakeIds.sessionId,
      role: 'supervisor',
      projectName: 'demo',
    }),
    listTasks: async () => ({ ok: true, apiVersion: 'cadre-heihei/1', items: [] }),
    listRoster: async () => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      projects: [],
      members: [],
      scope: {
        scope: { kind: 'project', projectId: fakeIds.projectId },
        globalCount: 0,
        dispatchableCount: 0,
        projectMatched: true,
        reason: 'no_workers_in_project',
        hint: '添加员工或切换项目。',
      },
    }),
    getTask: async () => fakeFailure('TASK_NOT_FOUND', 'task not found'),
    getPreferences: async () => ({ ok: true, locale: 'zh', theme: 'white' }),
    setPreferences: async () => ({ ok: true }),
    dispatchTask: async (input) => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      taskId: 'task-new' as TaskId,
      projectId: fakeIds.projectId,
      messageId: 'message-dispatch' as MessageId,
      channel: 'mailbox',
      taskStatus: 'dispatched',
      deliveredAt: fakeTimestamp,
      bodyBytes: input.body.length,
      preview: input.body,
      bodySha256: fakeSha,
      serverVersion: 'test',
      ledgerUpdated: true,
    }),
    reportTask: async (input) => ({
      ok: true,
      apiVersion: 'cadre-heihei/1',
      taskId: input.taskId ?? fakeIds.taskId,
      projectId: fakeIds.projectId,
      messageId: 'message-report' as MessageId,
      channel: 'mailbox',
      taskStatusBefore: 'in_progress',
      taskStatusAfter: 'delivered',
      deliveredAt: fakeTimestamp,
      bodyBytes: input.body.length,
      preview: input.body,
      bodySha256: fakeSha,
      serverVersion: 'test',
      ledgerUpdated: true,
    }),
    reviewTask: async (input) => ({
      ok: true,
      taskId: input.taskId,
      from: 'delivered',
      to: 'review',
      attempt: 1,
      updatedAt: fakeTimestamp,
      ledgerUpdated: true,
    }),
    ...overrides,
  }
}

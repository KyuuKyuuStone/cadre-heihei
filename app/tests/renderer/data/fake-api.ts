import type { CadreApi } from '../../../src/renderer/data/cadreApi.ts'
import type { ApiFailure, ErrorCode } from '../../../src/collab/protocol/errors.ts'
import type { ProjectId, SessionId, TaskId } from '../../../src/collab/protocol/ids.ts'
import type { TaskSummary } from '../../../src/collab/protocol/tool-outputs.ts'

export const fakeIds = {
  projectId: 'project-1' as ProjectId,
  sessionId: 'session-1' as SessionId,
  taskId: 'task-1' as TaskId,
}

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
    ...overrides,
  }
}

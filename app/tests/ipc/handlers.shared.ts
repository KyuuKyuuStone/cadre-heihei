/** IPC 只读通道契约（内存 / SQLite 同一套）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DispatchService } from '../../src/collab/dispatch/index.ts'
import { InMemoryIdentityBinding } from '../../src/main/identity.ts'
import { InMemoryPreferencesStore } from '../../src/main/preferences.ts'
import { createIpcHandlers, type IpcResult } from '../../src/main/ipc-handlers.ts'
import type { IpcRole } from '../../src/shared/ipc.ts'
import {
  EMP,
  EMP2,
  EMP3,
  EMP_P2,
  MCP_MEMBERS,
  P1,
  P2,
  SUP,
  SUP2,
  TASK,
} from '../mcp/seed.ts'

export interface IpcBackend {
  readonly service: DispatchService
  close(): void
}
export type MakeIpcBackend = () => IpcBackend

interface SetupOptions {
  readonly projectId?: typeof P1 | typeof P2 | string
  readonly sessionId?: typeof SUP | typeof EMP | string
  readonly role?: IpcRole
}

function isFailure(result: IpcResult): result is Extract<IpcResult, { ok: false }> {
  return result.ok === false
}

export function runIpcContract(name: string, makeBackend: MakeIpcBackend): void {
  function setup(options: SetupOptions = {}) {
    const backend = makeBackend()
    const binding = new InMemoryIdentityBinding()
    const prefs = new InMemoryPreferencesStore()
    const windowId = 'win-1'
    binding.bind(windowId, {
      projectId: (options.projectId ?? P1) as never,
      sessionId: (options.sessionId ?? SUP) as never,
      role: options.role ?? 'supervisor',
    })
    const handlers = createIpcHandlers({
      binding,
      backend: backend.service,
      preferences: prefs,
      projectNameFor: (projectId) => `项目 ${projectId}`,
    })
    return { backend, binding, prefs, handlers, windowId }
  }

  test(`[${name}] I-IPC-01 whoami 返回绑定身份且不含密钥`, () => {
    const ctx = setup({ sessionId: SUP, role: 'supervisor' })
    try {
      const result = ctx.handlers.handle(ctx.windowId, 'app:whoami') as any
      assert.equal(result.ok, true)
      assert.equal(result.projectId, P1)
      assert.equal(result.sessionId, SUP)
      assert.equal(result.role, 'supervisor')
      assert.equal(result.projectName, `项目 ${P1}`)
      const serialized = JSON.stringify(result).toLowerCase()
      assert.equal(serialized.includes('apikey'), false)
      assert.equal(serialized.includes('token'), false)
      assert.equal(serialized.includes('secret'), false)
    } finally {
      ctx.backend.close()
    }
  })

  test(`[${name}] I-IPC-02 只读通道成功路径字段齐全`, () => {
    const ctx = setup()
    try {
      const tasks = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {
        status: ['review', 'delivered'],
        limit: 10,
      }) as any
      assert.equal(tasks.ok, true)
      assert.ok(tasks.items.length > 0)
      const item = tasks.items[0]
      for (const field of ['taskId', 'projectId', 'seq', 'title', 'status', 'assigneeSessionId', 'attempt', 'updatedAt']) {
        assert.ok(field in item, `TaskSummary 缺字段 ${field}`)
      }
      assert.ok(tasks.items.every((entry: any) => ['review', 'delivered'].includes(entry.status)))

      const roster = ctx.handlers.handle(ctx.windowId, 'collab:listRoster', {
        scope: 'project',
      }) as any
      assert.equal(roster.ok, true)
      assert.equal(roster.scope.kind, 'project')
      assert.equal(roster.members.length, MCP_MEMBERS.filter((member) => member.projectId === P1).length)
      assert.ok(roster.members.every((member: any) => member.projectId === P1))

      const prefs = ctx.handlers.handle(ctx.windowId, 'prefs:get') as any
      assert.equal(prefs.ok, true)
      assert.equal(prefs.locale, 'en')
      assert.equal(prefs.theme, 'white')

      const set = ctx.handlers.handle(ctx.windowId, 'prefs:set', {
        locale: 'zh',
        theme: 'dark',
      }) as any
      assert.equal(set.ok, true)
      const updated = ctx.handlers.handle(ctx.windowId, 'prefs:get') as any
      assert.equal(updated.locale, 'zh')
      assert.equal(updated.theme, 'dark')

      ctx.handlers.handle(ctx.windowId, 'prefs:set', { theme: 'ink-blue' })
      const partial = ctx.handlers.handle(ctx.windowId, 'prefs:get') as any
      assert.equal(partial.locale, 'zh', '部分更新不得重置 locale')
      assert.equal(partial.theme, 'ink-blue')
    } finally {
      ctx.backend.close()
    }
  })

  test(`[${name}] I-IPC-03 参数缺失/类型错/未知字段 → INVALID_ARGUMENT`, () => {
    const ctx = setup()
    try {
      const badStatus = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {
        status: 'not-a-status',
      }) as any
      assert.equal(badStatus.error.code, 'INVALID_ARGUMENT')
      assert.equal(badStatus.error.field, 'status')

      const badLimit = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {
        limit: 101,
      }) as any
      assert.equal(badLimit.error.code, 'INVALID_ARGUMENT')
      assert.equal(badLimit.error.field, 'limit')

      const arrayInput = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', [1, 2]) as any
      assert.equal(arrayInput.error.code, 'INVALID_ARGUMENT')
      assert.equal(arrayInput.error.field, 'input')

      const badLocale = ctx.handlers.handle(ctx.windowId, 'prefs:set', {
        locale: 'fr',
      }) as any
      assert.equal(badLocale.error.field, 'locale')

      const badTheme = ctx.handlers.handle(ctx.windowId, 'prefs:set', {
        theme: 'neon',
      }) as any
      assert.equal(badTheme.error.field, 'theme')

      const unknownPref = ctx.handlers.handle(ctx.windowId, 'prefs:set', {
        font: 'serif',
      }) as any
      assert.equal(unknownPref.error.field, 'font')

      const unknownChannel = ctx.handlers.handle(ctx.windowId, 'nope:channel', {}) as any
      assert.equal(unknownChannel.error.code, 'INVALID_ARGUMENT')
      assert.equal(unknownChannel.error.field, 'channel')
    } finally {
      ctx.backend.close()
    }
  })

  test(`[${name}] I-IPC-04 renderer 覆盖 projectId/sessionId → INVALID_ARGUMENT`, () => {
    const ctx = setup({ sessionId: SUP, role: 'supervisor' })
    try {
      const spoofProject = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {
        projectId: P2,
      }) as any
      assert.equal(spoofProject.error.code, 'INVALID_ARGUMENT')
      assert.equal(spoofProject.error.field, 'projectId')

      const spoofSession = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {
        sessionId: EMP,
      }) as any
      assert.equal(spoofSession.error.code, 'INVALID_ARGUMENT')
      assert.equal(spoofSession.error.field, 'sessionId')

      // 覆盖尝试不得改变绑定；后续正常调用仍用原身份。
      const whoami = ctx.handlers.handle(ctx.windowId, 'app:whoami') as any
      assert.equal(whoami.sessionId, SUP)
      const normal = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {}) as any
      assert.equal(normal.ok, true)
    } finally {
      ctx.backend.close()
    }
  })

  test(`[${name}] I-IPC-05 跨项目 → CROSS_PROJECT_DENIED 且无泄露字段`, () => {
    const outsider = setup({ projectId: P1, sessionId: EMP_P2, role: 'worker' })
    try {
      const result = outsider.handlers.handle(outsider.windowId, 'collab:listTasks', {}) as any
      assert.equal(result.error.code, 'CROSS_PROJECT_DENIED')
      assert.equal('candidates' in result.error, false)
      assert.equal('taskId' in result.error, false)
      assert.equal('items' in result, false)

      const unbound = createIpcHandlers({
        binding: outsider.binding,
        backend: outsider.backend.service,
        preferences: outsider.prefs,
      }).handle('nonexistent-window', 'collab:listTasks', {}) as any
      assert.equal(unbound.error.code, 'CROSS_PROJECT_DENIED')
    } finally {
      outsider.backend.close()
    }

    const p2 = setup({ projectId: P2, sessionId: SUP2, role: 'supervisor' })
    try {
      const result = p2.handlers.handle(p2.windowId, 'collab:listTasks', {}) as any
      assert.equal(result.ok, true)
      assert.ok(result.items.length > 0)
      assert.ok(result.items.every((item: any) => item.projectId === P2))
      assert.equal(result.items.some((item: any) => item.taskId === TASK.inProgress), false)
    } finally {
      p2.backend.close()
    }
  })

  test(`[${name}] I-IPC-06 角色范围：worker 仅本人，不能指定他人`, () => {
    const worker = setup({ sessionId: EMP, role: 'worker' })
    try {
      const own = worker.handlers.handle(worker.windowId, 'collab:listTasks', {}) as any
      assert.equal(own.ok, true)
      assert.ok(own.items.every((item: any) => item.assigneeSessionId === EMP))
      assert.equal(own.items.some((item: any) => item.status === 'verified'), false)

      const otherFilter = worker.handlers.handle(worker.windowId, 'collab:listTasks', {
        assigneeSessionId: EMP2,
      }) as any
      assert.equal(otherFilter.error.code, 'FORBIDDEN_ACTOR')
      assert.equal(otherFilter.error.reasonCategory, 'not-assignee')
    } finally {
      worker.backend.close()
    }

    const emptyWorker = setup({ sessionId: EMP2, role: 'worker' })
    try {
      const empty = emptyWorker.handlers.handle(emptyWorker.windowId, 'collab:listTasks', {}) as any
      assert.equal(empty.ok, true)
      assert.equal(empty.empty, true)
      assert.equal(empty.items.length, 0)
    } finally {
      emptyWorker.backend.close()
    }
  })

  test(`[${name}] 未映射异常 → INTERNAL_ERROR + rawCode，不抛出`, () => {
    const ctx = setup()
    try {
      const faultyBackend = new Proxy(ctx.backend.service, {
        get(target, property, receiver) {
          if (property === 'listMembers') {
            return () => {
              throw Object.assign(new Error('backend exploded'), { code: 'E_TEST_RAW' })
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })
      const handlers = createIpcHandlers({
        binding: ctx.binding,
        backend: faultyBackend,
        preferences: ctx.prefs,
      })
      const result = handlers.handle(ctx.windowId, 'app:whoami') as any
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'INTERNAL_ERROR')
      assert.equal(result.error.retryable, false)
      assert.equal(result.error.rawCode, 'E_TEST_RAW')
    } finally {
      ctx.backend.close()
    }
  })

  test(`[${name}] I-IPC-08 空态：reason + hint（任务/花名册）`, () => {
    const ctx = setup({ sessionId: EMP3, role: 'worker' })
    try {
      const empty = ctx.handlers.handle(ctx.windowId, 'collab:listTasks', {}) as any
      assert.equal(empty.empty, true)
      assert.ok(typeof empty.reason === 'string' && empty.reason.length > 0)
      assert.ok(typeof empty.hint === 'string' && empty.hint.length > 0)

      // 只有主管、没有 worker 的项目：花名册给出 no_workers_in_project。
      ctx.backend.service.addMember({
        projectId: 'ipc-empty-project' as never,
        sessionId: SUP,
        role: 'supervisor',
        state: 'available',
      })
      ctx.binding.bind('win-empty', {
        projectId: 'ipc-empty-project' as never,
        sessionId: SUP,
        role: 'supervisor',
      })
      const roster = ctx.handlers.handle('win-empty', 'collab:listRoster', {
        scope: 'project',
      }) as any
      assert.equal(roster.ok, true)
      assert.equal(roster.scope.dispatchableCount, 0)
      assert.equal(roster.scope.reason, 'no_workers_in_project')
      assert.ok(typeof roster.scope.hint === 'string' && roster.scope.hint.length > 0)
    } finally {
      ctx.backend.close()
    }
  })
}

export { isFailure }

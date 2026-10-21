/**
 * M2 MCP 工具层契约测试（内存 / SQLite 同一套）。
 * 全部以直调 stdio JSON-RPC 判定，不采信模型自述（N14）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { McpClient } from './client.ts'
import type { SessionId } from '../../src/collab/protocol/index.ts'
import {
  EMP,
  EMP2,
  EMP3,
  OFFLINE,
  P1,
  P2,
  STRANGER,
  SUP,
  SUP2,
  SUP_B,
  SUP_NEW,
  SUP_OLD,
  TASK,
} from './seed.ts'

export interface McpHarness {
  readonly client: McpClient
  close(): Promise<void>
}
export type StartHarness = (sessionId: SessionId) => Promise<McpHarness>
export type SeedInspector = (databasePath: string) => Record<string, unknown>

async function withClient(
  start: StartHarness,
  sessionId: SessionId,
  fn: (client: McpClient) => Promise<void>,
): Promise<void> {
  const harness = await start(sessionId)
  try {
    await harness.client.initialize()
    await fn(harness.client)
  } finally {
    await harness.close()
  }
}

function err(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.error as Record<string, unknown>
}

const DISPATCH_BASE = {
  toSessionId: EMP,
  title: 'MCP 任务',
  body: '正文',
}

export function runMcpContract(name: string, start: StartHarness): void {
  test(`[${name}] T-MCP-01 工具发现：6 个工具及 schema`, async () => {
    await withClient(start, SUP, async (client) => {
      const tools = await client.listTools()
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['dispatch_task', 'get_task', 'list_roster', 'list_tasks', 'report_task', 'review_task'],
      )
      for (const tool of tools) {
        assert.equal(typeof tool.description, 'string')
        assert.equal((tool.inputSchema as Record<string, unknown>).type, 'object')
      }
    })
  })

  test(`[${name}] T-MCP-02 派活成功：回执与台账/审计`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        idempotencyKey: 't02-dispatch',
      })
      assert.equal(response.isError, false)
      const payload = response.payload as any
      assert.equal(payload.ok, true)
      assert.equal(payload.taskStatus, 'dispatched')
      assert.equal(payload.channel, 'http')
      assert.equal(payload.ledgerUpdated, true)
      assert.equal(typeof payload.bodySha256, 'string')

      const detail = (await client.callTool('get_task', { taskId: payload.taskId })).payload as any
      assert.equal(detail.ok, true)
      assert.equal(detail.status, 'dispatched')
      assert.equal(detail.transitions.length, 1)
      assert.equal(detail.transitions[0].to, 'dispatched')
    })
  })

  test(`[${name}] T-MCP-03 派活空正文 → EMPTY_BODY 且不落台账`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        body: '   ',
        idempotencyKey: 't03-empty',
      })
      assert.equal(response.isError, true)
      assert.equal(err(response.payload).code, 'EMPTY_BODY')
      const list = (await client.callTool('list_tasks', {})).payload as any
      assert.equal(list.items.some((item: any) => item.title === 'MCP 任务'), false)
    })
  })

  test(`[${name}] T-MCP-04 派活客户端命令 → CLIENT_COMMAND_REJECTED`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        body: ' /COMPACT now',
        idempotencyKey: 't04-command',
      })
      assert.equal(response.isError, true)
      assert.equal(err(response.payload).code, 'CLIENT_COMMAND_REJECTED')
    })
  })

  test(`[${name}] T-MCP-05 目标 offline / 非成员 → FORBIDDEN_ACTOR`, async () => {
    await withClient(start, SUP, async (client) => {
      const offline = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        toSessionId: OFFLINE,
        idempotencyKey: 't05-offline',
      })
      assert.equal(err(offline.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(offline.payload).reasonCategory, 'target-offline')

      const stranger = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        toSessionId: STRANGER,
        idempotencyKey: 't05-stranger',
      })
      assert.equal(err(stranger.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(stranger.payload).reasonCategory, 'target-not-member')
    })
  })

  test(`[${name}] T-MCP-06 员工派活 → FORBIDDEN_ACTOR not-supervisor`, async () => {
    await withClient(start, EMP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        idempotencyKey: 't06-worker',
      })
      assert.equal(response.isError, true)
      assert.equal(err(response.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(response.payload).reasonCategory, 'not-supervisor')
      assert.equal(err(response.payload).requiredActor, 'supervisor')
    })
  })

  test(`[${name}] T-MCP-07 跨项目派活 → CROSS_PROJECT_DENIED 无泄露字段`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        supersedesTaskId: TASK.p2,
        idempotencyKey: 't07-cross',
      })
      const error = err(response.payload)
      assert.equal(error.code, 'CROSS_PROJECT_DENIED')
      assert.equal('candidates' in error, false)
      assert.equal('taskId' in error, false)
      assert.equal('taskTitle' in error, false)
    })
  })

  test(`[${name}] T-MCP-08 supersedes：旧任务 cancelled/superseded`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        supersedesTaskId: TASK.inProgress,
        idempotencyKey: 't08-supersede',
      })
      const payload = response.payload as any
      assert.equal(payload.ok, true)
      assert.deepEqual(payload.supersededTask, {
        taskId: TASK.inProgress,
        status: 'cancelled',
        reason: 'superseded',
      })
      const old = (await client.callTool('get_task', { taskId: TASK.inProgress })).payload as any
      assert.equal(old.status, 'cancelled')
      assert.equal(old.supersededByTaskId, payload.taskId)
    })
  })

  test(`[${name}] T-MCP-09 汇报成功：原子推进 + 详情含 report`, async () => {
    await withClient(start, EMP, async (client) => {
      const response = await client.callTool('report_task', {
        taskId: TASK.inProgress,
        body: '已完成功能',
        deliverables: ['src/a.ts'],
        idempotencyKey: 't09-report',
      })
      const payload = response.payload as any
      assert.equal(payload.ok, true)
      assert.equal(payload.ledgerUpdated, true)
      assert.equal(payload.taskStatusBefore, 'in_progress')
      assert.equal(payload.taskStatusAfter, 'delivered')

      const detail = (await client.callTool('get_task', { taskId: TASK.inProgress })).payload as any
      assert.equal(detail.status, 'delivered')
      assert.equal(detail.transitions.length, 4)
      assert.equal(detail.report.summary, '已完成功能')
      assert.deepEqual(detail.report.deliverables, ['src/a.ts'])
    })
  })

  test(`[${name}] T-MCP-10 漏 taskId：候选与零候选 hint`, async () => {
    await withClient(start, EMP, async (client) => {
      const response = await client.callTool('report_task', {
        body: '完成',
        deliverables: [],
        idempotencyKey: 't10-missing',
      })
      const error = err(response.payload)
      assert.equal(error.code, 'MISSING_TASK_ID')
      assert.ok((error.candidates as unknown[]).length > 0)
      assert.equal(error.truncated, false)
      assert.ok(String(error.hint).length > 0)
      for (const candidate of error.candidates as any[]) {
        assert.ok(!['verified', 'failed', 'cancelled'].includes(candidate.status))
      }
    })

    await withClient(start, EMP3, async (client) => {
      const response = await client.callTool('report_task', {
        body: '完成',
        deliverables: [],
        idempotencyKey: 't10-zero',
      })
      const error = err(response.payload)
      assert.equal(error.code, 'MISSING_TASK_ID')
      assert.deepEqual(error.candidates, [])
      assert.equal(error.candidateCount, 0)
      assert.ok(String(error.hint).length > 0)
    })
  })

  test(`[${name}] T-MCP-09b 汇报推进失败：ok=true + ledgerUpdated:false + ledgerError`, async () => {
    await withClient(start, EMP, async (client) => {
      const response = await client.callTool('report_task', {
        taskId: TASK.delivered,
        body: '重复汇报',
        deliverables: [],
        idempotencyKey: 't09b-no-advance',
      })
      const payload = response.payload as any
      assert.equal(payload.ok, true)
      assert.equal(payload.ledgerUpdated, false)
      assert.match(String(payload.ledgerError), /INVALID_TRANSITION/)
      const detail = (await client.callTool('get_task', { taskId: TASK.delivered })).payload as any
      assert.equal(detail.status, 'delivered')
    })
  })

  test(`[${name}] T-MCP-11 非 assignee 汇报 → FORBIDDEN_ACTOR not-assignee`, async () => {
    await withClient(start, EMP2, async (client) => {
      const response = await client.callTool('report_task', {
        taskId: TASK.review,
        body: '代汇报',
        deliverables: [],
        idempotencyKey: 't11-not-assignee',
      })
      assert.equal(response.isError, true)
      assert.equal(err(response.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(response.payload).reasonCategory, 'not-assignee')
      assert.equal(err(response.payload).actorSessionId, EMP2)
    })
  })

  test(`[${name}] T-MCP-12 台账空态：EmptyList + reason + hint`, async () => {
    await withClient(start, EMP3, async (client) => {
      const payload = (await client.callTool('list_tasks', {})).payload as any
      assert.equal(payload.ok, true)
      assert.equal(payload.empty, true)
      assert.deepEqual(payload.items, [])
      // 项目有任务，但 worker 的可见范围（本人）为空。
      assert.equal(payload.reason, 'no_tasks_for_filter')
      assert.ok(String(payload.hint).length > 0)
    })
  })

  test(`[${name}] T-MCP-13 台账筛选：状态过滤与空过滤态`, async () => {
    await withClient(start, SUP, async (client) => {
      const verified = (await client.callTool('list_tasks', { status: 'verified' })).payload as any
      assert.ok(verified.items.some((item: any) => item.taskId === TASK.verified))
      for (const item of verified.items) assert.equal(item.status, 'verified')

      const arrayFilter = (await client.callTool('list_tasks', {
        status: ['delivered', 'review'],
        limit: 2,
      })).payload as any
      assert.ok(arrayFilter.items.length <= 2)
      assert.ok(arrayFilter.total >= arrayFilter.items.length)

      const all = (await client.callTool('list_tasks', { limit: 100 })).payload as any
      const cursorItem = all.items[2]
      const since = (
        await client.callTool('list_tasks', {
          since: { updatedAt: cursorItem.updatedAt, seq: cursorItem.seq },
          limit: 100,
        })
      ).payload as any
      for (const item of since.items) {
        assert.ok(
          item.updatedAt > cursorItem.updatedAt ||
            (item.updatedAt === cursorItem.updatedAt && item.seq > cursorItem.seq),
          'since 之后的任务必须严格晚于游标',
        )
      }
    })

    await withClient(start, EMP3, async (client) => {
      const payload = (await client.callTool('list_tasks', { status: 'verified' })).payload as any
      assert.equal(payload.empty, true)
      assert.equal(payload.reason, 'no_tasks_for_filter')
    })
  })

  test(`[${name}] T-MCP-14 单查：详情、不存在与跨项目`, async () => {
    await withClient(start, SUP, async (client) => {
      const detail = (await client.callTool('get_task', { taskId: TASK.review })).payload as any
      assert.equal(detail.ok, true)
      assert.equal(detail.status, 'review')
      assert.equal(detail.transitions.length, 5)
      assert.equal(detail.report, null)

      const missing = await client.callTool('get_task', { taskId: 'no-such-task' })
      assert.equal(err(missing.payload).code, 'TASK_NOT_FOUND')

      const cross = await client.callTool('get_task', { taskId: TASK.p2 })
      assert.equal(err(cross.payload).code, 'CROSS_PROJECT_DENIED')
      assert.equal('taskId' in err(cross.payload), false)
    })
  })

  test(`[${name}] T-MCP-15 花名册双口径：project / global`, async () => {
    await withClient(start, SUP, async (client) => {
      const project = (await client.callTool('list_roster', { scope: 'project' })).payload as any
      assert.equal(project.ok, true)
      assert.equal(project.scope.kind, 'project')
      assert.equal(project.scope.projectMatched, true)
      assert.equal(project.members.every((member: any) => member.projectId === P1), true)
      const offline = project.members.find((member: any) => member.sessionId === OFFLINE)
      assert.equal(offline.dispatchable, false)

      const global = (await client.callTool('list_roster', { scope: 'global' })).payload as any
      assert.equal(global.scope.kind, 'global')
      assert.equal(global.scope.dispatchable, false)
      assert.equal(global.scope.dispatchableCount, 0)
      assert.equal(global.scope.globalCount, project.scope.globalCount)
      assert.deepEqual(global.members, [])
    })
  })

  test(`[${name}] T-MCP-16 验收主路径：delivered→review→verified`, async () => {
    await withClient(start, SUP, async (client) => {
      const enter = (
        await client.callTool('review_task', {
          taskId: TASK.delivered,
          action: 'enter_review',
          idempotencyKey: 't16-review',
        })
      ).payload as any
      assert.equal(enter.ok, true)
      assert.equal(enter.from, 'delivered')
      assert.equal(enter.to, 'review')
      assert.equal(enter.ledgerUpdated, true)

      const verify = (
        await client.callTool('review_task', {
          taskId: TASK.delivered,
          action: 'verify',
          idempotencyKey: 't16-verify',
        })
      ).payload as any
      assert.equal(verify.from, 'review')
      assert.equal(verify.to, 'verified')

      const detail = (await client.callTool('get_task', { taskId: TASK.delivered })).payload as any
      assert.equal(detail.status, 'verified')
      assert.equal(detail.transitions.length, 6)
    })
  })

  test(`[${name}] T-MCP-17 跳过 review → INVALID_TRANSITION`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.delivered,
        action: 'verify',
        idempotencyKey: 't17-skip',
      })
      assert.equal(response.isError, true)
      assert.equal(err(response.payload).code, 'INVALID_TRANSITION')
      const detail = (await client.callTool('get_task', { taskId: TASK.delivered })).payload as any
      assert.equal(detail.status, 'delivered')
    })
  })

  test(`[${name}] T-MCP-18 rework/fail 缺 reason → MISSING_REASON 且状态不变`, async () => {
    await withClient(start, SUP, async (client) => {
      for (const action of ['rework', 'fail']) {
        const response = await client.callTool('review_task', {
          taskId: TASK.review,
          action,
          idempotencyKey: `t18-${action}`,
        })
        assert.equal(err(response.payload).code, 'MISSING_REASON')
      }
      const detail = (await client.callTool('get_task', { taskId: TASK.review })).payload as any
      assert.equal(detail.status, 'review')

      const rework = (
        await client.callTool('review_task', {
          taskId: TASK.review,
          action: 'rework',
          reason: '补充测试',
          idempotencyKey: 't18-rework-ok',
        })
      ).payload as any
      assert.equal(rework.ok, true)
      assert.equal(rework.to, 'rework')
      assert.equal(rework.attempt, 1)
    })
  })

  test(`[${name}] T-MCP-19 非在册 supervisor 验收：dispatcher 不再是判据`, async () => {
    await withClient(start, EMP, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.review,
        action: 'verify',
        idempotencyKey: 't19-worker',
      })
      assert.equal(err(response.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(response.payload).reasonCategory, 'not-supervisor')
    })

    await withClient(start, EMP2, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.workerDispatched,
        action: 'verify',
        idempotencyKey: 't19-dispatcher',
      })
      assert.equal(err(response.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(response.payload).reasonCategory, 'not-supervisor')
    })
  })

  test(`[${name}] T-MCP-20 多主管/换届：第二主管通过、旧主管被拒`, async () => {
    await withClient(start, SUP_B, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.reviewB,
        action: 'verify',
        idempotencyKey: 't20-sup-b',
      })
      assert.equal((response.payload as any).ok, true)
      assert.equal((response.payload as any).to, 'verified')
    })

    await withClient(start, SUP_NEW, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.review,
        action: 'verify',
        idempotencyKey: 't20-sup-new',
      })
      assert.equal((response.payload as any).ok, true)
    })

    await withClient(start, SUP_OLD, async (client) => {
      const response = await client.callTool('review_task', {
        taskId: TASK.review,
        action: 'verify',
        idempotencyKey: 't20-sup-old',
      })
      assert.equal(err(response.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(response.payload).reasonCategory, 'not-supervisor')
    })
  })

  test(`[${name}] T-MCP-21 终态锁死：任何迁移均 INVALID_TRANSITION`, async () => {
    await withClient(start, SUP, async (client) => {
      for (const action of ['enter_review', 'verify', 'rework', 'fail']) {
        const response = await client.callTool('review_task', {
          taskId: TASK.verified,
          action,
          reason: action === 'rework' || action === 'fail' ? '终态测试' : undefined,
          idempotencyKey: `t21-${action}`,
        })
        assert.equal(err(response.payload).code, 'INVALID_TRANSITION')
      }
      const detail = (await client.callTool('get_task', { taskId: TASK.verified })).payload as any
      assert.equal(detail.status, 'verified')
    })
  })

  test(`[${name}] T-MCP-22 幂等：派活/汇报重放与冲突`, async () => {
    await withClient(start, SUP, async (client) => {
      const request = { ...DISPATCH_BASE, idempotencyKey: 't22-dispatch' }
      const first = (await client.callTool('dispatch_task', request)).payload
      const second = (await client.callTool('dispatch_task', request)).payload
      assert.deepEqual(second, first)
      const conflict = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        body: '另一份正文',
        idempotencyKey: 't22-dispatch',
      })
      assert.equal(err(conflict.payload).code, 'IDEMPOTENCY_CONFLICT')
    })

    await withClient(start, EMP, async (client) => {
      const request = {
        taskId: TASK.inProgress,
        body: '完成',
        deliverables: [],
        idempotencyKey: 't22-report',
      }
      const first = (await client.callTool('report_task', request)).payload
      const second = (await client.callTool('report_task', request)).payload
      assert.deepEqual(second, first)
      const detail = (await client.callTool('get_task', { taskId: TASK.inProgress })).payload as any
      assert.equal(detail.transitions.length, 4, '重放不得重复写 delivered 事件')
    })
  })

  test(`[${name}] T-MCP-24 身份防伪：工具参数不能覆盖注入身份`, async () => {
    await withClient(start, SUP, async (client) => {
      const spoofed = await client.callTool('dispatch_task', {
        ...DISPATCH_BASE,
        projectId: P2,
        sessionId: SUP2,
        callerSessionId: SUP2,
        idempotencyKey: 't24-spoof',
      })
      assert.equal((spoofed.payload as any).ok, true)
      assert.equal((spoofed.payload as any).projectId, P1)

      const roster = await client.callTool('list_roster', { forSession: EMP })
      assert.equal(err(roster.payload).code, 'CROSS_PROJECT_DENIED')

      // 读取类工具同样忽略伪造 projectId，仍只返回注入项目的数据。
      const tasks = (await client.callTool('list_tasks', { projectId: P2 })).payload as any
      assert.equal(tasks.ok, true)
      assert.ok(tasks.items.every((item: any) => item.projectId === P1))
    })
  })

  test(`[${name}] 参数错误：INVALID_ARGUMENT + field（不用 INTERNAL_ERROR）`, async () => {
    await withClient(start, SUP, async (client) => {
      const missingKey = await client.callTool('dispatch_task', DISPATCH_BASE)
      assert.equal(err(missingKey.payload).code, 'INVALID_ARGUMENT')
      assert.equal(err(missingKey.payload).field, 'idempotencyKey')

      const badAction = await client.callTool('review_task', {
        taskId: TASK.review,
        action: 'approve',
        idempotencyKey: 'bad-action',
      })
      assert.equal(err(badAction.payload).code, 'INVALID_ARGUMENT')
      assert.equal(err(badAction.payload).field, 'action')

      const badStatus = await client.callTool('list_tasks', { status: 'unknown-status' })
      assert.equal(err(badStatus.payload).code, 'INVALID_ARGUMENT')
      assert.equal(err(badStatus.payload).field, 'status')

      const badLimit = await client.callTool('list_tasks', { limit: 101 })
      assert.equal(err(badLimit.payload).code, 'INVALID_ARGUMENT')
      assert.equal(err(badLimit.payload).field, 'limit')
    })

    await withClient(start, EMP3, async (client) => {
      const otherAssignee = await client.callTool('list_tasks', {
        assigneeSessionId: EMP,
      })
      assert.equal(err(otherAssignee.payload).code, 'FORBIDDEN_ACTOR')
      assert.equal(err(otherAssignee.payload).reasonCategory, 'not-assignee')
    })
  })

  test(`[${name}] JSON-RPC：未知工具返回协议错误`, async () => {
    await withClient(start, SUP, async (client) => {
      const response = await client.request('tools/call', { name: 'no_such_tool', arguments: {} })
      const error = response.error as { code?: number } | undefined
      assert.equal(error?.code, -32601)
    })
  })
}

export type { McpClient }

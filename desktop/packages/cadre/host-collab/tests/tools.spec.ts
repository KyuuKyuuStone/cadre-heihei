import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, pageTaskRows, type HostTaskRow } from '../src/index.ts'

const PROJECT = 'p1'
const SUPERVISOR = 'sup'
const WORKER = 'w1'
const WORKER_2 = 'w2'
const AT = '2026-10-20T00:00:00.000Z'

interface RegisteredTool {
  readonly name: string
  output?: { render(args: unknown, value: unknown): readonly unknown[] }
  execute(args: unknown, run: unknown): Promise<unknown>
}

type StepHandler = (payload: unknown, next: () => unknown) => unknown

interface Mounted {
  readonly tools: Map<string, RegisteredTool>
  readonly handlers: Map<string, StepHandler>
  readonly prompts: unknown[]
}

const roots: string[] = []
const closes: (() => void)[] = []

afterEach(() => {
  for (const close of closes.splice(0)) close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function freshDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-host-tools-'))
  roots.push(root)
  return join(root, 'cadre.sqlite')
}

function mount(
  databasePath: string,
  options: { prompt?: (request: unknown) => Promise<void> } = {},
): Mounted {
  const registered = new Map<string, RegisteredTool>()
  const handlers = new Map<string, StepHandler>()
  const effects: (() => void)[] = []
  const prompts: unknown[] = []
  const previous = process.env.CADRE_LEDGER_PATH
  process.env.CADRE_LEDGER_PATH = databasePath
  apply({
    tools: { register: (definition: RegisteredTool) => { registered.set(definition.name, definition) } },
    effect: (setup: () => () => void) => { effects.push(setup()); return () => {} },
    on: (event: string, handler: StepHandler) => { handlers.set(event, handler); return () => {} },
    sessionController: {
      prompt: options.prompt ?? ((request: unknown) => {
        prompts.push(request)
        return Promise.resolve()
      }),
    },
  } as never)
  closes.push(() => {
    for (const dispose of effects) dispose()
    if (previous === undefined) delete process.env.CADRE_LEDGER_PATH
    else process.env.CADRE_LEDGER_PATH = previous
  })
  return { tools: registered, handlers, prompts }
}

function seedRoster(databasePath: string): void {
  const db = new DatabaseSync(databasePath)
  const insert = db.prepare(`INSERT INTO members
    (project_id, session_id, role, display_name, description, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`)
  try {
    insert.run(PROJECT, SUPERVISOR, 'supervisor', '主管', AT, AT)
    insert.run(PROJECT, WORKER, 'worker', '小明', AT, AT)
    insert.run(PROJECT, WORKER_2, 'worker', '小红', AT, AT)
  } finally {
    db.close()
  }
}

function seedTask(databasePath: string, input: {
  readonly taskId: string
  readonly seq: number
  readonly assignee: string
  readonly status?: string
  readonly title?: string
  readonly dueAt?: string
}): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256,
      status, dispatcher_session_id, assignee_session_id, attempt, created_at, updated_at, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
      input.taskId, PROJECT, input.seq, input.title ?? `标题 ${input.taskId}`,
      `正文 ${input.taskId}`, 8, 'sha', input.status ?? 'delivered', SUPERVISOR, input.assignee,
      AT, AT, input.dueAt ?? null)
  } finally {
    db.close()
  }
}

function seedTerminalEvent(databasePath: string, input: {
  readonly taskId: string
  readonly status: string
  readonly reason: string
  readonly at?: string
}): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare(`INSERT INTO task_events (event_id, project_id, task_id, from_status, to_status,
      actor_session_id, reason, message_id, idempotency_key, at)
      VALUES (?, ?, ?, 'delivered', ?, ?, ?, NULL, ?, ?)`).run(
      `terminal-${input.taskId}`, PROJECT, input.taskId, input.status, SUPERVISOR, input.reason,
      `terminal:${input.taskId}`, input.at ?? AT)
  } finally {
    db.close()
  }
}

function countEvents(databasePath: string, taskId: string, toStatus: string): number {
  const db = new DatabaseSync(databasePath)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND to_status = ?')
      .get(taskId, toStatus) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function countPending(databasePath: string): number {
  const db = new DatabaseSync(databasePath)
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM pending_dispatch').get() as { n: number }).n
  } finally {
    db.close()
  }
}

function pendingEntry(databasePath: string): {
  pendingId: string; employee: string; title: string; body: string; dueAt: string
  reason: string; retryable: number; status: string
} | undefined {
  const db = new DatabaseSync(databasePath)
  try {
    const entry = db.prepare(`SELECT pending_id, employee, title, body, due_at, reason, retryable, status
      FROM pending_dispatch ORDER BY created_at DESC LIMIT 1`).get() as {
      pending_id: string; employee: string; title: string; body: string; due_at: string
      reason: string; retryable: number; status: string
    } | undefined
    if (entry === undefined) return undefined
    return {
      pendingId: entry.pending_id, employee: entry.employee, title: entry.title, body: entry.body,
      dueAt: entry.due_at, reason: entry.reason, retryable: entry.retryable, status: entry.status,
    }
  } finally {
    db.close()
  }
}

function countTasks(databasePath: string): number {
  const db = new DatabaseSync(databasePath)
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
  } finally {
    db.close()
  }
}

function addMember(databasePath: string, sessionId: string, role: string, displayName: string): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, description, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`).run(PROJECT, sessionId, role, displayName, AT, AT)
  } finally {
    db.close()
  }
}

const run = (sessionId: string): unknown => ({ agent: { id: sessionId }, signal: new AbortController().signal })

function row(input: {
  readonly taskId: string
  readonly status: string
  readonly assignee: string
  readonly updatedAt?: string
}): HostTaskRow {
  return {
    taskId: input.taskId,
    title: `标题 ${input.taskId}`,
    status: input.status,
    assigneeSessionId: input.assignee,
    dispatcherSessionId: SUPERVISOR,
    attempt: 0,
    createdAt: AT,
    updatedAt: input.updatedAt ?? AT,
    bodyPreview: `正文 ${input.taskId}`,
  }
}

describe('transition_task permission', () => {
  it('rejects a worker before the write path is touched', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    const tool = tools.get('transition_task')
    expect(tool).toBeDefined()

    await expect(tool!.execute({ taskId: 't1', to: 'verified' }, run(WORKER)))
      .rejects.toThrow(/FORBIDDEN_ACTOR/u)
  })

  it('rejects a session without a roster row', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    await expect(tools.get('transition_task')!.execute({ taskId: 't1', to: 'verified' }, run('stranger')))
      .rejects.toThrow(/FORBIDDEN_ACTOR/u)
  })

  it('masks transition_task from a worker in the step restriction', () => {
    const databasePath = freshDatabase()
    const { handlers } = mount(databasePath)
    seedRoster(databasePath)
    const calls: { deny?: readonly string[]; allow?: readonly string[] }[] = []
    const agent = {
      id: WORKER,
      ctx: {
        tools: {
          get: (name: string) => ({ name }),
          restrict: (filter: { deny?: readonly string[]; allow?: readonly string[] }) => {
            calls.push(filter)
            return () => {}
          },
        },
      },
    }

    const step = handlers.get('agent/pre-step')
    expect(step).toBeDefined()
    expect(step!({ agent }, () => 'next')).toBe('next')
    expect(calls[0]?.deny).toContain('transition_task')
    expect(calls[0]?.deny).toContain('dispatch_task')
  })
})

describe('pageTaskRows', () => {
  const names = new Map([[WORKER, '小明'], [WORKER_2, '小红']])
  const rows = [
    row({ taskId: 't1', status: 'delivered', assignee: WORKER, updatedAt: '2026-10-22T00:00:00.000Z' }),
    row({ taskId: 't2', status: 'dispatched', assignee: WORKER_2, updatedAt: '2026-10-21T00:00:00.000Z' }),
    row({ taskId: 't3', status: 'verified', assignee: WORKER, updatedAt: '2026-10-20T00:00:00.000Z' }),
  ]

  it('shows every open task to the supervisor', () => {
    const page = pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR })

    expect(page.rows.map(item => item.taskId)).toEqual(['t1', 't2'])
    expect(page.total).toBe(2)
    expect(page.empty).toBe(false)
  })

  it('includes closed tasks only when scope is all', () => {
    const page = pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR, scope: 'all' })

    expect(page.rows.map(item => item.taskId)).toEqual(['t1', 't2', 't3'])
  })

  it('limits a worker to its own tasks', () => {
    const page = pageTaskRows(rows, names, { role: 'worker', caller: WORKER, scope: 'all' })

    expect(page.rows.map(item => item.taskId)).toEqual(['t1', 't3'])
    expect(page.total).toBe(2)
  })

  it('filters by assignee display name', () => {
    const page = pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR, scope: 'all', assignee: '小红' })

    expect(page.rows.map(item => item.taskId)).toEqual(['t2'])
  })

  it('distinguishes an empty project from a filter miss', () => {
    const empty = pageTaskRows([], names, { role: 'supervisor', caller: SUPERVISOR })
    expect(empty).toMatchObject({ empty: true, reason: 'no_tasks' })
    expect(empty.hint).toContain('dispatch_task')

    const missed = pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR, assignee: '不存在' })
    expect(missed).toMatchObject({ empty: true, reason: 'no_match' })
    expect(missed.hint).toContain('去掉 scope/assignee')
  })

  it('gives a worker a role-appropriate hint', () => {
    const missed = pageTaskRows(rows, names, { role: 'worker', caller: WORKER, assignee: '小红' })
    expect(missed).toMatchObject({ empty: true, reason: 'no_match' })
    expect(missed.hint).toContain('只能看到派给自己的任务')
    expect(missed.hint).not.toContain('去掉 scope/assignee')

    const empty = pageTaskRows([], names, { role: 'worker', caller: WORKER })
    expect(empty.hint).toContain('等主管派活')
    expect(empty.hint).not.toContain('dispatch_task 派活')
  })

  it('reports truncation and rejects a bad limit', () => {
    const page = pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR, limit: 1 })
    expect(page).toMatchObject({ total: 2, truncated: true })
    expect(page.rows).toHaveLength(1)

    expect(() => pageTaskRows(rows, names, { role: 'supervisor', caller: SUPERVISOR, limit: 0 }))
      .toThrow(/limit/u)
  })
})

const bridgeBuilt = existsSync(fileURLToPath(new URL('../lib/cadre-ledger.cjs', import.meta.url)))

describe.skipIf(!bridgeBuilt)('tools over the built bridge', () => {
  it('lets a supervisor list the project and a worker list only itself', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER, dueAt: '2026-11-01T00:00:00.000Z' })
    seedTask(databasePath, { taskId: 't2', seq: 2, assignee: WORKER_2 })

    const supervisorView = await tools.get('list_tasks')!.execute({ scope: 'all' }, run(SUPERVISOR)) as {
      tasks: { taskId: string; assignee: { name: string }; dueAt?: string }[]
      total: number
      empty: boolean
    }
    expect(supervisorView.empty).toBe(false)
    expect(supervisorView.tasks.map(task => task.taskId)).toEqual(['t2', 't1'])
    expect(supervisorView.tasks[1]).toMatchObject({ assignee: { sessionId: WORKER, name: '小明' }, dueAt: '2026-11-01T00:00:00.000Z' })

    const workerView = await tools.get('list_tasks')!.execute({ scope: 'all' }, run(WORKER)) as {
      tasks: { taskId: string }[]
      total: number
    }
    expect(workerView.tasks.map(task => task.taskId)).toEqual(['t1'])
    expect(workerView.total).toBe(1)
  })

  it('accepts a delivered task through the tool and reports both events', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })

    const result = await tools.get('transition_task')!.execute(
      { taskId: 't1', to: 'verified', idempotencyKey: 'accept-t1' }, run(SUPERVISOR),
    ) as { status: string; replayed: boolean; steps: { from: string; to: string }[] }

    expect(result.status).toBe('verified')
    expect(result.replayed).toBe(false)
    expect(result.steps.map(step => `${step.from}→${step.to}`)).toEqual(['delivered→review', 'review→verified'])
  })

  it('resumes after the decision hop fails without writing review twice', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })
    const tool = tools.get('transition_task')!
    const input = { taskId: 't1', to: 'verified', idempotencyKey: 'partial-t1' }
    const trigger = new DatabaseSync(databasePath)
    try {
      // Let delivered→review commit, then abort the decision insert.
      trigger.exec(`CREATE TRIGGER fail_verified BEFORE INSERT ON task_events
        WHEN NEW.to_status = 'verified' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`)
    } finally {
      trigger.close()
    }

    await expect(tool.execute(input, run(SUPERVISOR))).rejects.toThrow()
    expect(countEvents(databasePath, 't1', 'review')).toBe(1)
    expect(countEvents(databasePath, 't1', 'verified')).toBe(0)

    const resume = new DatabaseSync(databasePath)
    try {
      resume.exec('DROP TRIGGER fail_verified')
    } finally {
      resume.close()
    }
    const retried = await tool.execute(input, run(SUPERVISOR)) as {
      status: string
      replayed: boolean
      steps: { from: string; to: string }[]
    }

    expect(retried).toMatchObject({ status: 'verified', replayed: false })
    expect(retried.steps.map(step => `${step.from}→${step.to}`)).toEqual(['review→verified'])
    expect(countEvents(databasePath, 't1', 'review')).toBe(1)
    expect(countEvents(databasePath, 't1', 'verified')).toBe(1)
  })
})

function seedEmployee(databasePath: string, input: {
  readonly sessionId: string
  readonly displayName: string
  readonly templateId?: string
  readonly personaNote?: string
  readonly provider?: string
  readonly model?: string
}): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare(`INSERT INTO employees (session_id, project_id, display_name, template_id, persona_note,
      preferred_provider_id, preferred_model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.sessionId, PROJECT, input.displayName, input.templateId ?? null, input.personaNote ?? null,
      input.provider ?? null, input.model ?? null, AT, AT,
    )
  } finally {
    db.close()
  }
}

describe('list_employees role detail (DF-002)', () => {
  it('returns description, template and preferred model', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    seedEmployee(databasePath, {
      sessionId: WORKER,
      displayName: '小明',
      templateId: 'cadre-roleplay',
      personaNote: '后端工程师，负责台账与状态机',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    const tool = tools.get('list_employees')
    expect(tool).toBeDefined()
    const value = await tool!.execute({}, run(SUPERVISOR)) as {
      employees: { sessionId: string; description?: string; templateId?: string; preferredProviderId?: string; preferredModel?: string }[]
    }
    const row = value.employees.find(employee => employee.sessionId === WORKER)
    expect(row).toMatchObject({
      description: '后端工程师，负责台账与状态机',
      templateId: 'cadre-roleplay',
      preferredProviderId: 'deepseek',
      preferredModel: 'deepseek-chat',
    })
    const rendered = tool!.output?.render({}, value) as { type: string; text: string }[]
    expect(rendered[0]?.text).toContain('后端工程师，负责台账与状态机')
    expect(rendered[0]?.text).toContain('cadre-roleplay')
    expect(rendered[0]?.text).toContain('deepseek/deepseek-chat')
  })

  it('keeps a roster-only worker visible and omits absent detail', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    const value = await tools.get('list_employees')!.execute({}, run(SUPERVISOR)) as {
      employees: { sessionId: string; description?: string; templateId?: string }[]
    }
    const row = value.employees.find(employee => employee.sessionId === WORKER)
    expect(row).toEqual({ sessionId: WORKER, name: '小明', state: 'active' })
  })
})

describe('rework notification (DF-005)', () => {
  it('queues the reason to the assignee once and reports delivery', async () => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })
    const tool = tools.get('transition_task')
    expect(tool).toBeDefined()
    const input = { taskId: 't1', to: 'rework', reason: '缺少证据：没有附测试输出', idempotencyKey: 'rework-t1' }

    const first = await tool!.execute(input, run(SUPERVISOR)) as { status: string; replayed: boolean; assigneeNotified?: boolean }
    expect(first).toMatchObject({ status: 'rework', replayed: false, assigneeNotified: true })
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as { sessionId: string; content: { type: string; text: string }[] }
    expect(prompt.sessionId).toBe(WORKER)
    expect(prompt.content[0]?.text).toContain('缺少证据：没有附测试输出')
    expect(prompt.content[0]?.text).toContain('report_task')

    const replay = await tool!.execute(input, run(SUPERVISOR)) as { replayed: boolean; assigneeNotified?: boolean }
    expect(replay.replayed).toBe(true)
    expect(replay.assigneeNotified).toBeUndefined()
    expect(prompts).toHaveLength(1)
  })

  it('keeps the transition when delivery fails and reports the failure', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath, { prompt: () => Promise.reject(new Error('session offline')) })
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })
    const tool = tools.get('transition_task')!

    const result = await tool.execute(
      { taskId: 't1', to: 'rework', reason: '再改一版', idempotencyKey: 'rework-fail' },
      run(SUPERVISOR),
    ) as { status: string; assigneeNotified?: boolean; notifyError?: string }

    expect(result.status).toBe('rework')
    expect(result.assigneeNotified).toBe(false)
    expect(result.notifyError).toContain('session offline')
    expect(countEvents(databasePath, 't1', 'rework')).toBe(1)
  })

  it('keeps the transition when the diagnostic log cannot be written', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath, { prompt: () => Promise.reject(new Error('session offline')) })
    seedRoster(databasePath)
    seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })
    // Force appendFileSync to fail: the plugin log path is a directory.
    const logPath = `${databasePath}.plugin.log`
    rmSync(logPath, { force: true })
    mkdirSync(logPath)

    const result = await tools.get('transition_task')!.execute(
      { taskId: 't1', to: 'rework', reason: '再改一版', idempotencyKey: 'rework-log-fail' },
      run(SUPERVISOR),
    ) as { status: string; assigneeNotified?: boolean; notifyError?: string }

    expect(result).toMatchObject({ status: 'rework', assigneeNotified: false })
    expect(result.notifyError).toContain('session offline')
    expect(countEvents(databasePath, 't1', 'rework')).toBe(1)
  })
})

describe('terminal task notification (P0-1)', () => {
  const cases = [
    { status: 'cancelled', reason: '需求撤回', header: '【任务取消】', snapshot: 'transition-notice-cancelled.txt' },
    { status: 'failed', reason: '构建失败', header: '【任务关闭】', snapshot: 'transition-notice-failed.txt' },
  ] as const

  for (const item of cases) {
    it(`queues ${item.header} to the assignee once for ${item.status}`, async () => {
      const databasePath = freshDatabase()
      const { tools, prompts } = mount(databasePath)
      seedRoster(databasePath)
      seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })
      const input = { taskId: 't1', to: item.status, reason: item.reason, idempotencyKey: `${item.status}-t1` }

      const first = await tools.get('transition_task')!.execute(input, run(SUPERVISOR)) as {
        status: string; replayed: boolean; assigneeNotified?: boolean
      }
      expect(first).toMatchObject({ status: item.status, replayed: false, assigneeNotified: true })
      expect(prompts).toHaveLength(1)
      const prompt = prompts[0] as { sessionId: string; mode: string; content: { type: string; text: string }[] }
      expect(prompt).toMatchObject({ sessionId: WORKER, mode: 'queue' })
      expect(prompt.content[0]?.text).toContain(item.header)
      await expect(`${prompt.content[0]?.text}\n`).toMatchFileSnapshot(`./expected/${item.snapshot}`)

      const replay = await tools.get('transition_task')!.execute(input, run(SUPERVISOR)) as {
        replayed: boolean; assigneeNotified?: boolean
      }
      expect(replay.replayed).toBe(true)
      expect(replay.assigneeNotified).toBeUndefined()
      expect(prompts).toHaveLength(1)
    })

    it(`keeps the ${item.status} transition when the notice fails`, async () => {
      const databasePath = freshDatabase()
      const { tools } = mount(databasePath, { prompt: () => Promise.reject(new Error('session offline')) })
      seedRoster(databasePath)
      seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER })

      const result = await tools.get('transition_task')!.execute(
        { taskId: 't1', to: item.status, reason: item.reason, idempotencyKey: `${item.status}-fail` },
        run(SUPERVISOR),
      ) as { status: string; assigneeNotified?: boolean; notifyError?: string }

      expect(result).toMatchObject({ status: item.status, assigneeNotified: false })
      expect(result.notifyError).toContain('session offline')
      expect(countEvents(databasePath, 't1', item.status)).toBe(1)
    })
  }
})

describe('terminal task report refusal (P0-1)', () => {
  const cases = [
    { status: 'verified', reason: '验收通过', snapshot: 'report-terminal-verified.txt' },
    { status: 'cancelled', reason: '需求撤回', snapshot: 'report-terminal-cancelled.txt' },
    { status: 'failed', reason: '构建失败', snapshot: 'report-terminal-failed.txt' },
  ] as const

  for (const item of cases) {
    it(`returns readable copy for a ${item.status} task`, async () => {
      const databasePath = freshDatabase()
      const { tools } = mount(databasePath)
      seedRoster(databasePath)
      seedTask(databasePath, { taskId: 't1', seq: 1, assignee: WORKER, status: item.status })
      seedTerminalEvent(databasePath, { taskId: 't1', status: item.status, reason: item.reason })

      const error = await tools.get('report_task')!.execute(
        { taskId: 't1', summary: '已完成', deliverables: ['out.txt'] },
        run(WORKER),
      ).then(() => undefined, (reason: unknown) => reason)

      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).not.toContain('INVALID_TRANSITION')
      expect(message).toContain('无需再回报')
      await expect(`${message}\n`).toMatchFileSnapshot(`./expected/${item.snapshot}`)
    })
  }
})

describe('dispatch_task input validation', () => {
  interface DispatchFailure { target: string; reason: string; retryable: boolean; pendingId?: string }
  interface DispatchResult {
    dispatched: {
      taskId: string; assigneeName: string; role: string; dueAt: string
      estimatedTokens: number; warnings: string[]
      overlaps?: { taskId: string; assignee: string; file: string }[]
    }[]
    failed: DispatchFailure[]
  }

  const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    employee: WORKER, title: '修好登录页', body: '登录按钮点了没反应，修好并补用例。', dueAt: AT, ...overrides,
  })

  const dispatch = async (
    tasks: readonly Record<string, unknown>[],
    sessionId = SUPERVISOR,
  ): Promise<{ databasePath: string; prompts: unknown[]; result: DispatchResult; tools: Mounted['tools'] }> => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)
    const result = await tools.get('dispatch_task')!.execute({ tasks }, run(sessionId)) as DispatchResult
    return { databasePath, prompts, result, tools }
  }

  it('reports a missing title as invalid input instead of a bind error', async () => {
    const { databasePath, prompts, result } = await dispatch([item({ title: undefined })])

    expect(result.dispatched).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.target).toBe(WORKER)
    expect(result.failed[0]?.reason).toContain('title')
    expect(result.failed[0]?.reason).toContain('必填')
    expect(result.failed[0]?.retryable).toBe(false)
    expect(result.failed[0]?.pendingId).toBeUndefined()
    // The whole chain of the defect: no SQL binding error, nothing written, no retry queued.
    expect(JSON.stringify(result)).not.toContain('parameter 5')
    expect(countTasks(databasePath)).toBe(0)
    expect(countPending(databasePath)).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  it.each([
    ['null', null],
    ['a boolean', true],
    ['an object', {}],
    ['blank text', '   '],
  ])('reports a title that is %s as invalid input', async (_label, title) => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute({ tasks: [item({ title })] }, run(SUPERVISOR)) as DispatchResult

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toContain('title')
    expect(result.failed[0]?.retryable).toBe(false)
    expect(countTasks(databasePath)).toBe(0)
    expect(countPending(databasePath)).toBe(0)
  })

  it('reports a missing body as invalid input', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute({ tasks: [item({ body: undefined })] }, run(SUPERVISOR)) as DispatchResult

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toContain('body')
    expect(result.failed[0]?.retryable).toBe(false)
    expect(countTasks(databasePath)).toBe(0)
  })

  it.each([
    ['null', null],
    ['a string', 'not-a-task'],
    ['a number', 7],
  ])('classifies %s as invalid_item without queueing it', async (_label, value) => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute({ tasks: [value] }, run(SUPERVISOR)) as DispatchResult

    expect(result.dispatched).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.target).toBe('(非对象条目)')
    expect(result.failed[0]?.reason).toContain('invalid_item')
    expect(result.failed[0]?.reason).toContain('对象')
    expect(result.failed[0]?.reason).not.toContain('任务台账写入失败')
    expect(result.failed[0]?.retryable).toBe(false)
    expect(result.failed[0]?.pendingId).toBeUndefined()
    expect(countTasks(databasePath)).toBe(0)
    expect(countPending(databasePath)).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  it('keeps dispatching valid objects when a batch contains non-object entries', async () => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)
    const tasks: unknown[] = [null, item(), 7, item({ employee: WORKER_2 })]

    const result = await tools.get('dispatch_task')!.execute({ tasks }, run(SUPERVISOR)) as DispatchResult

    expect(result.dispatched).toHaveLength(2)
    expect(result.failed).toHaveLength(2)
    for (const row of result.failed) {
      expect(row.reason).toContain('invalid_item')
      expect(row.retryable).toBe(false)
      expect(row.pendingId).toBeUndefined()
    }
    expect(countTasks(databasePath)).toBe(2)
    expect(countPending(databasePath)).toBe(0)
    expect(prompts).toHaveLength(2)
  })

  it('keeps dispatching the rest of a batch when the second of five tasks is invalid', async () => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)
    const titles = ['一', '二', '三', '四', '五']
    const tasks = titles.map(label => item({ title: `任务${label}` }))
    tasks[1] = item({ title: undefined })

    const result = await tools.get('dispatch_task')!.execute({ tasks }, run(SUPERVISOR)) as DispatchResult

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toContain('title')
    expect(result.dispatched).toHaveLength(4)
    expect(new Set(result.dispatched.map(entry => entry.taskId)).size).toBe(4)
    // Attempted, not silently dropped: the three tasks after the bad one all reached the ledger and the assignee.
    expect(countTasks(databasePath)).toBe(4)
    expect(prompts).toHaveLength(4)
  })

  it('labels an unknown employee as a retryable dispatch rather than invalid input', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute({ tasks: [item({ employee: 'ghost' })] }, run(SUPERVISOR)) as DispatchResult

    expect(result.dispatched).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.retryable).toBe(true)
    expect(result.failed[0]?.pendingId).toBeDefined()
    expect(result.failed[0]?.reason).toContain('待派：')
    const entry = pendingEntry(databasePath)
    expect(entry).toMatchObject({ employee: 'ghost', title: '修好登录页', retryable: 1, status: 'pending' })
    expect(entry?.reason).toContain('没有找到员工')
    expect(countTasks(databasePath)).toBe(0)
  })

  it('retries queued work once the employee joins the project', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    const retry = tools.get('retry_dispatch')!

    await tools.get('dispatch_task')!.execute({ tasks: [item({ employee: 'ghost' })] }, run(SUPERVISOR))
    const pendingId = pendingEntry(databasePath)!.pendingId

    const stillMissing = await retry.execute({ pendingId }, run(SUPERVISOR)) as { dispatched: unknown[]; failed: DispatchFailure[] }
    expect(stillMissing.dispatched).toEqual([])
    expect(stillMissing.failed[0]?.retryable).toBe(true)
    expect(pendingEntry(databasePath)?.status).toBe('pending')

    addMember(databasePath, 'ghost', 'worker', '小刚')
    const settled = await retry.execute({ pendingId }, run(SUPERVISOR)) as
      { dispatched: { taskId: string; dueAt: string }[]; failed: DispatchFailure[] }
    expect(settled.failed).toEqual([])
    expect(settled.dispatched).toHaveLength(1)
    // The queued spec is replayed verbatim, not rebuilt from a prompt.
    expect(settled.dispatched[0]?.dueAt).toBe(AT)
    expect(countTasks(databasePath)).toBe(1)
  })

  it('never queues an invalid task for retry', async () => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)

    await tools.get('dispatch_task')!.execute({ tasks: [item({ title: '' })] }, run(SUPERVISOR))

    expect(countPending(databasePath)).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  it('falls back to the task title when the packet omits a goal', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute(
      { tasks: [item({ packet: { acceptance: [] } })] },
      run(SUPERVISOR),
    ) as DispatchResult

    expect(result.failed).toEqual([])
    expect(result.dispatched).toHaveLength(1)
    expect(countTasks(databasePath)).toBe(1)
  })

  it('reports blank fields before a packet normalizer could throw', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)

    const result = await tools.get('dispatch_task')!.execute(
      { tasks: [item({ title: '  ', body: '  ', packet: { goal: '  ' } })] },
      run(SUPERVISOR),
    ) as DispatchResult

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toContain('title')
    expect(result.failed[0]?.reason).toContain('body')
    expect(result.failed[0]?.reason).not.toContain('TaskPacket.goal')
    expect(result.failed[0]?.retryable).toBe(false)
    expect(countTasks(databasePath)).toBe(0)
  })

  it('classifies a storage failure apart from input errors and keeps going', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    const db = new DatabaseSync(databasePath)
    db.exec(`CREATE TRIGGER dispatch_disk_full BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
    db.close()
    const tasks = [item({ title: '会被存储拒绝' }), item({ title: '' })]

    const result = await tools.get('dispatch_task')!.execute({ tasks }, run(SUPERVISOR)) as DispatchResult

    expect(result.dispatched).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]?.reason).toContain('任务台账写入失败')
    expect(result.failed[0]?.reason).toContain('disk is full')
    expect(result.failed[0]?.retryable).toBe(true)
    expect(result.failed[1]?.reason).toContain('title')
    expect(result.failed[1]?.retryable).toBe(false)
    // The storage failure is queued for retry with the original fields intact.
    expect(pendingEntry(databasePath)?.title).toBe('会被存储拒绝')
  })

  it('reports a shared file on the second task without rejecting either dispatch', async () => {
    const { databasePath, prompts, result, tools } = await dispatch([
      item({ packet: { fileRefs: [{ path: 'src/shared.ts' }] } }),
      item({ employee: WORKER_2, packet: { fileRefs: [{ path: 'src/shared.ts' }] } }),
    ])

    expect(result.failed).toEqual([])
    expect(result.dispatched).toHaveLength(2)
    const [first, second] = result.dispatched
    expect('overlaps' in first!).toBe(false)
    expect(second?.overlaps).toEqual([{ taskId: first!.taskId, assignee: WORKER, file: 'src/shared.ts' }])
    // Still dispatched to both people: the notice is advisory, not a rejection.
    expect(countTasks(databasePath)).toBe(2)
    expect(prompts).toHaveLength(2)

    const rendered = (tools.get('dispatch_task')!.output!.render({}, result) as { text?: string }[])
      .map(block => block.text ?? '').join('\n')
    await expect(`${rendered.replaceAll(first!.taskId, '<task-1>').replaceAll(second!.taskId, '<task-2>')}\n`)
      .toMatchFileSnapshot('./expected/dispatch-file-overlap.txt')
  })

  it('omits overlaps when the file sets do not intersect', async () => {
    const { result } = await dispatch([
      item({ packet: { fileRefs: [{ path: 'src/left.ts' }] } }),
      item({ employee: WORKER_2, packet: { fileRefs: [{ path: 'src/right.ts' }] } }),
    ])

    expect(result.dispatched).toHaveLength(2)
    expect(result.dispatched[1]?.overlaps).toBeUndefined()
    expect('overlaps' in result.dispatched[1]!).toBe(false)
  })

  it('persists the task fileRefs so a later dispatch call still sees the overlap', async () => {
    const databasePath = freshDatabase()
    const { tools, prompts } = mount(databasePath)
    seedRoster(databasePath)
    const execute = (tasks: readonly Record<string, unknown>[]): Promise<DispatchResult> =>
      tools.get('dispatch_task')!.execute({ tasks }, run(SUPERVISOR)) as Promise<DispatchResult>

    const first = await execute([item({ packet: { fileRefs: [{ path: 'src/shared.ts' }] } })])
    const second = await execute([item({ employee: WORKER_2, packet: { fileRefs: [{ path: 'src/shared.ts' }] } })])

    expect(second.dispatched[0]?.overlaps).toEqual([
      { taskId: first.dispatched[0]!.taskId, assignee: WORKER, file: 'src/shared.ts' },
    ])
    const db = new DatabaseSync(databasePath)
    try {
      const persisted = db.prepare('SELECT file_refs FROM tasks WHERE task_id = ?')
        .get(first.dispatched[0]!.taskId) as { file_refs?: string }
      expect(JSON.parse(persisted.file_refs!)).toEqual([{ path: 'src/shared.ts' }])
    } finally {
      db.close()
    }
    expect(prompts).toHaveLength(2)
  })

  it('ignores a closed task when reporting open-file overlaps', async () => {
    const databasePath = freshDatabase()
    const { tools } = mount(databasePath)
    seedRoster(databasePath)
    const execute = (tasks: readonly Record<string, unknown>[]): Promise<DispatchResult> =>
      tools.get('dispatch_task')!.execute({ tasks }, run(SUPERVISOR)) as Promise<DispatchResult>

    const first = await execute([item({ packet: { fileRefs: [{ path: 'src/shared.ts' }] } })])
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("UPDATE tasks SET status = 'verified' WHERE task_id = ?").run(first.dispatched[0]!.taskId)
    } finally {
      db.close()
    }
    const second = await execute([item({ employee: WORKER_2, packet: { fileRefs: [{ path: 'src/shared.ts' }] } })])

    expect(second.dispatched[0]?.overlaps).toBeUndefined()
  })

  it('adds file_refs to an existing tasks table', () => {
    const databasePath = freshDatabase()
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY)')
    } finally {
      db.close()
    }
    mount(databasePath)
    const reader = new DatabaseSync(databasePath)
    try {
      const columns = reader.prepare('PRAGMA table_info(tasks)').all() as { name?: string }[]
      expect(columns.some(column => column.name === 'file_refs')).toBe(true)
    } finally {
      reader.close()
    }
  })
})

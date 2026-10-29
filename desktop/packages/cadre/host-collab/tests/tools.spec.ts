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

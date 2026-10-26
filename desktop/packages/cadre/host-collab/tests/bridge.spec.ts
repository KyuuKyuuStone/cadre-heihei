import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteCollabStore } from '../../../../../app/src/collab/dispatch/sqlite-dispatch.ts'
import { listTasks, transitionTask } from '../../../../cadre-collab/host-entry.ts'

const PROJECT = 'p1'
const SUPERVISOR = 'sup'
const WORKER = 'w1'
const WORKER_2 = 'w2'

const roots: string[] = []

function freshDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-host-bridge-'))
  roots.push(root)
  return join(root, 'cadre.sqlite')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Seeded {
  readonly store: SqliteCollabStore
}

function seed(databasePath: string, options: { readonly due?: boolean } = {}): Seeded {
  const store = new SqliteCollabStore({ databasePath })
  store.addMember({ projectId: PROJECT as never, sessionId: SUPERVISOR as never, role: 'supervisor', state: 'active', displayName: '主管' })
  store.addMember({ projectId: PROJECT as never, sessionId: WORKER as never, role: 'worker', state: 'active', displayName: '小明' })
  store.addMember({ projectId: PROJECT as never, sessionId: WORKER_2 as never, role: 'worker', state: 'active', displayName: '小红' })
  if (options.due === true) store.ledger.core.db.exec('ALTER TABLE tasks ADD COLUMN due_at TEXT')
  return { store }
}

function createTask(store: SqliteCollabStore, taskId: string, assignee = WORKER): void {
  const created = store.ledger.createTask({
    projectId: PROJECT as never,
    taskId: taskId as never,
    title: `标题 ${taskId}`,
    body: `  正文 ${taskId}\n第二行  `,
    dispatcherSessionId: SUPERVISOR as never,
    assigneeSessionId: assignee as never,
    idempotencyKey: `create:${taskId}` as never,
  })
  if (!created.ok) throw new Error(created.error.message)
}

function advance(store: SqliteCollabStore, taskId: string, chain: readonly string[], sessionId = WORKER): void {
  let from = store.ledger.getTask(PROJECT as never, taskId as never)
  if (!from.ok) throw new Error(from.error.message)
  for (const to of chain) {
    const step = store.ledger.transition({
      projectId: PROJECT as never,
      taskId: taskId as never,
      from: from.value.status as never,
      to: to as never,
      actor: { kind: 'session', sessionId: sessionId as never, role: 'assignee' },
      idempotencyKey: `seed:${taskId}:${to}` as never,
    })
    if (!step.ok) throw new Error(`${from.value.status} → ${to}: ${step.error.message}`)
    from = { ok: true, value: step.value.task }
  }
}

function deliveredTask(databasePath: string, taskId = 't1'): void {
  const { store } = seed(databasePath)
  try {
    createTask(store, taskId)
    advance(store, taskId, ['accepted', 'in_progress', 'delivered'])
  } finally {
    store.close()
  }
}

function eventRows(databasePath: string, taskId: string): { from_status: string | null; to_status: string; reason: string | null }[] {
  const store = new SqliteCollabStore({ databasePath })
  try {
    return store.ledger.core.db
      .prepare('SELECT from_status, to_status, reason FROM task_events WHERE task_id = ? ORDER BY rowid ASC')
      .all(taskId) as { from_status: string | null; to_status: string; reason: string | null }[]
  } finally {
    store.close()
  }
}

describe('listTasks bridge', () => {
  it('returns newest-first rows with due_at when the column exists', () => {
    const databasePath = freshDatabase()
    const { store } = seed(databasePath, { due: true })
    try {
      createTask(store, 't1')
      createTask(store, 't2', WORKER_2)
      store.ledger.core.db.prepare('UPDATE tasks SET due_at = ? WHERE task_id = ?')
        .run('2026-11-01T00:00:00.000Z', 't1')
    } finally {
      store.close()
    }

    const result = listTasks({ databasePath, projectId: PROJECT })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map(row => row.taskId)).toEqual(['t2', 't1'])
    expect(result.rows[1]).toMatchObject({
      taskId: 't1',
      status: 'dispatched',
      assigneeSessionId: WORKER,
      dueAt: '2026-11-01T00:00:00.000Z',
      bodyPreview: '正文 t1 第二行',
    })
    expect(result.rows[0]?.dueAt).toBeUndefined()
  })

  it('reads rows on a ledger that predates due_at', () => {
    const databasePath = freshDatabase()
    const { store } = seed(databasePath)
    try {
      createTask(store, 't1')
    } finally {
      store.close()
    }

    const result = listTasks({ databasePath, projectId: PROJECT })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rows).toHaveLength(1)
  })
})

describe('transitionTask bridge', () => {
  it('accepts delivered → review → verified and replays without new events', () => {
    const databasePath = freshDatabase()
    deliveredTask(databasePath)
    const input = {
      databasePath,
      projectId: PROJECT,
      taskId: 't1',
      to: 'verified',
      actorSessionId: SUPERVISOR,
      idempotencyKey: 'accept:t1',
    }

    const first = transitionTask(input)
    expect(first).toMatchObject({ ok: true, from: 'delivered', status: 'verified', replayed: false })
    if (first.ok) expect(first.steps.map(step => `${step.from}→${step.to}`)).toEqual(['delivered→review', 'review→verified'])
    const afterFirst = eventRows(databasePath, 't1')
    expect(afterFirst.slice(-2).map(row => [row.from_status, row.to_status]))
      .toEqual([['delivered', 'review'], ['review', 'verified']])

    const replay = transitionTask(input)
    expect(replay).toMatchObject({ ok: true, replayed: true, status: 'verified' })
    if (replay.ok) expect(replay.steps).toEqual([])

    // A model retry may omit the original key; reaching the same status must
    // still be a no-op rather than a second verified event.
    const freshKey = transitionTask({ ...input, idempotencyKey: 'accept:t1:retry' })
    expect(freshKey).toMatchObject({ ok: true, replayed: true, status: 'verified' })
    expect(eventRows(databasePath, 't1')).toHaveLength(afterFirst.length)
  })

  it('rejects a worker even when the tool gate is bypassed', () => {
    const databasePath = freshDatabase()
    deliveredTask(databasePath)

    const result = transitionTask({
      databasePath,
      projectId: PROJECT,
      taskId: 't1',
      to: 'verified',
      actorSessionId: WORKER,
      idempotencyKey: 'worker:accept:t1',
    })

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })
    expect(eventRows(databasePath, 't1').at(-1)?.to_status).toBe('delivered')
  })

  it('requires a reason for rework and records review first', () => {
    const databasePath = freshDatabase()
    deliveredTask(databasePath)
    const base = {
      databasePath,
      projectId: PROJECT,
      taskId: 't1',
      to: 'rework',
      actorSessionId: SUPERVISOR,
    }

    expect(transitionTask({ ...base, idempotencyKey: 'rework:no-reason' }))
      .toMatchObject({ ok: false, code: 'MISSING_REASON' })

    const result = transitionTask({ ...base, reason: '截图缺失', idempotencyKey: 'rework:t1' })
    expect(result).toMatchObject({ ok: true, from: 'delivered', status: 'rework' })
    if (result.ok) expect(result.steps).toHaveLength(2)
    const rows = eventRows(databasePath, 't1')
    expect(rows.at(-2)).toMatchObject({ from_status: 'delivered', to_status: 'review' })
    expect(rows.at(-1)).toMatchObject({ from_status: 'review', to_status: 'rework', reason: '截图缺失' })
  })

  it('cancels from delivered without a review hop', () => {
    const databasePath = freshDatabase()
    deliveredTask(databasePath)

    const result = transitionTask({
      databasePath,
      projectId: PROJECT,
      taskId: 't1',
      to: 'cancelled',
      reason: '需求撤回',
      actorSessionId: SUPERVISOR,
      idempotencyKey: 'cancel:t1',
    })

    expect(result).toMatchObject({ ok: true, from: 'delivered', status: 'cancelled' })
    if (result.ok) expect(result.steps.map(step => step.to)).toEqual(['cancelled'])
  })

  it('rejects a target the state machine cannot reach from the current status', () => {
    const databasePath = freshDatabase()
    const { store } = seed(databasePath)
    try {
      createTask(store, 't1')
    } finally {
      store.close()
    }

    const result = transitionTask({
      databasePath,
      projectId: PROJECT,
      taskId: 't1',
      to: 'verified',
      actorSessionId: SUPERVISOR,
      idempotencyKey: 'too-early:t1',
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' })
  })
})

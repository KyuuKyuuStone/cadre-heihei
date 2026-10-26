/**
 * Actor trust tests for the write path.
 *
 * The actor kind must come from the roster (`members`), never from the process
 * environment or a caller-supplied role. A forged supervisor claim therefore
 * fails even when `CADRE_ROLE=supervisor` is set, and every recorded transition
 * carries its `from_status`.
 *
 * Run: node --test desktop/cadre-collab/actor.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { initCadreStore, openCadreCollab } from './entry.ts'
import { advanceReportToDelivered } from './host-entry.ts'

const PROJECT = 'proj-actor'
const SUPERVISOR = 'sup-A'
const WORKER = 'worker-A'

interface Fixture {
  readonly db: string
  readonly close: () => void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-actor-'))
  const db = join(dir, 'cadre.sqlite')
  initCadreStore(db)
  const raw = new DatabaseSync(db)
  const now = new Date().toISOString()
  const member = raw.prepare(`INSERT INTO members
    (project_id, session_id, role, display_name, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'available', ?, ?)`)
  member.run(PROJECT, SUPERVISOR, 'supervisor', SUPERVISOR, now, now)
  member.run(PROJECT, WORKER, 'worker', WORKER, now, now)
  raw.close()
  return {
    db,
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function insertTask(db: string, input: {
  taskId: string
  status: string
  seq: number
  assignee?: string
}): void {
  const raw = new DatabaseSync(db)
  const now = new Date().toISOString()
  raw.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256,
    status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
    VALUES (?, ?, ?, '测试任务', '完成条件', 12, 'sha', ?, ?, ?, ?, ?)`).run(
    input.taskId, PROJECT, input.seq, input.status, SUPERVISOR, input.assignee ?? WORKER, now, now)
  raw.close()
}

function events(db: string, taskId: string): { from_status: string | null; to_status: string; actor_session_id: string }[] {
  const raw = new DatabaseSync(db)
  try {
    return raw.prepare(`SELECT from_status, to_status, actor_session_id
      FROM task_events WHERE task_id = ? ORDER BY rowid ASC`).all(taskId) as
      { from_status: string | null; to_status: string; actor_session_id: string }[]
  } finally {
    raw.close()
  }
}

test('环境变量不能把员工提升为主管：验收仍被拒', () => {
  const previous = process.env.CADRE_ROLE
  process.env.CADRE_ROLE = 'supervisor'
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-env', status: 'delivered', seq: 1 })
    const collab = openCadreCollab({ databasePath: setup.db, projectId: PROJECT, sessionId: WORKER })
    assert.ok(collab !== undefined)
    const result = collab.transition({ taskId: 'task-env', to: 'verified' }) as
      { ok: boolean; error?: { code: string; message: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'FORBIDDEN_ACTOR')
    collab.close()
    assert.deepEqual(events(setup.db, 'task-env'), [])
  } finally {
    process.env.CADRE_ROLE = previous
    setup.close()
  }
})

test('不在花名册的会话无法伪造 actor', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-stranger', status: 'delivered', seq: 1 })
    const collab = openCadreCollab({ databasePath: setup.db, projectId: PROJECT, sessionId: 'stranger' })
    assert.ok(collab !== undefined)
    const result = collab.transition({ taskId: 'task-stranger', to: 'verified' }) as
      { ok: boolean; error?: { code: string; reasonCategory?: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'FORBIDDEN_ACTOR')
    assert.equal(result.error?.reasonCategory, 'not-member')
    collab.close()
  } finally {
    setup.close()
  }
})

test('主管验收记录真实 from_status（delivered → review → verified）', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-ok', status: 'delivered', seq: 1 })
    const collab = openCadreCollab({ databasePath: setup.db, projectId: PROJECT, sessionId: SUPERVISOR })
    assert.ok(collab !== undefined)
    const result = collab.transition({ taskId: 'task-ok', to: 'verified', reason: '交付物齐全' }) as { ok: boolean }
    assert.equal(result.ok, true)
    collab.close()
    assert.deepEqual(events(setup.db, 'task-ok').map(row => [row.from_status, row.to_status]), [
      ['delivered', 'review'],
      ['review', 'verified'],
    ])
  } finally {
    setup.close()
  }
})

test('员工汇报走状态机：每一跳都记录 from_status', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-report', status: 'dispatched', seq: 1 })
    const result = advanceReportToDelivered({
      databasePath: setup.db,
      projectId: PROJECT,
      taskId: 'task-report',
      actorSessionId: WORKER,
      idempotencyBase: 'report:task-report',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.eventIds.length, 3)
    assert.deepEqual(events(setup.db, 'task-report').map(row => [row.from_status, row.to_status]), [
      ['dispatched', 'accepted'],
      ['accepted', 'in_progress'],
      ['in_progress', 'delivered'],
    ])
    assert.ok(events(setup.db, 'task-report').every(row => row.actor_session_id === WORKER))
  } finally {
    setup.close()
  }
})

test('汇报人只能是自己：他人身份代替汇报被状态机拒绝', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-forge', status: 'dispatched', seq: 1 })
    const result = advanceReportToDelivered({
      databasePath: setup.db,
      projectId: PROJECT,
      taskId: 'task-forge',
      actorSessionId: SUPERVISOR,
      idempotencyBase: 'report:task-forge',
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'FORBIDDEN_ACTOR')
    assert.deepEqual(events(setup.db, 'task-forge'), [])
  } finally {
    setup.close()
  }
})

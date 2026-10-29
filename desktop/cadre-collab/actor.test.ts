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

test('rework 后再次汇报不复用上一轮幂等键', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-rework-report', status: 'rework', seq: 1 })
    const raw = new DatabaseSync(setup.db)
    try {
      // A prior delivery cycle already recorded this unscoped key.
      raw.prepare(`INSERT INTO task_events (event_id, project_id, task_id, from_status, to_status,
        actor_session_id, reason, idempotency_key, at)
        VALUES (?, ?, ?, 'in_progress', 'delivered', ?, NULL, ?, ?)`).run(
        'legacy-event', PROJECT, 'task-rework-report', WORKER,
        'report:task-rework-report:delivered', new Date().toISOString(),
      )
    } finally {
      raw.close()
    }
    const second = advanceReportToDelivered({
      databasePath: setup.db,
      projectId: PROJECT,
      taskId: 'task-rework-report',
      actorSessionId: WORKER,
      idempotencyBase: 'report:task-rework-report',
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.deepEqual(events(setup.db, 'task-rework-report').map(row => [row.from_status, row.to_status]).slice(-2), [
      ['rework', 'in_progress'],
      ['in_progress', 'delivered'],
    ])
  } finally {
    setup.close()
  }
})

test('rework 后二次汇报真的落库，不是 replay', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-m1', status: 'in_progress', seq: 1 })
    const base = 'report:task-m1'
    const first = advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-m1',
      actorSessionId: WORKER, idempotencyBase: base,
    })
    assert.equal(first.ok, true)

    const rework = (): void => {
      const collab = openCadreCollab({ databasePath: setup.db, projectId: PROJECT, sessionId: SUPERVISOR })
      try {
        assert.equal((collab.transition({ taskId: 'task-m1', to: 'review' }) as { ok?: boolean }).ok, true)
        assert.equal((collab.transition({ taskId: 'task-m1', to: 'rework', reason: '返修' }) as { ok?: boolean }).ok, true)
      } finally {
        collab.close()
      }
    }

    rework()
    const afterFirstRework = events(setup.db, 'task-m1').length
    assert.equal(advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-m1',
      actorSessionId: WORKER, idempotencyBase: base,
    }).ok, true)

    // A second rework round must not collide with the first round's keys.
    rework()
    const beforeSecond = events(setup.db, 'task-m1').length
    const second = advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-m1',
      actorSessionId: WORKER, idempotencyBase: base,
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.replayed, false)
    assert.equal(second.eventIds.length, 2)
    assert.equal(events(setup.db, 'task-m1').length, beforeSecond + 2)
    const reader = new DatabaseSync(setup.db, { readOnly: true })
    try {
      const status = reader.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-m1') as { status: string }
      assert.equal(status.status, 'delivered')
    } finally {
      reader.close()
    }
    assert.ok(events(setup.db, 'task-m1').length > afterFirstRework)

    // A real duplicate of the completed report still replays without new rows.
    const retry = advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-m1',
      actorSessionId: WORKER, idempotencyBase: base,
    })
    assert.equal(retry.ok, true)
    if (retry.ok) assert.equal(retry.replayed, true)
    assert.equal(events(setup.db, 'task-m1').length, beforeSecond + 2)
  } finally {
    setup.close()
  }
})

test('rework 轮步1成功后步2失败，重试仍用本轮 cycleId 落库', () => {
  const setup = fixture()
  try {
    insertTask(setup.db, { taskId: 'task-mid', status: 'in_progress', seq: 1 })
    const base = 'report:task-mid'
    assert.equal(advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-mid',
      actorSessionId: WORKER, idempotencyBase: base,
    }).ok, true)
    const collab = openCadreCollab({ databasePath: setup.db, projectId: PROJECT, sessionId: SUPERVISOR })
    try {
      assert.equal((collab.transition({ taskId: 'task-mid', to: 'review' }) as { ok?: boolean }).ok, true)
      assert.equal((collab.transition({ taskId: 'task-mid', to: 'rework', reason: '返修' }) as { ok?: boolean }).ok, true)
    } finally {
      collab.close()
    }

    const raw = new DatabaseSync(setup.db)
    let reworkEventId = ''
    try {
      const row = raw.prepare(`SELECT event_id FROM task_events WHERE task_id = ?
        AND to_status = 'rework' ORDER BY at DESC, rowid DESC LIMIT 1`).get('task-mid') as { event_id: string }
      reworkEventId = row.event_id
      raw.exec(`CREATE TRIGGER fail_delivered BEFORE INSERT ON task_events
        WHEN NEW.to_status = 'delivered'
        BEGIN SELECT RAISE(ABORT, 'simulated step2 failure'); END`)
    } finally {
      raw.close()
    }

    let failed: ReturnType<typeof advanceReportToDelivered> | undefined
    try {
      failed = advanceReportToDelivered({
        databasePath: setup.db, projectId: PROJECT, taskId: 'task-mid',
        actorSessionId: WORKER, idempotencyBase: base,
      })
    } catch {
      failed = undefined
    }
    assert.equal(failed === undefined || failed.ok === false, true)
    const cleanup = new DatabaseSync(setup.db)
    try {
      cleanup.exec('DROP TRIGGER fail_delivered')
    } finally {
      cleanup.close()
    }
    const afterFailure = new DatabaseSync(setup.db, { readOnly: true })
    try {
      assert.equal((afterFailure.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-mid') as { status: string }).status, 'in_progress')
    } finally {
      afterFailure.close()
    }

    const retry = advanceReportToDelivered({
      databasePath: setup.db, projectId: PROJECT, taskId: 'task-mid',
      actorSessionId: WORKER, idempotencyBase: base,
    })
    assert.equal(retry.ok, true)
    if (!retry.ok) return
    assert.equal(retry.replayed, false)
    assert.equal(retry.eventIds.length, 1) // step 1 replayed; step 2 wrote after the failure
    const reader = new DatabaseSync(setup.db, { readOnly: true })
    try {
      assert.equal((reader.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-mid') as { status: string }).status, 'delivered')
      const keys = reader.prepare(`SELECT idempotency_key FROM task_events
        WHERE task_id = ? AND to_status = 'in_progress' AND idempotency_key LIKE ?`).all('task-mid', `%${reworkEventId}%`)
      assert.equal(keys.length, 1)
    } finally {
      reader.close()
    }
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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { initCadreStore, reassignOpenTask } from '../../../../cadre-collab/entry.ts'

const PROJECT = 'p-reassign'
const SUP = 'sup-r'
const FROM = 'w-from'
const TO = 'w-to'
const AT = '2026-10-29T08:00:00.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'df014-reassign-'))
  roots.push(root)
  const path = join(root, 'cadre.sqlite')
  initCadreStore(path)
  const db = new DatabaseSync(path)
  try {
    const member = db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'available', ?, ?)`)
    member.run(PROJECT, SUP, 'supervisor', '主管', AT, AT)
    member.run(PROJECT, FROM, 'worker', '甲', AT, AT)
    member.run(PROJECT, TO, 'worker', '乙', AT, AT)
    db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes, body_sha256,
      status, dispatcher_session_id, assignee_session_id, created_at, updated_at, version)
      VALUES ('t1', ?, 1, '任务', 'body', 4, 'sha', 'in_progress', ?, ?, ?, ?, 2)`).run(PROJECT, SUP, FROM, AT, AT)
  } finally {
    db.close()
  }
  return path
}

describe('reassignOpenTask (DF-014)', () => {
  it('moves the assignee without changing status and records one event', () => {
    const path = seed()
    const first = reassignOpenTask({
      databasePath: path, projectId: PROJECT, taskId: 't1', actorSessionId: SUP,
      toSessionId: TO, reason: '原员工停摆', idempotencyKey: 'r1',
    })
    expect(first).toEqual({ ok: true, version: 3, replayed: false })

    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare('SELECT assignee_session_id, status FROM tasks WHERE task_id = ?').get('t1'))
        .toEqual({ assignee_session_id: TO, status: 'in_progress' })
      const events = db.prepare(`SELECT from_status, to_status, actor_session_id, reason, idempotency_key
        FROM task_events WHERE task_id = ?`).all('t1')
      expect(events).toEqual([{
        from_status: 'in_progress', to_status: 'in_progress', actor_session_id: SUP,
        reason: 'stalled-reassign: 原员工停摆', idempotency_key: 'stall-reassign:t1:r1',
      }])
    } finally {
      db.close()
    }
  })

  it('replays the same idempotency key without a second reassignment', () => {
    const path = seed()
    const request = {
      databasePath: path, projectId: PROJECT, taskId: 't1', actorSessionId: SUP,
      toSessionId: TO, reason: '停摆', idempotencyKey: 'same',
    }
    expect(reassignOpenTask(request)).toMatchObject({ ok: true, replayed: false })
    expect(reassignOpenTask(request)).toMatchObject({ ok: true, replayed: true })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get('t1')).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('rejects a non-supervisor actor and an invalid target', () => {
    const path = seed()
    expect(reassignOpenTask({
      databasePath: path, projectId: PROJECT, taskId: 't1', actorSessionId: FROM,
      toSessionId: TO, reason: 'x', idempotencyKey: 'k1',
    })).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })
    expect(reassignOpenTask({
      databasePath: path, projectId: PROJECT, taskId: 't1', actorSessionId: SUP,
      toSessionId: 'stranger', reason: 'x', idempotencyKey: 'k2',
    })).toMatchObject({ ok: false, code: 'REASSIGN_TARGET_INVALID' })
  })
})

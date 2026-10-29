import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openTasksOf,
  parseRetireMemberOptions,
  resolveRetireActor,
  retireMemberWithDisposition,
  type RetireMemberDeps,
} from '../src/cadre-retire.ts'
import type { CadreMemberRow, CadreTaskRow } from '../src/cadre-ledger.ts'
import { initCadreStore, returnOpenTasksToSupervisor } from '../../../cadre-collab/entry.ts'

const PROJECT = 'proj-retire'
const SUPERVISOR = 'sup-retire'
const WORKER = 'worker-retire'
const AT = '2026-10-28T00:00:00.000Z'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function member(sessionId: string, role: string, state = 'available'): CadreMemberRow {
  return { sessionId, role, displayName: sessionId, state, updatedAt: AT }
}

function task(taskId: string, status: string, assigneeSessionId = WORKER): CadreTaskRow {
  return { taskId, title: `任务 ${taskId}`, status, assigneeSessionId, updatedAt: AT }
}

interface Harness {
  readonly deps: RetireMemberDeps
  readonly transitions: { taskId: string; to: string; from?: string; reason?: string }[]
  readonly returns: unknown[]
  readonly retired: string[]
  readonly openedWith: string[]
}

function harness(options: {
  readonly members?: readonly CadreMemberRow[]
  readonly tasks?: readonly CadreTaskRow[]
  readonly transitionOk?: boolean
  readonly returnOk?: boolean
  readonly retireOk?: boolean
} = {}): Harness {
  const transitions: Harness['transitions'] = []
  const returns: unknown[] = []
  const retired: string[] = []
  const openedWith: string[] = []
  const deps: RetireMemberDeps = {
    listMembers: () => options.members ?? [member(SUPERVISOR, 'supervisor'), member(WORKER, 'worker')],
    listTasks: () => options.tasks ?? [],
    openCollab: (_projectId, sessionId) => {
      openedWith.push(sessionId)
      return {
        databasePath: ':memory:',
        dispatch: () => undefined,
        listTasks: () => ({ projectId: PROJECT, rows: options.tasks ?? [] }),
        close: () => undefined,
        transition: (input) => {
          transitions.push({ taskId: input.taskId, to: input.to, ...(input.from === undefined ? {} : { from: input.from }), ...(input.reason === undefined ? {} : { reason: input.reason }) })
          return options.transitionOk === false
            ? { ok: false, error: { code: 'INVALID_TRANSITION', message: 'blocked' } }
            : { ok: true }
        },
      }
    },
    returnTasks: (input) => {
      returns.push(input)
      return options.returnOk === false
        ? { ok: false, code: 'INVALID_TRANSITION', message: 'blocked' }
        : { ok: true, returned: input.taskIds.length, replayed: 0 }
    },
    retire: (sessionId) => {
      retired.push(sessionId)
      return options.retireOk === false
        ? { ok: false, code: 'STORAGE_ERROR', message: 'boom' }
        : { ok: true, retired: true }
    },
  }
  return { deps, transitions, returns, retired, openedWith }
}

describe('retireMemberWithDisposition', () => {
  it('refuses with OPEN_TASKS and the task list when no disposition is given', () => {
    const h = harness({ tasks: [task('t1', 'in_progress'), task('t2', 'delivered')] })
    const result = retireMemberWithDisposition(h.deps, { sessionId: WORKER, projectId: PROJECT })
    expect(result).toMatchObject({ ok: false, code: 'OPEN_TASKS' })
    if (result.ok) return
    expect(result.tasks?.map(row => row.taskId)).toEqual(['t1', 't2'])
    expect(h.retired).toEqual([])
  })

  it('retires without a disposition when there is no open task', () => {
    const h = harness({ tasks: [task('t1', 'verified')] })
    expect(retireMemberWithDisposition(h.deps, { sessionId: WORKER, projectId: PROJECT }))
      .toEqual({ ok: true, retired: true })
    expect(h.retired).toEqual([WORKER])
  })

  it('cancels every open task through the state machine before retiring', () => {
    const h = harness({ tasks: [task('t1', 'in_progress'), task('t2', 'rework')] })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'cancel',
    })
    expect(result).toMatchObject({ ok: true, retired: true, disposition: { kind: 'cancel', cancelled: 2 } })
    expect(h.transitions).toEqual([
      { taskId: 't1', from: 'in_progress', to: 'cancelled', reason: 'assignee-retired' },
      { taskId: 't2', from: 'rework', to: 'cancelled', reason: 'assignee-retired' },
    ])
    expect(h.retired).toEqual([WORKER])
  })

  it('does not retire when a cancel fails', () => {
    const h = harness({ tasks: [task('t1', 'in_progress')], transitionOk: false })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'cancel',
    })
    expect(result).toMatchObject({ ok: false, code: 'DISPOSITION_FAILED' })
    expect(h.retired).toEqual([])
  })

  it('returns tasks to the acting supervisor before retiring', () => {
    const h = harness({ tasks: [task('t1', 'in_progress'), task('t2', 'review')] })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'return',
    })
    expect(result).toMatchObject({ ok: true, retired: true, disposition: { kind: 'return', taskIds: ['t1', 't2'], returned: 2, replayed: 0 } })
    expect(h.returns).toEqual([{
      projectId: PROJECT,
      fromSessionId: WORKER,
      actorSessionId: SUPERVISOR,
      taskIds: ['t1', 't2'],
      reason: 'assignee-retired',
    }])
    expect(h.retired).toEqual([WORKER])
  })

  it('does not retire when the return write fails', () => {
    const h = harness({ tasks: [task('t1', 'in_progress')], returnOk: false })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'return',
    })
    expect(result).toMatchObject({ ok: false, code: 'DISPOSITION_FAILED' })
    expect(h.retired).toEqual([])
  })

  it('rejects transfer as unsupported in 0.9.3', () => {
    const h = harness({ tasks: [task('t1', 'in_progress')] })
    expect(retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'transfer',
    })).toMatchObject({ ok: false, code: 'UNSUPPORTED_DISPOSITION' })
    expect(h.retired).toEqual([])
  })

  it('rejects a self-disposal and an invalid actor hint', () => {
    const self = harness({ tasks: [task('t1', 'in_progress')] })
    expect(retireMemberWithDisposition(self.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      actorSessionId: WORKER,
      taskDisposition: 'cancel',
    })).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })

    const stranger = harness({ tasks: [task('t1', 'in_progress')] })
    expect(retireMemberWithDisposition(stranger.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      actorSessionId: 'stranger',
      taskDisposition: 'cancel',
    })).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })
  })

  it('reports NOT_FOUND for an unknown or departed member', () => {
    const h = harness({ members: [member(SUPERVISOR, 'supervisor'), member(WORKER, 'worker', 'departed')] })
    expect(retireMemberWithDisposition(h.deps, { sessionId: WORKER, projectId: PROJECT }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('lets the only supervisor cancel their own open tasks', () => {
    const h = harness({
      members: [member(SUPERVISOR, 'supervisor')],
      tasks: [task('t1', 'in_progress', SUPERVISOR)],
    })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: SUPERVISOR,
      projectId: PROJECT,
      taskDisposition: 'cancel',
    })
    expect(result).toMatchObject({ ok: true, retired: true, disposition: { kind: 'cancel', cancelled: 1 } })
    expect(h.openedWith).toEqual([SUPERVISOR])
    expect(h.transitions).toEqual([{ taskId: 't1', from: 'in_progress', to: 'cancelled', reason: 'assignee-retired' }])
    expect(h.retired).toEqual([SUPERVISOR])
  })

  it('refuses return when the departing supervisor has no other supervisor', () => {
    const h = harness({
      members: [member(SUPERVISOR, 'supervisor')],
      tasks: [task('t1', 'in_progress', SUPERVISOR)],
    })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: SUPERVISOR,
      projectId: PROJECT,
      taskDisposition: 'return',
    })
    expect(result).toMatchObject({ ok: false, code: 'NO_OTHER_SUPERVISOR' })
    if (result.ok) return
    expect(result.message).toContain('cancel')
    expect(h.returns).toEqual([])
    expect(h.retired).toEqual([])
  })

  it('keeps worker retirement using the active supervisor as actor', () => {
    const h = harness({ tasks: [task('t1', 'in_progress')] })
    const result = retireMemberWithDisposition(h.deps, {
      sessionId: WORKER,
      projectId: PROJECT,
      taskDisposition: 'cancel',
    })
    expect(result).toMatchObject({ ok: true, disposition: { kind: 'cancel', cancelled: 1 } })
    expect(h.openedWith).toEqual([SUPERVISOR])
    expect(h.retired).toEqual([WORKER])
  })
})

describe('retire helpers', () => {
  it('lists only non-terminal tasks of the member', () => {
    expect(openTasksOf([
      task('t1', 'in_progress'),
      task('t2', 'verified'),
      task('t3', 'dispatched', 'someone-else'),
    ], WORKER).map(row => row.taskId)).toEqual(['t1'])
  })

  it('resolves the acting supervisor from the roster, never from a role claim', () => {
    const members = [member(SUPERVISOR, 'supervisor'), member(WORKER, 'worker')]
    expect(resolveRetireActor(members, undefined)).toEqual({ ok: true, sessionId: SUPERVISOR })
    expect(resolveRetireActor(members, WORKER)).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })
    expect(resolveRetireActor([member(WORKER, 'worker')], undefined)).toMatchObject({ ok: false, code: 'NO_ACTOR' })
  })

  it('parses the IPC request and rejects malformed fields', () => {
    expect(parseRetireMemberOptions({ sessionId: WORKER, projectId: PROJECT, taskDisposition: 'cancel' }))
      .toEqual({ ok: true, value: { sessionId: WORKER, projectId: PROJECT, taskDisposition: 'cancel' } })
    expect(parseRetireMemberOptions({ sessionId: WORKER })).toMatchObject({ ok: false, field: 'projectId' })
    expect(parseRetireMemberOptions({ sessionId: WORKER, projectId: PROJECT, taskDisposition: 7 }))
      .toMatchObject({ ok: false, field: 'taskDisposition' })
  })
})

describe('returnOpenTasksToSupervisor (real ledger)', () => {
  function seedLedger(): string {
    const root = mkdtempSync(join(tmpdir(), 'cadre-return-'))
    roots.push(root)
    const path = join(root, 'cadre.sqlite')
    initCadreStore(path)
    const db = new DatabaseSync(path)
    try {
      const insertMember = db.prepare(`INSERT INTO members
        (project_id, session_id, role, display_name, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'available', ?, ?)`)
      insertMember.run(PROJECT, SUPERVISOR, 'supervisor', '主管', AT, AT)
      insertMember.run(PROJECT, WORKER, 'worker', '员工', AT, AT)
      const insertTask = db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body,
        body_bytes, body_sha256, status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'body', 4, 'sha', ?, ?, ?, ?, ?)`)
      insertTask.run('t1', PROJECT, 1, '任务一', 'in_progress', SUPERVISOR, WORKER, AT, AT)
      insertTask.run('t2', PROJECT, 2, '任务二', 'review', SUPERVISOR, WORKER, AT, AT)
    } finally {
      db.close()
    }
    return path
  }

  it('moves open tasks to the supervisor and records one event per task', () => {
    const path = seedLedger()
    const result = returnOpenTasksToSupervisor({
      databasePath: path,
      projectId: PROJECT,
      fromSessionId: WORKER,
      actorSessionId: SUPERVISOR,
      taskIds: ['t1', 't2'],
    })
    expect(result).toEqual({ ok: true, returned: 2, replayed: 0 })

    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = db.prepare('SELECT task_id, assignee_session_id FROM tasks ORDER BY task_id').all()
      expect(rows).toEqual([
        { task_id: 't1', assignee_session_id: SUPERVISOR },
        { task_id: 't2', assignee_session_id: SUPERVISOR },
      ])
      const events = db.prepare(`SELECT task_id, from_status, to_status, actor_session_id, reason
        FROM task_events ORDER BY task_id`).all()
      expect(events).toEqual([
        { task_id: 't1', from_status: 'in_progress', to_status: 'in_progress', actor_session_id: SUPERVISOR, reason: 'assignee-retired' },
        { task_id: 't2', from_status: 'review', to_status: 'review', actor_session_id: SUPERVISOR, reason: 'assignee-retired' },
      ])
    } finally {
      db.close()
    }
  })

  it('is idempotent for a retried disposition', () => {
    const path = seedLedger()
    const input = {
      databasePath: path,
      projectId: PROJECT,
      fromSessionId: WORKER,
      actorSessionId: SUPERVISOR,
      taskIds: ['t1', 't2'],
    }
    expect(returnOpenTasksToSupervisor(input)).toEqual({ ok: true, returned: 2, replayed: 0 })
    expect(returnOpenTasksToSupervisor(input)).toEqual({ ok: true, returned: 0, replayed: 2 })
  })

  it('rejects a worker actor and a task owned by someone else', () => {
    const path = seedLedger()
    expect(returnOpenTasksToSupervisor({
      databasePath: path,
      projectId: PROJECT,
      fromSessionId: WORKER,
      actorSessionId: WORKER,
      taskIds: ['t1'],
    })).toMatchObject({ ok: false, code: 'FORBIDDEN_ACTOR' })

    expect(returnOpenTasksToSupervisor({
      databasePath: path,
      projectId: PROJECT,
      fromSessionId: 'someone-else',
      actorSessionId: SUPERVISOR,
      taskIds: ['t1'],
    })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', taskId: 't1' })
  })
})

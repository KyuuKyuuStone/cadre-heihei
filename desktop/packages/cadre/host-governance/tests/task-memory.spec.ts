import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { initCadreStore } from '../../../../cadre-collab/entry.ts'
import { TaskMemoryReader, TaskMemoryCompactionGate, capTaskMemory } from '../src/task-memory.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'task-memory-'))
  roots.push(root)
  const path = join(root, 'ledger.sqlite')
  initCadreStore(path)
  const db = new DatabaseSync(path)
  try {
    const at = '2026-11-02T00:00:00.000Z'
    const member = db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'available', ?, ?)`)
    member.run('p1', 'sup', 'supervisor', '主管', at, at)
    member.run('p1', 'w1', 'worker', '小王', at, at)
    member.run('p1', 'w2', 'worker', '小李', at, at)
    member.run('p2', 'other', 'worker', '外部', at, at)
    const task = db.prepare(`INSERT INTO tasks (task_id, project_id, seq, title, body, body_bytes,
      body_sha256, status, dispatcher_session_id, assignee_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 'sha', ?, 'sup', ?, ?, ?)`)
    task.run('t-ongoing', 'p1', 1, '进行中任务', '当前工作', 'in_progress', 'w1', at, at)
    task.run('t-done', 'p1', 2, '已完成任务', '完成内容', 'verified', 'w1', at, at)
    task.run('t-other', 'p1', 3, '别人任务', '别人内容', 'verified', 'w2', at, at)
    task.run('t-cross', 'p2', 1, '跨项目任务', '跨项目', 'verified', 'other', at, at)
    const memory = db.prepare(`INSERT INTO task_memory
      (task_id, project_id, name, status, summary, decisions_json, artifacts_json, transcript_ref, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    memory.run('t-done', 'p1', '已完成任务', 'verified', '已完成任务｜完成内容', '["验收通过"]',
      '["C:/out.md"]', 'task:t-done', at)
    memory.run('t-other', 'p1', '别人任务', 'verified', '别人任务｜别人内容', '[]', '[]', 'task:t-other', at)
    memory.run('t-cross', 'p2', '跨项目任务', 'verified', '跨项目｜跨项目', '[]', '[]', 'task:t-cross', at)
  } finally {
    db.close()
  }
  return path
}

describe('task memory', () => {
  it('assembles ongoing plus relevant completed summaries and trims unrelated history', () => {
    const reader = new TaskMemoryReader(seed())
    try {
      const supervisor = reader.context({ projectId: 'p1', actorSessionId: 'sup' })
      expect(supervisor.ongoing.map(task => task.taskId)).toEqual(['t-ongoing'])
      expect(supervisor.completed.map(task => task.taskId)).toEqual(expect.arrayContaining(['t-done', 't-other']))
      expect(supervisor.rendered).toContain('已完成任务')
      expect(supervisor.rendered).not.toContain('跨项目任务')
      const employee = reader.context({ projectId: 'p1', actorSessionId: 'w1' })
      expect(employee.completed.map(task => task.taskId)).toEqual(['t-done'])
      expect(employee.rendered).not.toContain('别人任务')
    } finally {
      reader.close()
    }
  })

  it('searches summaries by id/name/keyword and refuses cross-project rows', () => {
    const reader = new TaskMemoryReader(seed())
    try {
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: 't-done' })
        .map(task => task.taskId)).toEqual(['t-done'])
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: '验收通过' })
        .map(task => task.taskId)).toEqual(['t-done'])
      expect(reader.search({
        projectId: 'p1', actorSessionId: 'sup', query: 't-done', includeSnippet: true,
      })[0]?.snippet).toContain('完成内容')
      expect(reader.search({ projectId: 'p1', actorSessionId: 'sup', query: '跨项目' })).toEqual([])
      expect(reader.search({ projectId: 'p1', actorSessionId: 'w1', query: 't-other' })).toEqual([])
      expect(reader.search({ projectId: 'p2', actorSessionId: 'other', query: '跨项目' })).toHaveLength(1)
    } finally {
      reader.close()
    }
  })

  it('caps prompt memory and preserves constraints when over budget', () => {
    const text = `【进行中任务】\n- 任务：${'x'.repeat(5_000)}\n约束：不改 schema\n验收：pnpm test`
    const capped = capTaskMemory(text, 100)
    expect(capped).toContain('task memory truncated')
    expect(capped).toContain('约束：不改 schema')
    expect(capped).toContain('验收：pnpm test')
    expect(capTaskMemory('', 100)).toBe('')
    expect(capTaskMemory('短记忆', 100)).toBe('短记忆')
  })

  it('compacts once per new archive when the agent becomes idle', () => {
    const gate = new TaskMemoryCompactionGate()
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle')).toBe(true)
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'running')).toBe(false)
    gate.markCompacted('s1', 't1')
    expect(gate.shouldCompact('s1', { updatedAt: 't1' }, 'idle')).toBe(false)
    expect(gate.shouldCompact('s1', { updatedAt: 't2' }, 'idle')).toBe(true)
  })

  it('adds task_memory to an existing ledger without dropping rows', () => {
    const path = seed()
    const raw = new DatabaseSync(path)
    try {
      raw.exec('DROP INDEX IF EXISTS idx_task_memory_project; DROP TABLE task_memory')
    } finally {
      raw.close()
    }
    initCadreStore(path)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(check.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'task_memory'`).get()).toBeTruthy()
      expect((check.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count).toBe(4)
    } finally {
      check.close()
    }
  })
})

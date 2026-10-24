import { describe, expect, it, vi } from 'vitest'
import { CadreProjectRegistry, activeMember } from '../src/cadre-projects.ts'
import type { CadreCollab, CadreCollabOptions } from '../src/cadre-collab-api.ts'
import type { CadreMemberRow } from '../src/cadre-ledger.ts'

function fakeCollab(projectId: string): CadreCollab {
  return {
    databasePath: '/tmp/cadre.sqlite',
    dispatch: vi.fn(),
    transition: vi.fn(),
    listTasks: () => ({ projectId, rows: [] }),
    close: vi.fn(),
  }
}

function member(sessionId: string, overrides: Partial<CadreMemberRow> = {}): CadreMemberRow {
  return {
    sessionId,
    role: 'worker',
    displayName: sessionId,
    state: 'available',
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('cadre project registry', () => {
  it('opens one write store per project and caller, and reuses it', () => {
    const opened: CadreCollabOptions[] = []
    const registry = new CadreProjectRegistry({
      databasePath: '/tmp/cadre.sqlite',
      role: 'supervisor',
      open: (options) => {
        opened.push(options)
        return fakeCollab(options.projectId)
      },
    })

    const first = registry.forProject('workspace-a', 'session-a')
    expect(registry.forProject('workspace-a', 'session-a')).toBe(first)
    const other = registry.forProject('workspace-b', 'session-a')
    const sameProjectOtherCaller = registry.forProject('workspace-a', 'session-b')
    expect(other).not.toBe(first)
    expect(sameProjectOtherCaller).not.toBe(first)
    expect(opened.map(options => options.projectId)).toEqual(['workspace-a', 'workspace-b', 'workspace-a'])
    expect(opened[0]).toMatchObject({
      sessionId: 'session-a',
      role: 'supervisor',
      databasePath: '/tmp/cadre.sqlite',
      busyTimeoutMs: 15_000,
    })
    expect(opened[2]).toMatchObject({ sessionId: 'session-b', role: 'supervisor' })
    expect(registry.size).toBe(3)

    registry.close()
    expect(first?.close).toHaveBeenCalledOnce()
    expect(other?.close).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
  })

  it('keeps a project unopened when the write library is unavailable', () => {
    const registry = new CadreProjectRegistry({
      databasePath: '/tmp/cadre.sqlite',
      role: 'supervisor',
      open: () => undefined,
    })
    expect(registry.forProject('workspace-a', 'session-a')).toBeUndefined()
    expect(registry.size).toBe(0)
  })
})

describe('project membership', () => {
  it('treats a departed or absent member as foreign', () => {
    const members = [member('sup-1', { role: 'supervisor' }), member('gone', { state: 'departed' })]
    expect(activeMember(members, 'sup-1')).toMatchObject({ role: 'supervisor' })
    expect(activeMember(members, 'gone')).toBeUndefined()
    expect(activeMember(members, 'stranger')).toBeUndefined()
  })
})

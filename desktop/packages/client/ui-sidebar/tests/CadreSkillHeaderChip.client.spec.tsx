// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CadreSkillHeaderChip } from '../src/client/CadreSkillHeaderChip.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never

const roster: CadreRosterState = {
  status: 'ready',
  members: [
    { sessionId: 'sup', role: 'supervisor', displayName: '主管', state: 'available' },
    { sessionId: 'w1', role: 'worker', displayName: '前端', state: 'available' },
  ],
  error: null,
}
const entries = (selected: number) => [
  { id: 'a', name: 'A', description: '', roles: ['worker'], tokenEstimate: 1, tools: [], source: 's', license: 'MIT', selected: selected > 0 },
  { id: 'b', name: 'B', description: '', roles: ['worker'], tokenEstimate: 1, tools: [], source: 's', license: 'MIT', selected: selected > 1 },
]

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function chipProps(overrides: {
  readonly sessionId?: string
  readonly active?: Record<string, { retainedBy: { mainView: number } }>
  readonly revision?: number
} = {}): ComponentProps<typeof CadreSkillHeaderChip> {
  const active = overrides.active ?? { sup: { retainedBy: { mainView: 1 } }, w1: { retainedBy: { mainView: 0 } } }
  return {
    sessionId: overrides.sessionId ?? 'w1',
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never,
    useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
      selector({ byId: { ...active, w1: { ...active.w1, displayTitle: '前端' } } })) as never,
    useRevision: ((selector: (value: number) => unknown) => selector(overrides.revision ?? 0)) as never,
    projectOfSession: () => 'p1',
    openSkills: vi.fn(),
    t,
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill header chip', () => {
  it('shows the selected skill count and opens the picker for the current Session', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: entries(2) }))
    vi.stubGlobal('fetch', fetchMock)
    const props = chipProps()
    render(<CadreSkillHeaderChip {...props} />)
    const chip = await screen.findByRole('button', { name: '技能 2' })
    expect(chip).toBeTruthy()
    fireEvent.click(chip)
    expect(props.openSkills).toHaveBeenCalledWith('w1', '前端', 'worker', 'sup')
    const call = fetchMock.mock.calls[0]
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({
      projectId: 'p1', actorSessionId: 'sup', targetSessionId: 'w1',
    })
  })

  it('shows 0 when nothing is bound and refreshes after a revision change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: entries(0) })))
    const first = render(<CadreSkillHeaderChip {...chipProps()} />)
    expect(await screen.findByRole('button', { name: '技能 0' })).toBeTruthy()
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: entries(1) })))
    first.rerender(<CadreSkillHeaderChip {...chipProps({ revision: 1 })} />)
    expect(await screen.findByRole('button', { name: '技能 1' })).toBeTruthy()
  })

  it('is disabled when the active Session is an employee and hidden for ordinary Sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: entries(1) })))
    const employee = chipProps({ active: { w1: { retainedBy: { mainView: 1 } } } })
    render(<CadreSkillHeaderChip {...employee} />)
    const chip = await screen.findByRole('button', { name: '技能 1' })
    expect(chip.hasAttribute('disabled')).toBe(true)
    cleanup()
    const ordinary = render(<CadreSkillHeaderChip {...chipProps({ sessionId: 'plain' })} />)
    expect(ordinary.container.firstChild).toBeNull()
  })
})

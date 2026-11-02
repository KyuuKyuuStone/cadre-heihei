// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillTab } from '../src/client/CadreSkillTab.tsx'
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
const ENTRIES = [
  { id: 'worker-skill', name: '员工技能', description: '', roles: ['worker'], tokenEstimate: 10, tools: [], source: 's', license: 'MIT', selected: true },
  { id: 'sup-skill', name: '主管技能', description: '', roles: ['supervisor'], tokenEstimate: 20, tools: [], source: 's', license: 'MIT', selected: false },
]

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function props(sessionId: string): ComponentProps<typeof CadreSkillTab> {
  return {
    sessionId,
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never,
    projectOfSession: () => 'p1',
    t,
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill tab', () => {
  it('lets a worker read and save their own selection', async () => {
    let catalogs = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: { skills: [] } })
      catalogs += 1
      return json({ ok: true, result: catalogs === 1 ? ENTRIES : ENTRIES.map(entry => ({ ...entry, selected: false })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('w1')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect(screen.getByText('已选 1')).toBeTruthy()
    expect(document.querySelectorAll('[data-skill-card]')).toHaveLength(1)
    expect(screen.getByText('约 10 tokens')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '员工技能' }))
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    expect(await screen.findByText('本会话技能已保存。')).toBeTruthy()
    expect(screen.getByText('已选 0')).toBeTruthy()
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      actorSessionId: 'w1', targetSessionId: 'w1', skills: [],
    })
  })

  it('lets a supervisor switch the target member and save for them', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: { skills: ['worker-skill'] } })
      return json({ ok: true, result: ENTRIES })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('sup')} />)
    expect(await screen.findByText('主管技能')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('编辑成员'), { target: { value: 'w1' } })
    expect(await screen.findByText('员工技能')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
        actorSessionId: 'sup', targetSessionId: 'w1',
      })
    })
  })

  it('shows the empty state when no skill is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillTab {...props('w1')} />)
    expect(await screen.findByText('还没有可用的技能。')).toBeTruthy()
    expect(document.querySelector('[data-skill-tab-empty]')).toBeTruthy()
  })

  it('renders nothing for an ordinary Session', () => {
    const view = render(<CadreSkillTab {...props('plain')} />)
    expect(view.container.firstChild).toBeNull()
  })
})

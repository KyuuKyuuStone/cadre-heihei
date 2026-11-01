// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillSettingsDialog, CadreSkillSettingsMenuItem, type CadreSkillsRequest } from '../src/client/CadreSkills.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const REQUEST: CadreSkillsRequest = { sessionId: 'sup', projectId: 'p1', label: '主管', token: 1 }
const ENTRIES = [
  { id: 'worker-only', name: '员工技能', description: '只给员工', roles: ['worker'], tokenEstimate: 10, tools: [], source: 's', license: 'MIT', selected: false },
  { id: 'sup-only', name: '主管技能', description: '只给主管', roles: ['supervisor'], tokenEstimate: 20, tools: [], source: 's', license: 'MIT', selected: true },
]

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function dialogProps(): ComponentProps<typeof CadreSkillSettingsDialog> {
  return {
    useRequest: (selector: (value: CadreSkillsRequest) => unknown) => selector(REQUEST),
    closeSkills: vi.fn(),
    t,
  } as unknown as ComponentProps<typeof CadreSkillSettingsDialog>
}

function roster(role: 'supervisor' | 'worker'): CadreRosterState {
  return { status: 'ready', members: [{ sessionId: role === 'supervisor' ? 'sup' : 'w1', role, displayName: role, state: 'available' }], error: null }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Cadre skill settings', () => {
  it('hides the menu entry from employees and shows it to supervisors', () => {
    const menuProps = (sessionId: string, role: 'supervisor' | 'worker') => ({
      sessionId,
      displayTitle: '主管',
      useMenuOpenState: () => [false, vi.fn()] as const,
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster(role))) as never,
      openSkills: vi.fn(),
      closeSkills: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreSkillSettingsMenuItem>)
    const worker = render(<CadreSkillSettingsMenuItem {...menuProps('w1', 'worker')} />)
    expect(worker.container.firstChild).toBeNull()
    cleanup()
    render(<CadreSkillSettingsMenuItem {...menuProps('sup', 'supervisor')} />)
    expect(screen.getByRole('menuitem', { name: '技能…' })).toBeTruthy()
  })

  it('filters by role, totals tokens, previews and saves', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/preview')) return json({ ok: true, result: { id: 'sup-only', content: '# 主管技能正文', tokenEstimate: 20, license: 'MIT' } })
      return json({ ok: true, result: { skills: ['sup-only'] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillSettingsDialog {...dialogProps()} />)
    expect(await screen.findByText('主管技能')).toBeTruthy()
    expect(screen.queryByText('员工技能')).toBeNull()
    expect(screen.getByText(/已选技能 token 估算合计：20/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByText('# 主管技能正文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => { expect(screen.getByText('技能包已保存。')).toBeTruthy() })
    const setCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    expect(JSON.parse((setCall?.[1] as RequestInit).body as string)).toMatchObject({ targetSessionId: 'sup', skills: ['sup-only'] })
  })

  it('shows the empty state and install directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillSettingsDialog {...dialogProps()} />)
    expect(await screen.findByText('还没有可用的技能包。')).toBeTruthy()
    expect(screen.getByText('安装目录：~/.dsh/cadre-skills')).toBeTruthy()
  })
})

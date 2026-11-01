// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillSettingsDialog, CadreSkillSettingsMenuItem, type CadreSkillsRequest } from '../src/client/CadreSkills.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const REQUEST: CadreSkillsRequest = { sessionId: 'w1', projectId: 'p1', label: '员工', role: 'worker', token: 1 }
const ENTRIES = [
  { id: 'worker-only', name: '员工技能', description: '只给员工', roles: ['worker'], tokenEstimate: 10, tools: [], source: 's', license: 'MIT', selected: true },
  { id: 'sup-only', name: '主管技能', description: '只给主管', roles: ['supervisor'], tokenEstimate: 20, tools: [], source: 's', license: 'MIT', selected: false },
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

function roster(_role: 'supervisor' | 'worker'): CadreRosterState {
  return {
    status: 'ready',
    members: [
      { sessionId: 'sup', role: 'supervisor', displayName: '主管', state: 'available' },
      { sessionId: 'w1', role: 'worker', displayName: '员工', state: 'available' },
    ],
    error: null,
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Cadre skill settings', () => {
  it('shows the employee-row entry only when the active session is a supervisor', () => {
    const menuProps = (sessionId: string) => ({
      sessionId,
      displayTitle: '员工',
      useMenuOpenState: () => [false, vi.fn()] as const,
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster('supervisor'))) as never,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
        selector({ byId: { sup: { retainedBy: { mainView: 1 } }, w1: { retainedBy: { mainView: 0 } } } })) as never,
      openSkills: vi.fn(),
      closeSkills: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreSkillSettingsMenuItem>)
    render(<CadreSkillSettingsMenuItem {...menuProps('w1')} />)
    expect(screen.getByRole('menuitem', { name: '技能…' })).toBeTruthy()

    cleanup()
    const employeeView = {
      ...menuProps('w1'),
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) => selector({ byId: {
        sup: { retainedBy: { mainView: 0 } }, w1: { retainedBy: { mainView: 1 } },
      } })) as never,
    } as unknown as ComponentProps<typeof CadreSkillSettingsMenuItem>
    const hidden = render(<CadreSkillSettingsMenuItem {...employeeView} />)
    expect(hidden.container.firstChild).toBeNull()
  })

  it('filters by role, totals tokens, previews and saves', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/preview')) return json({ ok: true, result: { id: 'worker-only', content: '# 员工技能正文', tokenEstimate: 10, license: 'MIT' } })
      return json({ ok: true, result: { skills: ['worker-only'] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillSettingsDialog {...dialogProps()} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect(screen.queryByText('主管技能')).toBeNull()
    expect(screen.getByText(/已选技能 token 估算合计：10/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByText('# 员工技能正文')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => { expect(screen.getByText('技能已保存。')).toBeTruthy() })
    const setCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    expect(JSON.parse((setCall?.[1] as RequestInit).body as string)).toMatchObject({ targetSessionId: 'w1', skills: ['worker-only'] })
  })

  it('only selects installed skills and has no install or delete controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    render(<CadreSkillSettingsDialog {...dialogProps()} />)
    await screen.findByText('员工技能')
    expect(screen.queryByRole('button', { name: '手动添加技能' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.getByRole('button', { name: '保存技能' })).toBeTruthy()
  })

  it('shows the empty state and install directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillSettingsDialog {...dialogProps()} />)
    expect(await screen.findByText('还没有可用的技能。')).toBeTruthy()
    expect(screen.getByText('安装目录：~/.dsh/cadre-skills')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillLibraryPage } from '../src/client/CadreSkillLibrary.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const ENTRIES = [
  { id: 'worker-only', name: '员工技能', description: '只给员工', roles: ['worker'], tokenEstimate: 10, tools: [], source: 'local', license: 'MIT', selected: false },
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

function pageProps(role: 'supervisor' | 'worker' = 'supervisor'): ComponentProps<typeof CadreSkillLibraryPage> {
  const roster: CadreRosterState = {
    status: 'ready',
    members: [
      { sessionId: 'sup', role: 'supervisor', displayName: '主管', state: 'available' },
      { sessionId: 'w1', role: 'worker', displayName: '员工', state: 'available' },
    ],
    error: null,
  }
  return {
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(roster)) as never,
    useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
      selector({ byId: { [role === 'supervisor' ? 'sup' : 'w1']: { retainedBy: { mainView: 1 } } } })) as never,
    projectOfSession: () => 'p1',
    t,
  } as unknown as ComponentProps<typeof CadreSkillLibraryPage>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('lists installed skills with metadata and hides install controls from non-supervisors', () => {
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(screen.getByText('只有主管可以查看和管理技能库。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '手动添加技能' })).toBeNull()
  })

  it('lists installed skills and supports add/delete', async () => {
    let catalogs = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) {
        catalogs += 1
        return json({ ok: true, result: catalogs === 1 ? ENTRIES : [{ ...ENTRIES[0], name: '新技能' }] })
      }
      return json({ ok: true, result: { removed: true, id: 'worker-only' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('约 10 tokens')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '手动添加技能' }))
    fireEvent.change(screen.getByLabelText('技能 id'), { target: { value: 'new-skill' } })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新技能' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '手动添加' } })
    fireEvent.change(screen.getByLabelText('SKILL.md 正文'), { target: { value: '# body' } })
    expect(screen.getByLabelText<HTMLInputElement>('token 估算').value).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: '添加技能' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/add'))).toBe(true)
    })
    expect(await screen.findByText('新技能')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('技能已删除。')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
  })
})

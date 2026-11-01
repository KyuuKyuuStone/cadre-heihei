// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillLibraryPage } from '../src/client/CadreSkillLibrary.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { en, zh } from '../src/client/locales.ts'

const ENTRIES = [
  { id: 'ai-design', name: 'AI Design', description: 'English landing page description', roles: ['worker'], tokenEstimate: 100, tools: ['read'], origin: 'builtin', source: 'builtin', author: 'Elaya', homepage: 'https://example.test/ai-design', license: 'MIT', selected: false },
  { id: 'worker-only', name: '员工技能', description: '只给员工', roles: ['worker'], tokenEstimate: 10, tools: [], origin: 'installed', source: 'local', license: 'MIT', selected: false },
]

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never
const tEn = ((key: keyof typeof en) => en[key]) as never

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function pageProps(role: 'supervisor' | 'worker' = 'supervisor', translate = t): ComponentProps<typeof CadreSkillLibraryPage> {
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
    t: translate,
  } as unknown as ComponentProps<typeof CadreSkillLibraryPage>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('hides all management controls from non-supervisors', () => {
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(screen.getByText('只有主管可以查看和管理技能库。')).toBeTruthy()
    expect(screen.queryByPlaceholderText('GitHub 仓库、tree 或 raw SKILL.md URL')).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
  })

  it('groups built-ins and installed skills, localizes descriptions, and keeps built-ins read-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    render(<CadreSkillLibraryPage {...pageProps()} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByText('已安装')).toBeTruthy()
    expect(screen.getByText('落地页设计：信息结构、转化文案、视觉规范、状态与上线检查。')).toBeTruthy()
    expect(screen.queryByText('English landing page description')).toBeNull()
    expect(screen.queryByText(/技能市场/)).toBeNull()
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    fireEvent.click(screen.getAllByText('详情')[0]!)
    expect(screen.getByText('约 100 tokens')).toBeTruthy()
    expect(screen.getByText('作者：Elaya')).toBeTruthy()
    expect(screen.getAllByText('许可：MIT').length).toBeGreaterThan(0)
    const link = screen.getByRole('link', { name: '上游主页' })
    expect(link.getAttribute('href')).toBe('https://example.test/ai-design')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByText('local')).toBeTruthy()
  })

  it('localizes built-in descriptions in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    render(<CadreSkillLibraryPage {...pageProps('supervisor', tEn)} />)
    expect(await screen.findByText('Landing-page design: information structure, conversion copy, visual rules, states, and ship checks.')).toBeTruthy()
  })

  it('installs from a GitHub URL without manifest fields and deletes installed skills', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/install-url')) return json({ ok: true, result: { id: 'new-skill' } })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    await screen.findByText('员工技能')
    const sources = document.querySelector('[data-skill-sources]')
    expect(sources).not.toBeNull()
    expect(sources!.querySelectorAll('a')).toHaveLength(4)
    for (const link of sources!.querySelectorAll('a')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(screen.getByText('第三方技能请先审查再安装。')).toBeTruthy()
    expect(screen.getByText('SkillHub').getAttribute('href')).toBe('https://skillhub.cn')
    expect(screen.queryByLabelText('技能 id')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '高级手动表单' }))
    expect(screen.getByLabelText('技能 id')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('GitHub 仓库、tree 或 raw SKILL.md URL'), {
      target: { value: 'https://github.com/acme/skills/tree/main/skills/new-skill' },
    })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/install-url'))).toBe(true)
    })
    const installCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/install-url'))
    expect(JSON.parse((installCall?.[1] as RequestInit).body as string)).toMatchObject({
      url: 'https://github.com/acme/skills/tree/main/skills/new-skill', confirm: false,
    })
    expect(await screen.findByText('技能已安装。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('技能已删除。')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
  })
})

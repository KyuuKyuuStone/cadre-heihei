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
    openSkillAdminSession: async () => {},
    t: translate,
  } as unknown as ComponentProps<typeof CadreSkillLibraryPage>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('hides all management controls from non-supervisors', () => {
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(screen.getByText('只有主管可以查看和管理技能库。')).toBeTruthy()
    expect(screen.queryByPlaceholderText('GitHub 仓库、tree 或 raw SKILL.md URL')).toBeNull()
    expect(screen.queryByRole('button', { name: '安装技能' })).toBeNull()
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

  it('opens the skill administrator history and creates an ordinary admin session', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) {
        return json({ ok: true, result: { sessionId: 'admin-1', title: '技能管理员', updatedAt: Date.now() } })
      }
      return json({ ok: true, result: ENTRIES })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSkillAdminSession }} />)
    await screen.findByText('内置技能')
    fireEvent.click(screen.getByRole('button', { name: '安装技能' }))
    expect(await screen.findByText('还没有技能管理员对话。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }))
    await waitFor(() => { expect(openSkillAdminSession).toHaveBeenCalledWith('admin-1') })
  })

  it('lists and deletes previous admin conversations by preset', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/admin/sessions')) {
        return json({ ok: true, result: [{ sessionId: 'old-1', title: '旧对话', updatedAt: Date.now() }] })
      }
      if (url.endsWith('/admin/delete-session')) return json({ ok: true, result: { deleted: true } })
      return json({ ok: true, result: ENTRIES })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    await screen.findByText('内置技能')
    fireEvent.click(screen.getByRole('button', { name: '安装技能' }))
    expect(await screen.findByText('旧对话')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)
    await waitFor(() => { expect(screen.queryByText('旧对话')).toBeNull() })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/admin/delete-session'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      projectId: 'p1', operatorSessionId: 'sup', sessionId: 'old-1',
    })
  })

  it('localizes built-in descriptions in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    render(<CadreSkillLibraryPage {...pageProps('supervisor', tEn)} />)
    expect(await screen.findByText('Landing-page design: information structure, conversion copy, visual rules, states, and ship checks.')).toBeTruthy()
  })

  it('has no URL installer, keeps sources and the folded manual form, and deletes installed skills', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    await screen.findByText('员工技能')
    expect(screen.queryByPlaceholderText(/SKILL\.md URL/)).toBeNull()
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(screen.queryByText('同名技能已存在时覆盖')).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('技能已删除。')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
  })

  it('shows a readable error when the administrator is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.endsWith('/admin/sessions')) {
        return json({ ok: false, code: 'SKILL_ADMIN_UNAVAILABLE', message: 'no session service' })
      }
      return json({ ok: true, result: ENTRIES })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '安装技能' }))
    expect(await screen.findByText('技能管理员当前不可用：Host 未接入会话服务。')).toBeTruthy()
  })
})

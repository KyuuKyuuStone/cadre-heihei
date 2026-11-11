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
    defaultProjectId: () => undefined,
    openSkillAdminSession: async () => {},
    t: translate,
  } as unknown as ComponentProps<typeof CadreSkillLibraryPage>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('opens an ordinary install chat, then deletes and uses the manual form', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1, workspaceId: 'ws-1' } })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...{ ...pageProps('worker'), openSkillAdminSession }} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.queryByLabelText('安装说明')).toBeNull()
    expect(screen.queryByText('技能助手')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开安装对话' }))
    await waitFor(() => { expect(openSkillAdminSession).toHaveBeenCalledWith('chat-1', 'ws-1') })
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/admin/session'))).toBe(true)
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
    })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      actorSessionId: 'w1', targetSessionId: 'w1',
    })
  })

  it('groups built-ins and installed skills, localizes descriptions, and keeps built-ins read-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
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

  it('reuses the latest admin session and opens it as an ordinary conversation', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/sessions')) {
        return json({ ok: true, result: [{ sessionId: 'chat-9', title: '技能管理员', updatedAt: 9 }] })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps('worker'), openSkillAdminSession }} />)
    await screen.findByText('内置技能')
    expect(screen.queryByLabelText('安装说明')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开安装对话' }))
    await waitFor(() => { expect(openSkillAdminSession).toHaveBeenCalledWith('chat-9') })
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/admin/session'))).toBe(false)
  })

  it('shows a readable error when opening the installer fails', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_ADMIN_UNAVAILABLE', message: 'no service' })
    }))
    render(<CadreSkillLibraryPage {...{ ...pageProps('worker'), openSkillAdminSession }} />)
    await screen.findByText('内置技能')
    fireEvent.click(screen.getByRole('button', { name: '打开安装对话' }))
    expect(await screen.findByText('技能管理员当前不可用：Host 未接入会话服务。')).toBeTruthy()
    expect(openSkillAdminSession).not.toHaveBeenCalled()
  })

  it('does not require a supervisor to open the installer', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (requestUrl(input).endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (requestUrl(input).endsWith('/admin/session')) {
        return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1, workspaceId: 'ws-1' } })
      }
      return json({ ok: true, result: {} })
    }))
    const props = pageProps('worker')
    const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector({
      status: 'ready',
      members: [{ sessionId: 'w1', role: 'worker', displayName: '员工', state: 'available' }],
      error: null,
    })) as never
    render(<CadreSkillLibraryPage {...{ ...props, useRoster, openSkillAdminSession }} />)
    await screen.findByText('内置技能')
    fireEvent.click(screen.getByRole('button', { name: '打开安装对话' }))
    await waitFor(() => { expect(openSkillAdminSession).toHaveBeenCalledWith('chat-1', 'ws-1') })
  })

  it('shows the full page to a session outside the roster, acting under its own session id', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1, workspaceId: 'ws-1' } })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
        selector({ byId: { plain: { retainedBy: { mainView: 1 } } } })) as never,
      projectOfSession: () => undefined,
      defaultProjectId: () => 'p1',
    }} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开安装对话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级手动表单' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
    })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      projectId: 'p1', actorSessionId: 'plain', targetSessionId: 'plain',
    })
    const removal = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/remove'))
    expect(JSON.parse((removal?.[1] as RequestInit).body as string)).toMatchObject({
      projectId: 'p1', actorSessionId: 'plain',
    })
  })

  it('keeps the read-only fallback when no project exists at all', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      projectOfSession: () => undefined,
      defaultProjectId: () => undefined,
    }} />)
    expect(screen.getByText('当前没有可用的项目部或在册成员，暂时无法管理技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开安装对话' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the read-only fallback when no foreground session and no usable roster member exist', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
        selector({ byId: {} })) as never,
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector({
        status: 'ready',
        members: [{ sessionId: 'gone', role: 'supervisor', displayName: '前主管', state: 'departed' }],
        error: null,
      })) as never,
      projectOfSession: (sessionId: string) => (sessionId === 'gone' ? 'p1' : undefined),
      defaultProjectId: () => 'p1',
    }} />)
    expect(screen.getByText('当前没有可用的项目部或在册成员，暂时无法管理技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开安装对话' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('borrows the project supervisor when no foreground session exists', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
        selector({ byId: {} })) as never,
      defaultProjectId: () => 'p1',
    }} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开安装对话' })).toBeTruthy()
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      projectId: 'p1', actorSessionId: 'sup', targetSessionId: 'sup',
    })
  })

  it('shows an inline empty state when the library has no skills', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('还没有技能，先在上方粘贴 URL 或包名安装。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开安装对话' })).toBeTruthy()
  })

  it('requires confirmation before deleting a skill', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(false)
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
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    expect(screen.queryByPlaceholderText(/SKILL\.md URL/)).toBeNull()
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

})

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
  it('lets a worker chat, delete, and use the manual form as themselves', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1 } })
      if (url.endsWith('/admin/messages')) return json({ ok: true, result: { messages: [], nextSeq: 0 } })
      if (url.endsWith('/admin/message')) {
        expect(JSON.parse(init?.body as string)).toMatchObject({ actorSessionId: 'w1' })
        return json({ ok: true, result: { accepted: true } })
      }
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.queryByText('技能助手')).toBeNull()
    expect(screen.getByText('想装什么？')).toBeTruthy()
    expect(screen.getByLabelText('安装说明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级手动表单' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
    })
    fireEvent.change(screen.getByLabelText('安装说明'), { target: { value: '有什么技能？' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/admin/message'))).toBe(true)
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

  it('sends chat input to admin and displays the reply inline', async () => {
    let sent = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1 } })
      if (url.endsWith('/admin/message')) {
        sent = true
        expect(JSON.parse(init?.body as string)).toMatchObject({
          projectId: 'p1', actorSessionId: 'w1', sessionId: 'chat-1', text: '请根据文档安装 @acme/pkg-skill',
        })
        return json({ ok: true, result: { accepted: true } })
      }
      if (url.endsWith('/admin/messages')) {
        return json({
          ok: true,
          result: sent
            ? {
              messages: [
                { seq: 1, role: 'user', text: '请根据文档安装 @acme/pkg-skill', time: 1 },
                { seq: 2, role: 'assistant', text: '已安装 @acme/pkg-skill，来自链接文档。', time: 2 },
              ],
              nextSeq: 3,
            }
            : { messages: [], nextSeq: 0 },
        })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('内置技能')
    expect(screen.getByText('想装什么？')).toBeTruthy()
    expect(screen.queryByText('技能助手')).toBeNull()
    fireEvent.change(screen.getByLabelText('安装说明'), { target: { value: '请根据文档安装 @acme/pkg-skill' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('已安装 @acme/pkg-skill，来自链接文档。')).toBeTruthy()
    expect(screen.getAllByText('请根据文档安装 @acme/pkg-skill').length).toBeGreaterThan(0)
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/admin/message'))).toBe(true)
  })

  it('shows an inline error with retry when the assistant is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_ADMIN_UNAVAILABLE', message: 'no service' })
    }))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('技能管理员当前不可用：Host 未接入会话服务。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('does not block chat when the project has no supervisor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (requestUrl(input).endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (requestUrl(input).endsWith('/admin/session')) return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1 } })
      if (requestUrl(input).endsWith('/admin/messages')) return json({ ok: true, result: { messages: [], nextSeq: 0 } })
      return json({ ok: true, result: {} })
    }))
    const props = pageProps('worker')
    const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector({
      status: 'ready',
      members: [{ sessionId: 'w1', role: 'worker', displayName: '员工', state: 'available' }],
      error: null,
    })) as never
    render(<CadreSkillLibraryPage {...{ ...props, useRoster }} />)
    await screen.findByText('内置技能')
    expect(screen.getByLabelText('安装说明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
  })

  it('shows a readable prompt when the session has no project roster membership', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{ ...props, projectOfSession: () => undefined }} />)
    expect(screen.getByText('当前会话不属于任何项目部或花名册，无法管理技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装技能' })).toBeNull()
  })

  it('shows an inline empty state when the library has no skills', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('还没有技能，先在上方粘贴 URL 或包名安装。')).toBeTruthy()
    expect(screen.getByLabelText('安装说明')).toBeTruthy()
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

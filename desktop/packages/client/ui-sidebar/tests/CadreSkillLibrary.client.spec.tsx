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
  it('lets a worker install, delete, and use the manual form as themselves', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装技能' })).toBeNull()
    expect(screen.getByLabelText('安装说明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级手动表单' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开技能管理员' })).toBeNull()
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

  it('sends natural language, URL, and package input to install-any', async () => {
    const openSkillAdminSession = vi.fn(async () => {})
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/install-any')) {
        const body = JSON.parse(init?.body as string) as { text: string }
        const isUrl = /^https?:\/\//u.test(body.text)
        return json({
          ok: true,
          result: {
            kind: isUrl ? 'url' : 'package',
            target: isUrl ? body.text : body.text.match(/@[\w-]+\/[\w-]+/u)?.[0] ?? 'find-skills',
            result: {},
          },
        })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('内置技能')
    expect(screen.getByText('想装什么？')).toBeTruthy()
    const source = screen.getByLabelText('安装说明')
    const sentence = '请根据 https://skillhub.cn/install/skillhub.md，安装 @acme/pkg-skill。'
    fireEvent.change(source, { target: { value: sentence } })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByText('已安装 @acme/pkg-skill（包名）')).toBeTruthy()
    fireEvent.change(source, { target: { value: 'https://github.com/acme/skill' } })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByText('已安装 https://github.com/acme/skill（链接）')).toBeTruthy()
    fireEvent.change(source, { target: { value: '@acme/pkg-skill' } })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/install-any'))
      expect(calls).toHaveLength(3)
      expect(JSON.parse((calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
        projectId: 'p1', actorSessionId: 'w1', text: sentence,
      })
    })
    expect(openSkillAdminSession).not.toHaveBeenCalled()
  })

  it('shows the unsupported result and asks a worker to contact a supervisor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_INSTRUCTION_UNSUPPORTED', message: 'ambiguous request' })
    }))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('内置技能')
    fireEvent.change(screen.getByLabelText('安装说明'), { target: { value: '安装 aaa-bbb 和 ccc-ddd' } })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByText('这条安装说明无法自动解析，需要人工判断。')).toBeTruthy()
    expect(screen.getByText('请联系主管，由技能管理员处理。')).toBeTruthy()
  })

  it('shows a readable error for other install failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_INSTALL_PACKAGE_FAILED', message: 'download failed' })
    }))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('内置技能')
    fireEvent.change(screen.getByLabelText('安装说明'), { target: { value: '@acme/pkg-skill' } })
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(await screen.findByText(/SKILL_INSTALL_PACKAGE_FAILED/)).toBeTruthy()
  })

  it('does not block installation when the project has no supervisor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: ENTRIES })))
    const props = pageProps('worker')
    const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector({
      status: 'ready',
      members: [{ sessionId: 'w1', role: 'worker', displayName: '员工', state: 'available' }],
      error: null,
    })) as never
    render(<CadreSkillLibraryPage {...{ ...props, useRoster }} />)
    await screen.findByText('内置技能')
    expect(screen.getByLabelText('安装说明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
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

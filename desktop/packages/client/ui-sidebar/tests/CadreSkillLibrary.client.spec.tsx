// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
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
    t: translate,
  } as ComponentProps<typeof CadreSkillLibraryPage>
}

function catalogFetch(entries = ENTRIES, health?: unknown) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = requestUrl(input)
    if (url.endsWith('/catalog')) return json({ ok: true, result: entries })
    if (url.endsWith('/admin/diag')) return json({ ok: true, result: health ?? { packs: { total: 0, ok: 0, warning: 0, error: 0 } } })
    return json({ ok: true, result: {} })
  })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('uses conversation commands without dedicated session requests and still deletes installed skills', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/diag')) return json({ ok: true, result: {} })
      return json({ ok: true, result: { removed: true } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByText('在任意对话中使用技能')).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.find'])).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.install'])).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.create'])).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.check'])).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => /\/admin\/sessions?$/u.test(requestUrl(input)))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(true)
    })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({ actorSessionId: 'w1', targetSessionId: 'w1' })
  })

  it('groups built-ins and installed skills, localizes descriptions, and keeps built-ins read-only', async () => {
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByText('已安装')).toBeTruthy()
    expect(screen.getByText('落地页设计：信息结构、转化文案、视觉规范、状态与上线检查。')).toBeTruthy()
    expect(screen.queryByText('English landing page description')).toBeNull()
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    fireEvent.click(screen.getAllByText('详情')[0]!)
    expect(screen.getByText('约 100 tokens')).toBeTruthy()
    expect(screen.getByText('作者：Elaya')).toBeTruthy()
    expect(screen.getAllByText('许可：MIT').length).toBeGreaterThan(0)
    const link = screen.getByRole('link', { name: '上游主页' })
    expect(link.getAttribute('href')).toBe('https://example.test/ai-design')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders ok, warning and error health with expandable code and remediation', async () => {
    const entries = [...ENTRIES, {
      id: 'broken-skill', name: '异常技能', description: '需要修复', roles: ['worker'], tokenEstimate: 20,
      tools: [], origin: 'installed', source: 'local', license: 'MIT', selected: false,
    }]
    const health = {
      status: 'error',
      items: [
        { packId: 'ai-design', status: 'ok', issues: [] },
        { packId: 'worker-only', status: 'warning', issues: [{ code: 'PACK_METADATA_INVALID', message: 'tokenEstimate 无效', remediation: '将 tokenEstimate 修正为非负整数后重查', field: 'tokenEstimate' }] },
        { packId: 'broken-skill', status: 'error', issues: [{ code: 'PACK_CONTENT_MISSING', message: '缺少 SKILL.md', remediation: '补充 SKILL.md 后再次运行 skill_check' }] },
      ],
    }
    vi.stubGlobal('fetch', catalogFetch(entries, health))
    render(<CadreSkillLibraryPage {...pageProps()} />)
    expect(await screen.findByText('健康')).toBeTruthy()
    expect(screen.getByText('有警告')).toBeTruthy()
    expect(screen.getByText('有异常')).toBeTruthy()
    const summaries = await screen.findAllByText('发现 1 个问题')
    const details = summaries[0]!.closest('details')
    expect(details?.hasAttribute('open')).toBe(false)
    fireEvent.click(summaries[0]!)
    expect(details?.hasAttribute('open')).toBe(true)
    expect(screen.getByText('PACK_METADATA_INVALID')).toBeTruthy()
    expect(screen.getByText('字段：tokenEstimate')).toBeTruthy()
    expect(screen.getByText('将 tokenEstimate 修正为非负整数后重查')).toBeTruthy()
    fireEvent.click(summaries[1]!)
    expect(screen.getByText('PACK_CONTENT_MISSING')).toBeTruthy()
    expect(screen.getByText('补充 SKILL.md 后再次运行 skill_check')).toBeTruthy()
  })

  it('keeps an ordinary session catalog visible without a page alert when health is forbidden', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_ADMIN_FORBIDDEN', message: 'denied' }, 403)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect((await screen.findAllByText('未检查')).length).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('skill_check({ packId: "ai-design" })')).toBeTruthy()
    expect(screen.getByText('skill_check({ packId: "worker-only" })')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^安装$/u })).toBeTruthy()
  })

  it('degrades totals-only health responses to per-skill skill_check instructions', async () => {
    vi.stubGlobal('fetch', catalogFetch(ENTRIES, { packs: { total: 2, ok: 1, warning: 1, error: 0 } }))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect((await screen.findAllByText('暂时无法读取健康状态；在当前对话运行：')).length).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('copies exact conversation commands and reports clipboard failure without replacing the text', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { language: 'zh-CN', clipboard: { writeText } })
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    const command = screen.getByText(zh['skills.commands.find'])
    const row = command.parentElement?.parentElement as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '复制' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(zh['skills.commands.find']) })
    expect(within(row).getByRole('button', { name: '已复制' })).toBeTruthy()
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(within(row).getByRole('button', { name: '已复制' }))
    expect(await within(row).findByText('复制失败，请选中指令文本手动复制。')).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.find'])).toBeTruthy()
  })

  it('shows warnings and a copyable confirm:true instruction without retrying a dropped confirmation', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { language: 'zh-CN', clipboard: { writeText } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/diag')) return json({ ok: true, result: {} })
      if (url.endsWith('/install-any')) return json({ ok: true, result: {
        kind: 'package', target: '@scope/name', installed: false, requiresConfirmation: true,
        warnings: ['missing-license', 'missing-hash'],
        preview: { name: 'Scoped skill', source: 'skillhub:@scope/name', license: 'unknown', author: 'Author', hasHash: false },
      } })
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.change(screen.getByLabelText('直接安装（URL 或包名）'), { target: { value: '@scope/name' } })
    fireEvent.click(screen.getByRole('button', { name: /^安装$/u }))
    expect(await screen.findByText('需要主管核对后确认')).toBeTruthy()
    expect(screen.getByText('missing-license')).toBeTruthy()
    expect(screen.getByText('缺少许可信息')).toBeTruthy()
    expect(screen.getByText('请先核对上游许可，再由主管确认是否安装。')).toBeTruthy()
    expect(screen.getByText('missing-hash')).toBeTruthy()
    expect(screen.getByText('Scoped skill')).toBeTruthy()
    const command = 'skill_install({ name: "@scope/name", confirm: true })'
    const commandElement = screen.getByText(command)
    const row = commandElement.parentElement?.parentElement as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '复制' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(command) })
    expect(confirm).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/install-any'))).toHaveLength(1)
    const installCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/install-any'))
    expect(JSON.parse((installCall?.[1] as RequestInit).body as string)).not.toHaveProperty('confirm')
  })

  it('shows successful install warnings with code and Chinese remediation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/diag')) return json({ ok: true, result: {} })
      if (url.endsWith('/install-any')) return json({ ok: true, result: {
        kind: 'package', target: '@scope/name', installed: true, warnings: ['unknown-source'],
        result: { name: '@scope/name', visible: true, durationMs: 1, installed: true, warnings: ['unknown-source'] },
      } })
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.change(screen.getByLabelText('直接安装（URL 或包名）'), { target: { value: '@scope/name' } })
    fireEvent.click(screen.getByRole('button', { name: /^安装$/u }))
    expect(await screen.findByText('已安装 @scope/name（包名）')).toBeTruthy()
    expect(screen.getByText('unknown-source')).toBeTruthy()
    expect(screen.getByText('来源或作者未知')).toBeTruthy()
    expect(screen.getByText('请先检查上游主页与 SKILL.md，确认可信后再安装。')).toBeTruthy()
    expect(screen.queryByText('需要主管核对后确认')).toBeNull()
  })

  it('retains install failure code, message and actionable remediation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/diag')) return json({ ok: true, result: {} })
      if (url.endsWith('/install-any')) return json({ ok: false, code: 'SKILL_WRITE_FAILED', message: '技能目录不可写' }, 500)
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.change(screen.getByLabelText('直接安装（URL 或包名）'), { target: { value: '@scope/name' } })
    fireEvent.click(screen.getByRole('button', { name: /^安装$/u }))
    expect(await screen.findByText('SKILL_WRITE_FAILED')).toBeTruthy()
    expect(screen.getByText('技能目录不可写')).toBeTruthy()
    expect(screen.getByText('检查目录权限和磁盘空间，运行 skill_check 确认状态后重试。')).toBeTruthy()
    expect(screen.getByText('员工技能')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('keeps commands and recovery available when the catalog returns SKILL_FORBIDDEN', async () => {
    let catalogCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/catalog')) {
        catalogCalls += 1
        return catalogCalls === 1 ? json({ ok: false, code: 'SKILL_FORBIDDEN', message: 'denied' }) : json({ ok: true, result: ENTRIES })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText(zh['skills.admin.error.forbidden'])).toBeTruthy()
    expect(screen.getByText('SKILL_FORBIDDEN')).toBeTruthy()
    expect(screen.getByText(zh['skills.remediation.forbidden'])).toBeTruthy()
    expect(screen.getByText(zh['skills.commands.install'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['skills.library.retry'] }))
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(catalogCalls).toBe(2)
    expect(screen.queryByText(zh['skills.admin.error.forbidden'])).toBeNull()
  })

  it('shows the full page outside the roster under the foreground session id', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      if (url.endsWith('/admin/diag')) return json({ ok: true, result: {} })
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
    expect(screen.getByRole('button', { name: /^安装$/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: '高级手动表单' })).toBeTruthy()
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({ projectId: 'p1', actorSessionId: 'plain', targetSessionId: 'plain' })
    expect(fetchMock.mock.calls.some(([input]) => /\/admin\/sessions?$/u.test(requestUrl(input)))).toBe(false)
  })

  it('keeps the read-only fallback when no project exists at all', () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{ ...props, projectOfSession: () => undefined, defaultProjectId: () => undefined }} />)
    expect(screen.getByText('当前没有可用项目或会话，暂时无法读取技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^安装$/u })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the read-only fallback when no foreground session or usable member exists', () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) => selector({ byId: {} })) as never,
      useRoster: ((selector: (value: CadreRosterState) => unknown) => selector({
        status: 'ready', members: [{ sessionId: 'gone', role: 'supervisor', displayName: '前主管', state: 'departed' }], error: null,
      })) as never,
      projectOfSession: (sessionId: string) => (sessionId === 'gone' ? 'p1' : undefined),
      defaultProjectId: () => 'p1',
    }} />)
    expect(screen.getByText('当前没有可用项目或会话，暂时无法读取技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^安装$/u })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses an available project member when no foreground session exists', async () => {
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) => selector({ byId: {} })) as never,
      defaultProjectId: () => 'p1',
    }} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^安装$/u })).toBeTruthy()
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({ projectId: 'p1', actorSessionId: 'sup', targetSessionId: 'sup' })
  })

  it('shows an inline empty state when the library has no skills', async () => {
    vi.stubGlobal('fetch', catalogFetch([]))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('还没有技能，可在当前对话查找或安装技能。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^安装$/u })).toBeTruthy()
  })

  it('requires confirmation before deleting a skill', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(false)
  })

  it('localizes built-in descriptions and conversation instructions in English', async () => {
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('supervisor', tEn)} />)
    expect(await screen.findByText('Landing-page design: information structure, conversion copy, visual rules, states, and ship checks.')).toBeTruthy()
    expect(screen.getByText('Use skills in any conversation')).toBeTruthy()
    expect(screen.getByLabelText('Direct install (URL or package)')).toBeTruthy()
  })

  it('keeps sources and the folded manual form available', async () => {
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    const sources = document.querySelector('[data-skill-sources]')
    expect(sources).not.toBeNull()
    expect(sources!.querySelectorAll('a')).toHaveLength(4)
    for (const link of sources!.querySelectorAll('a')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(screen.getByText('第三方技能请先审查再安装。')).toBeTruthy()
    expect(screen.queryByLabelText('技能 id')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '高级手动表单' }))
    expect(screen.getByLabelText('技能 id')).toBeTruthy()
  })
})

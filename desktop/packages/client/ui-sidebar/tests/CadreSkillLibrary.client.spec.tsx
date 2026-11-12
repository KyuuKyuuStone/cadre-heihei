// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CadreSkillLibraryPage } from '../src/client/CadreSkillLibrary.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { en, zh } from '../src/client/locales.ts'

const ENTRIES = [
  { id: 'ai-design', name: 'AI Design', description: 'English landing page description', roles: ['worker'], tokenEstimate: 100, tools: ['read'], origin: 'builtin', source: 'builtin', author: 'Elaya', license: 'MIT', selected: false },
  { id: 'worker-only', name: '员工技能', description: '只给员工', roles: ['worker'], tokenEstimate: 10, tools: [], origin: 'installed', source: 'local', license: 'MIT', selected: false },
]

const translate = (dictionary: Record<string, string>) => ((key: string, params?: Record<string, unknown>) => {
  let text = dictionary[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never
const t = translate(zh)
const tEn = translate(en)

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function bindingResponse(sessionId = 'bound-session'): Response {
  return json({ ok: true, result: { sessionId, title: 'Skill conversation', projectId: 'p1' } })
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
    openSession: vi.fn(),
    t: translate,
  } as ComponentProps<typeof CadreSkillLibraryPage>
}

function projectProps(sessionId: string, projectId: string, openSession: (sessionId: string) => void = vi.fn()) {
  return {
    ...pageProps(),
    useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
      selector({ byId: { [sessionId]: { retainedBy: { mainView: 1 } } } })) as never,
    projectOfSession: () => projectId,
    openSession,
  } as ComponentProps<typeof CadreSkillLibraryPage>
}

function catalogFetch(
  entries = ENTRIES,
  health?: unknown,
  onBind?: (init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    if (url.endsWith('/catalog')) return json({ ok: true, result: entries })
    if (url.endsWith('/admin/diag')) {
      return json({ ok: true, result: health ?? { status: 'ok', items: entries.map(entry => ({ packId: entry.id, status: 'ok', issues: [] })) } })
    }
    if (url.endsWith('/admin/bind-session')) return await onBind?.(init) ?? json({ ok: false, code: 'UNEXPECTED_BIND', message: 'unexpected' }, 500)
    if (url.endsWith('/remove')) return json({ ok: true, result: { removed: true } })
    return json({ ok: false, code: 'UNEXPECTED_REQUEST', message: url }, 500)
  })
}

function requestBody(fetchMock: ReturnType<typeof catalogFetch>, suffix: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith(suffix))
  expect(call, suffix).toBeDefined()
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>
}

function skillCard(id: string): HTMLElement {
  const element = document.querySelector(`[data-skill-id="${id}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`Missing skill card ${id}`)
  return element
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill library', () => {
  it('binds the header action with the reserved id and opens the returned session', async () => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => bindingResponse('install-session'))
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps('worker'), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '对话安装新技能' }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('install-session') })
    expect(requestBody(fetchMock, '/admin/bind-session')).toEqual({
      projectId: 'p1', skillId: '__install__', skillName: '对话安装新技能',
    })
    expect(openSession).toHaveBeenCalledTimes(1)
  })

  it('binds a card with its real pack id and exact display name', async () => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => bindingResponse('worker-session'))
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(within(skillCard('worker-only')).getByRole('button', { name: '对话使用' }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('worker-session') })
    expect(requestBody(fetchMock, '/admin/bind-session')).toEqual({
      projectId: 'p1', skillId: 'worker-only', skillName: '员工技能',
    })
  })

  it('allows one binding at a time and disables conflicting actions until it settles', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = catalogFetch(ENTRIES, undefined, async () => {
      await gate
      return bindingResponse('single-session')
    })
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(within(skillCard('worker-only')).getByRole('button', { name: '对话使用' }))
    await screen.findByRole('button', { name: '正在进入对话…' })
    const opening = within(skillCard('worker-only')).getByRole('button', { name: '正在进入对话…' }) as HTMLButtonElement
    const other = within(skillCard('ai-design')).getByRole('button', { name: '对话使用' }) as HTMLButtonElement
    const remove = within(skillCard('worker-only')).getByRole('button', { name: '删除' }) as HTMLButtonElement
    expect(opening.disabled).toBe(true)
    expect(other.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    fireEvent.click(other)
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/admin/bind-session'))).toHaveLength(1)
    release()
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('single-session') })
    expect(openSession).toHaveBeenCalledTimes(1)
  })

  it('ignores a pending bind completion after the project changes', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = catalogFetch(ENTRIES, undefined, async () => {
      await gate
      return bindingResponse('old-project-session')
    })
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<CadreSkillLibraryPage {...projectProps('s1', 'p1', openSession)} />)
    await screen.findByText('员工技能')
    fireEvent.click(within(skillCard('worker-only')).getByRole('button', { name: '对话使用' }))
    await screen.findByRole('button', { name: '正在进入对话…' })
    view.rerender(<CadreSkillLibraryPage {...projectProps('s2', 'p2', openSession)} />)
    await waitFor(() => {
      const catalogBodies = fetchMock.mock.calls
        .filter(([input]) => requestUrl(input).endsWith('/catalog'))
        .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { projectId: string })
      expect(catalogBodies.some(body => body.projectId === 'p2')).toBe(true)
    })
    await act(async () => {
      release()
      await gate
      await Promise.resolve()
    })
    expect(openSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a pending bind completion after unmount', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = catalogFetch(ENTRIES, undefined, async () => {
      await gate
      return bindingResponse('unmounted-session')
    })
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(within(skillCard('worker-only')).getByRole('button', { name: '对话使用' }))
    await screen.findByRole('button', { name: '正在进入对话…' })
    view.unmount()
    await act(async () => {
      release()
      await gate
      await Promise.resolve()
    })
    expect(openSession).not.toHaveBeenCalled()
  })

  it.each([
    { code: 'SKILL_BIND_DELETE_FAILED', status: 502, message: 'skills.bind.error.deleteFailed', remediation: 'skills.bind.remediation.deleteFailed' },
    { code: 'SKILL_BIND_SESSION_FAILED', status: 500, message: 'skills.bind.error.sessionFailed', remediation: 'skills.bind.remediation.sessionFailed' },
    { code: 'SKILL_ADMIN_DELETE_UNSUPPORTED', status: 501, message: 'skills.bind.error.deleteUnsupported', remediation: 'skills.bind.remediation.deleteUnsupported' },
  ] as const)('contains $code on the initiating card with localized recovery', async ({ code, status, message, remediation }) => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => json({ ok: false, code, message: 'backend detail' }, status))
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    const card = skillCard('worker-only')
    fireEvent.click(within(card).getByRole('button', { name: '对话使用' }))
    const alert = await within(card).findByRole('alert')
    expect(within(alert).getByText(code)).toBeTruthy()
    expect(within(alert).getByText(zh[message])).toBeTruthy()
    expect(within(alert).getByText(zh[remediation])).toBeTruthy()
    expect(within(skillCard('ai-design')).queryByRole('alert')).toBeNull()
    expect(openSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('clears a header binding failure on a successful retry', async () => {
    let attempts = 0
    const fetchMock = catalogFetch(ENTRIES, undefined, () => {
      attempts += 1
      return attempts === 1
        ? json({ ok: false, code: 'SKILL_PROJECT_REQUIRED', message: 'missing project' }, 400)
        : bindingResponse('retry-session')
    })
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '对话安装新技能' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(zh['skills.bind.error.projectRequired'])).toBeTruthy()
    expect(within(alert).getByText(zh['skills.bind.remediation.projectRequired'])).toBeTruthy()
    expect(within(skillCard('worker-only')).queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '对话安装新技能' }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('retry-session') })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('maps a transport rejection to the generic binding notice without opening a session', async () => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => { throw new TypeError('offline') })
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '对话安装新技能' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(zh['skills.bind.error.sessionFailed'])).toBeTruthy()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('reports navigation failure without misreporting the committed bind', async () => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => bindingResponse('committed-session'))
    const openSession = vi.fn(() => { throw new Error('navigation unavailable') })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps(), openSession }} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '对话安装新技能' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('SKILL_SESSION_OPEN_FAILED')).toBeTruthy()
    expect(within(alert).getByText(zh['skills.bind.error.openFailed'])).toBeTruthy()
    expect(within(alert).getByText(zh['skills.bind.remediation.openFailed'])).toBeTruthy()
    expect(within(alert).queryByText(zh['skills.bind.error.sessionFailed'])).toBeNull()
    expect(openSession).toHaveBeenCalledWith('committed-session')
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/admin/bind-session'))).toHaveLength(1)
  })

  it('groups skills, localizes descriptions, and renders conversation actions and metadata', async () => {
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByText('已安装')).toBeTruthy()
    expect(screen.getByText('落地页设计：信息结构、转化文案、视觉规范、状态与上线检查。')).toBeTruthy()
    expect(screen.queryByText('English landing page description')).toBeNull()
    expect(screen.getAllByRole('button', { name: '对话使用' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    expect(screen.getByText('约 100 tokens')).toBeTruthy()
    expect(screen.getByText('作者：Elaya')).toBeTruthy()
    expect(screen.getAllByText('许可：MIT')).toHaveLength(2)
    expect(document.querySelector('input, textarea, select, form, code, pre')).toBeNull()
  })

  it.each([
    { locale: 'zh-CN', dictionary: zh, translate: t },
    { locale: 'en-US', dictionary: en, translate: tEn },
  ])('renders four safe external source links and a caution in $locale', async ({ dictionary, translate }) => {
    vi.stubGlobal('fetch', catalogFetch())
    render(<CadreSkillLibraryPage {...pageProps('worker', translate)} />)
    await screen.findByText('员工技能')
    const sources = screen.getByRole('navigation', { name: dictionary['skills.sources.label'] })
    expect(within(sources).getByText(dictionary['skills.sources.label'])).toBeTruthy()
    const expected = [
      ['skillhub', 'https://skillhub.cn'],
      ['clawhub', 'https://clawhub.ai'],
      ['aiDesign', 'https://github.com/elayadesign/ai-design-skills'],
      ['githubTopic', 'https://github.com/topics/agent-skills'],
    ] as const
    for (const [key, href] of expected) {
      const link = within(sources).getByRole('link', { name: dictionary[`skills.sources.${key}`] })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')?.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
    }
    expect(sources.querySelectorAll('a')).toHaveLength(4)
    expect(within(sources).getByText(dictionary['skills.sources.caution'])).toBeTruthy()
    expect(sources.querySelector('button, input, textarea, select, form, code, pre')).toBeNull()
  })

  it('renders health states with expandable issue details', async () => {
    const entries = [...ENTRIES, {
      id: 'broken-skill', name: '异常技能', description: '需要修复', roles: ['worker'], tokenEstimate: 20,
      tools: [], origin: 'installed', source: 'local', license: 'MIT', selected: false,
    }]
    const health = {
      status: 'error',
      items: [
        { packId: 'ai-design', status: 'ok', issues: [] },
        { packId: 'worker-only', status: 'warning', issues: [{ code: 'PACK_METADATA_INVALID', message: 'tokenEstimate 无效', remediation: '将 tokenEstimate 修正为非负整数后重查', field: 'tokenEstimate' }] },
        { packId: 'broken-skill', status: 'error', issues: [{ code: 'PACK_CONTENT_MISSING', message: '缺少技能正文', remediation: '补充技能正文后重试' }] },
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
    expect(screen.getByText('补充技能正文后重试')).toBeTruthy()
  })

  it('marks packs omitted from a partial health response as not checked', async () => {
    const health = { status: 'ok', items: [{ packId: 'ai-design', status: 'ok', issues: [] }] }
    vi.stubGlobal('fetch', catalogFetch(ENTRIES, health))
    render(<CadreSkillLibraryPage {...pageProps()} />)
    await screen.findByText('员工技能')
    expect(await within(skillCard('ai-design')).findByText('健康')).toBeTruthy()
    expect(within(skillCard('worker-only')).getByText('未检查')).toBeTruthy()
    expect(within(skillCard('worker-only')).getByText(zh['skills.health.unavailable'])).toBeTruthy()
    expect(screen.queryByText('有警告')).toBeNull()
  })

  it('keeps the ordinary-session catalog visible when health is forbidden', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) return json({ ok: true, result: ENTRIES })
      return json({ ok: false, code: 'SKILL_ADMIN_FORBIDDEN', message: 'denied' }, 403)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect((await screen.findAllByText('未检查'))).toHaveLength(2)
    expect(screen.getAllByText(zh['skills.health.unavailable'])).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '对话安装新技能' })).toBeTruthy()
  })

  it('degrades totals-only health responses without replacing the catalog', async () => {
    vi.stubGlobal('fetch', catalogFetch(ENTRIES, { packs: { total: 2, ok: 1, warning: 1, error: 0 } }))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect((await screen.findAllByText(zh['skills.health.unavailable']))).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains the header action and recovers after a catalog failure', async () => {
    let catalogCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) {
        catalogCalls += 1
        return catalogCalls === 1 ? json({ ok: false, code: 'SKILL_FORBIDDEN', message: 'denied' }) : json({ ok: true, result: ENTRIES })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText('SKILL_FORBIDDEN')).toBeTruthy()
    expect(screen.getByText(zh['skills.admin.error.forbidden'])).toBeTruthy()
    expect(screen.getByText(zh['skills.library.forbiddenRemediation'])).toBeTruthy()
    expect(screen.queryByText('denied')).toBeNull()
    expect(screen.getByRole('button', { name: '对话安装新技能' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(catalogCalls).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores an old project catalog response without clearing the current loading state', async () => {
    let resolveOld: (response: Response) => void = () => {}
    let resolveCurrent: (response: Response) => void = () => {}
    const oldCatalog = new Promise<Response>(resolve => { resolveOld = resolve })
    const currentCatalog = new Promise<Response>(resolve => { resolveCurrent = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).endsWith('/catalog')) {
        const body = JSON.parse(init?.body as string) as { projectId: string }
        return body.projectId === 'p1' ? await oldCatalog : await currentCatalog
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<CadreSkillLibraryPage {...projectProps('s1', 'p1')} />)
    await waitFor(() => { expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/catalog'))).toBe(true) })
    view.rerender(<CadreSkillLibraryPage {...projectProps('s2', 'p2')} />)
    await waitFor(() => {
      const projects = fetchMock.mock.calls
        .filter(([input]) => requestUrl(input).endsWith('/catalog'))
        .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { projectId: string })
      expect(projects.some(body => body.projectId === 'p2')).toBe(true)
    })
    await act(async () => {
      resolveOld(json({ ok: true, result: [{ ...ENTRIES[0]!, id: 'old-skill', name: '旧项目技能' }] }))
      await oldCatalog
      await Promise.resolve()
    })
    expect(screen.queryByText('旧项目技能')).toBeNull()
    expect((screen.getByRole('button', { name: '对话安装新技能' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolveCurrent(json({ ok: true, result: [{ ...ENTRIES[0]!, id: 'current-skill', name: '新项目技能' }] }))
      await currentCatalog
      await Promise.resolve()
    })
    expect(await screen.findByText('新项目技能')).toBeTruthy()
    expect(screen.queryByText('旧项目技能')).toBeNull()
    expect((screen.getByRole('button', { name: '对话安装新技能' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the loading state and enables the header after the catalog settles', async () => {
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/catalog')) {
        await gate
        return json({ ok: true, result: ENTRIES })
      }
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps()} />)
    expect(await screen.findByText('正在加载技能库…')).toBeTruthy()
    expect((screen.getByRole('button', { name: '对话安装新技能' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect((screen.getByRole('button', { name: '对话安装新技能' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('deletes an installed skill after confirmation and reloads the catalog', async () => {
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect((await screen.findByRole('status')).textContent).toBe('技能已删除。')
    expect(requestBody(fetchMock, '/remove')).toEqual({ projectId: 'p1', actorSessionId: 'w1', packId: 'worker-only', confirm: true })
    expect(fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith('/catalog'))).toHaveLength(2)
    expect(requestBody(fetchMock, '/catalog')).toMatchObject({ actorSessionId: 'w1', targetSessionId: 'w1' })
  })

  it('clears a previous deletion notice when a later deletion fails', async () => {
    let removals = 0
    const baseFetch = catalogFetch()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).endsWith('/remove')) {
        removals += 1
        return removals === 1
          ? json({ ok: true, result: { removed: true } })
          : json({ ok: false, code: 'SKILL_WRITE_FAILED', message: 'disk full' }, 500)
      }
      return await baseFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect((await screen.findByRole('status')).textContent).toBe('技能已删除。')
    await waitFor(() => { expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('disk full')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('requires confirmation before deleting a skill', async () => {
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    await screen.findByText('员工技能')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/remove'))).toBe(false)
  })

  it('uses the foreground ordinary session outside the roster', async () => {
    const fetchMock = catalogFetch()
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{
      ...props,
      useSessions: ((selector: (value: { byId: Record<string, unknown> }) => unknown) =>
        selector({ byId: { plain: { retainedBy: { mainView: 1 } } } })) as never,
      projectOfSession: () => undefined,
      defaultProjectId: () => 'p1',
    }} />)
    expect(await screen.findByText('内置技能')).toBeTruthy()
    expect(screen.getByRole('button', { name: '对话安装新技能' })).toBeTruthy()
    expect(requestBody(fetchMock, '/catalog')).toMatchObject({ projectId: 'p1', actorSessionId: 'plain', targetSessionId: 'plain' })
  })

  it('keeps the read-only fallback when no project exists', () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const props = pageProps('worker')
    render(<CadreSkillLibraryPage {...{ ...props, projectOfSession: () => undefined, defaultProjectId: () => undefined }} />)
    expect(screen.getByText('当前没有可用项目或会话，暂时无法读取技能。')).toBeTruthy()
    const sources = screen.getByRole('navigation', { name: '去哪里找技能：' })
    expect(within(sources).getAllByRole('link')).toHaveLength(4)
    expect(within(sources).getByText('第三方技能请先审查再安装。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '对话安装新技能' })).toBeNull()
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
    const sources = screen.getByRole('navigation', { name: '去哪里找技能：' })
    expect(within(sources).getAllByRole('link')).toHaveLength(4)
    expect(within(sources).getByText('第三方技能请先审查再安装。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '对话安装新技能' })).toBeNull()
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
    expect(requestBody(fetchMock, '/catalog')).toMatchObject({ projectId: 'p1', actorSessionId: 'sup', targetSessionId: 'sup' })
  })

  it('shows an inline empty state with the conversation install action', async () => {
    vi.stubGlobal('fetch', catalogFetch([]))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByText(zh['skills.library.empty'])).toBeTruthy()
    expect(screen.getByRole('button', { name: '对话安装新技能' })).toBeTruthy()
  })

  it('localizes descriptions and the header binding title in English', async () => {
    const fetchMock = catalogFetch(ENTRIES, undefined, () => bindingResponse('english-session'))
    const openSession = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...{ ...pageProps('supervisor', tEn), openSession }} />)
    expect(await screen.findByText(en['skills.desc.ai-design'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['skills.library.installConversation'] }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith('english-session') })
    expect(requestBody(fetchMock, '/admin/bind-session')).toEqual({
      projectId: 'p1', skillId: '__install__', skillName: en['skills.library.installConversation'],
    })
    expect(screen.getAllByRole('button', { name: en['skills.library.useConversation'] })).toHaveLength(2)
  })
})

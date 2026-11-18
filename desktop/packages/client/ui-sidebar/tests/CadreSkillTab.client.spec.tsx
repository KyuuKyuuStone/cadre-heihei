// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreSkillTab } from '../src/client/CadreSkillTab.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh, params?: Record<string, unknown>) => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value))
  return text
}) as never

const roster: CadreRosterState = {
  status: 'ready',
  members: [
    { sessionId: 'sup', role: 'supervisor', displayName: '主管', state: 'available' },
    { sessionId: 'w1', role: 'worker', displayName: '前端', state: 'available' },
  ],
  error: null,
}
const ENTRIES = [
  { id: 'worker-skill', name: '员工技能', description: '', origin: 'builtin', roles: ['worker'], tokenEstimate: 10, tools: [], source: 's', license: 'MIT', selected: true },
  { id: 'sup-skill', name: '主管技能', description: '', origin: 'installed', roles: ['supervisor'], tokenEstimate: 20, tools: [], source: 's', license: 'MIT', selected: false },
]

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function props(
  sessionId: string,
  projectId: string | null = 'p1',
  fallbackProjectId: string | null = 'p1',
  rosterState: CadreRosterState = roster,
): ComponentProps<typeof CadreSkillTab> {
  return {
    sessionId,
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(rosterState)) as never,
    projectOfSession: () => projectId ?? undefined,
    defaultProjectId: () => fallbackProjectId ?? undefined,
    t,
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre skill tab', () => {
  it('lets a worker read and save their own selection', async () => {
    let catalogs = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: { skills: [] } })
      catalogs += 1
      return json({ ok: true, result: catalogs === 1 ? ENTRIES : ENTRIES.map(entry => ({ ...entry, selected: false })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('w1')} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect(screen.getByText('已选 1')).toBeTruthy()
    expect(document.querySelectorAll('[data-skill-card]')).toHaveLength(1)
    expect(screen.getByText('约 10 tokens')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '员工技能' }))
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    expect(await screen.findByText('本会话技能已保存。')).toBeTruthy()
    expect(screen.getByText('已选 0')).toBeTruthy()
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      actorSessionId: 'w1', targetSessionId: 'w1', skills: [],
    })
  })

  it('uses the current Session for a supervisor too, without a member switcher', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: { skills: [] } })
      return json({ ok: true, result: ENTRIES })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('sup')} />)
    expect(await screen.findByText('主管技能')).toBeTruthy()
    expect(screen.queryByLabelText('编辑成员')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
        actorSessionId: 'sup', targetSessionId: 'sup',
      })
    })
  })

  it('keeps preview available to a roster member', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/preview')) {
        return json({ ok: true, result: { id: 'worker-skill', content: '成员预览内容', tokenEstimate: 10, license: 'MIT' } })
      }
      return json({ ok: true, result: ENTRIES })
    }))
    render(<CadreSkillTab {...props('w1')} />)
    fireEvent.click(await screen.findByRole('button', { name: '预览' }))
    expect(await screen.findByText('成员预览内容')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起预览' }))
    expect(screen.queryByText('成员预览内容')).toBeNull()
  })

  it('shows the empty state when no skill is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillTab {...props('w1')} />)
    expect(await screen.findByText('还没有可用的技能。')).toBeTruthy()
    expect(document.querySelector('[data-skill-tab-empty]')).toBeTruthy()
  })

  it('lets an ordinary Session browse the full catalog without editing or preview controls', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('plain', null)} />)
    expect(await screen.findByText('员工技能')).toBeTruthy()
    expect(screen.getByText('主管技能')).toBeTruthy()
    expect(screen.getByText('内置技能')).toBeTruthy()
    expect(screen.getByText('已安装')).toBeTruthy()
    expect(screen.getByText('约 10 tokens')).toBeTruthy()
    expect(screen.getAllByText('MIT')).toHaveLength(2)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存技能' })).toBeNull()
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull()
    expect(screen.queryByText('勾选本会话使用的技能；只列内置与已安装。')).toBeNull()
    expect(screen.queryByText('已选 0')).toBeNull()
    const catalogCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/catalog'))
    const catalogBody = JSON.parse((catalogCall?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(catalogBody).toMatchObject({ projectId: 'p1', actorSessionId: 'plain' })
    expect(catalogBody).not.toHaveProperty('targetSessionId')
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/set'))).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/preview'))).toBe(false)
  })

  it('waits for roster readiness before choosing the role-filtered catalog', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: ENTRIES }))
    vi.stubGlobal('fetch', fetchMock)
    const loading: CadreRosterState = { ...roster, status: 'loading', members: [] }
    const view = render(<CadreSkillTab {...props('w1', 'p1', 'p1', loading)} />)
    expect(fetchMock).not.toHaveBeenCalled()
    view.rerender(<CadreSkillTab {...props('w1')} />)
    expect(await screen.findByRole('checkbox', { name: '员工技能' })).toBeTruthy()
    expect(screen.queryByText('主管技能')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toMatchObject({ actorSessionId: 'w1', targetSessionId: 'w1' })
  })

  it('does not treat a failed roster read as an ordinary Session', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const failed: CadreRosterState = { ...roster, status: 'error', members: [], error: 'ROSTER_READ_FAILED' }
    render(<CadreSkillTab {...props('plain', null, 'p1', failed)} />)
    expect(screen.getByRole('alert').textContent).toBe('ROSTER_READ_FAILED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores an ordinary catalog response that arrives after the roster catalog', async () => {
    const ordinaryResponse = deferred<Response>()
    const rosterResponse = deferred<Response>()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error('Unexpected catalog request')
    })
      .mockImplementationOnce(async () => ordinaryResponse.promise)
      .mockImplementationOnce(async () => rosterResponse.promise)
    vi.stubGlobal('fetch', fetchMock)
    const ordinary: CadreRosterState = { ...roster, members: [] }
    const view = render(<CadreSkillTab {...props('w1', 'p1', 'p1', ordinary)} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    view.rerender(<CadreSkillTab {...props('w1')} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    await act(async () => {
      rosterResponse.resolve(json({ ok: true, result: ENTRIES }))
      await rosterResponse.promise
    })
    expect(await screen.findByRole('checkbox', { name: '员工技能' })).toBeTruthy()
    await act(async () => {
      ordinaryResponse.resolve(json({ ok: true, result: ENTRIES }))
      await ordinaryResponse.promise
    })
    expect(document.querySelectorAll('[data-skill-card]')).toHaveLength(1)
    expect(screen.queryByText('主管技能')).toBeNull()
    const firstBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(firstBody).not.toHaveProperty('targetSessionId')
    expect(secondBody).toMatchObject({ targetSessionId: 'w1' })
  })

  it('shows noProject for an ordinary Session when no project can be resolved', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillTab {...props('plain', null, null)} />)
    expect(screen.getByText('无法确定本会话所属项目部，暂不能读取技能。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存技能' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CadreSkillLibraryPage } from '../src/client/CadreSkillLibrary.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

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
function pageProps(role: 'supervisor' | 'worker'): ComponentProps<typeof CadreSkillLibraryPage> {
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
    t,
  } as unknown as ComponentProps<typeof CadreSkillLibraryPage>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('Cadre skill chat', () => {
  it('creates and binds an admin session, then shows the empty state', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.endsWith('/admin/sessions')) return json({ ok: true, result: [] })
      if (url.endsWith('/admin/session')) {
        return json({ ok: true, result: { sessionId: 'chat-1', title: '技能管理员', updatedAt: 1 } })
      }
      if (url.endsWith('/admin/messages')) return json({ ok: true, result: { messages: [], nextSeq: 0 } })
      return json({ ok: true, result: {} })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('supervisor')} />)
    expect(await screen.findByText('还没有对话，可以这样问：')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/admin/session'))).toBe(true)
    expect(localStorage.getItem('cadre.skillAdmin.operator.chat-1')).toBe('sup')
  })

  it('sends a message and renders incremental assistant/tool results', async () => {
    let sent = false
    let afterSeen = -1
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/admin/sessions')) {
        return json({ ok: true, result: [{ sessionId: 'chat-1', title: '技能管理员', updatedAt: 1 }] })
      }
      if (url.endsWith('/admin/message')) {
        sent = true
        expect(JSON.parse(init?.body as string)).toMatchObject({
          projectId: 'p1', operatorSessionId: 'sup', sessionId: 'chat-1', text: '安装 @scope/name',
        })
        return json({ ok: true, result: { accepted: true } })
      }
      if (url.endsWith('/admin/messages')) {
        const body = JSON.parse(init?.body as string) as { afterSeq: number }
        afterSeen = body.afterSeq
        return json({
          ok: true,
          result: sent
            ? {
              messages: [
                { seq: 1, role: 'user', text: '安装 @scope/name', time: 1 },
                { seq: 2, role: 'assistant', text: '已安装 @scope/name（包名）。', time: 2 },
              ],
              nextSeq: 3,
            }
            : { messages: [], nextSeq: 0 },
        })
      }
      return json({ ok: true, result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('supervisor')} />)
    const input = await screen.findByPlaceholderText('问技能、装技能，或贴一个链接…')
    fireEvent.change(input, { target: { value: '安装 @scope/name' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('已安装 @scope/name（包名）。')).toBeTruthy()
    expect(screen.getAllByText('安装 @scope/name').length).toBeGreaterThan(0)
    expect(afterSeen).toBe(0)
  })

  it('shows an error with retry when the admin service is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/admin/sessions')) {
        return json({ ok: false, code: 'SKILL_ADMIN_UNAVAILABLE', message: 'no service' })
      }
      return json({ ok: true, result: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreSkillLibraryPage {...pageProps('supervisor')} />)
    expect(await screen.findByText('技能管理员当前不可用：Host 未接入会话服务。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('keeps the direct install input for a worker instead of the chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: [] })))
    render(<CadreSkillLibraryPage {...pageProps('worker')} />)
    expect(await screen.findByLabelText('安装说明')).toBeTruthy()
    expect(screen.queryByText('技能助手')).toBeNull()
  })
})

// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreMcpTab } from '../src/client/CadreMcpTab.tsx'
import { fetchMcpCatalog, saveMcpSelection } from '../src/client/cadre-mcp.ts'
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
    { sessionId: 'sup', role: 'supervisor', displayName: '组长', state: 'available' },
    { sessionId: 'w1', role: 'worker', displayName: '前端', state: 'available' },
  ],
  error: null,
}

/**
 * Catalog fixture in the host's masked form: environment and header keys only.
 * `LITERAL_TOKEN` carries a literal override to prove the panel never renders it.
 */
const CATALOG = {
  servers: [
    {
      id: 'github',
      name: 'GitHub',
      description: 'GitHub 议题工具',
      transport: 'stdio',
      tags: ['dev'],
      envKeys: ['GITHUB_TOKEN', 'GITHUB_ORG', 'LITERAL_TOKEN', 'EMPTY_REF'],
      headerKeys: ['Authorization'],
      selected: true,
      enabled: true,
      overrides: {
        toolCallTimeoutMs: 30000,
        env: { GITHUB_TOKEN: { fromEnv: 'GH_OLD' }, LITERAL_TOKEN: 'sk-secret', EMPTY_REF: { fromEnv: '' } },
      },
    },
    {
      id: 'files',
      name: '文件系统',
      description: '本地文件工具',
      transport: 'stdio',
      tags: [],
      selected: true,
      enabled: true,
      overrides: {},
    },
    {
      id: 'legacy',
      name: '旧条目',
      description: '旧协议条目',
      transport: 'streamable-http',
      tags: [],
      envKeys: ['LEGACY_TOKEN'],
      headerKeys: [],
      selected: false,
      enabled: false,
      overrides: {},
    },
  ],
  health: [{ id: 'broken', state: 'invalid', detail: 'manifest.json 无效' }, { id: 'github', state: 'ok' }],
}

/** `set` echo: the persisted selection the host returns. */
const PERSISTED = {
  servers: [
    { id: 'github', enabled: true, overrides: { toolCallTimeoutMs: 90000, env: { GITHUB_TOKEN: { fromEnv: 'GH_TOKEN_ALT' } } } },
    { id: 'files', enabled: false },
    { id: 'legacy', enabled: true },
  ],
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
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
): ComponentProps<typeof CadreMcpTab> {
  return {
    sessionId,
    useRoster: ((selector: (value: CadreRosterState) => unknown) => selector(rosterState)) as never,
    projectOfSession: () => projectId ?? undefined,
    defaultProjectId: () => fallbackProjectId ?? undefined,
    t,
  }
}

function callOf(calls: readonly (readonly unknown[])[], suffix: string): Record<string, unknown> {
  const call = calls.find(entry => requestUrl(entry[0] as RequestInfo | URL).endsWith(suffix))
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Cadre MCP tab', () => {
  it('masks secret names, edits overrides, and saves the member selection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: PERSISTED })
      return json({ ok: true, result: CATALOG })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreMcpTab {...props('w1')} />)

    expect(await screen.findByText('GitHub')).toBeTruthy()
    expect(screen.getByText('已启用 2')).toBeTruthy()
    expect(document.querySelectorAll('[data-mcp-card]')).toHaveLength(3)
    // Masked names: environment and header keys only, never a value.
    expect(screen.getByText('环境变量 GITHUB_TOKEN')).toBeTruthy()
    expect(screen.getByText('引用 GH_OLD')).toBeTruthy()
    expect(screen.getByText('环境变量 GITHUB_ORG')).toBeTruthy()
    expect(screen.getAllByText('使用目录默认引用')).toHaveLength(2)
    expect(screen.getByText('请求头 Authorization')).toBeTruthy()
    // A literal override value and an empty reference are hidden, not rendered.
    expect(screen.getAllByText('已隐藏')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('sk-secret')
    // Invalid catalog rows are reported beside the usable ones.
    expect(screen.getByText('目录中有 1 个条目无法使用：broken')).toBeTruthy()
    // Manifest defaults are not exposed; the session override wins.
    const timeout = screen.getByLabelText('「GitHub」工具调用超时（毫秒）') as HTMLInputElement
    expect(timeout.value).toBe('30000')
    expect(timeout.placeholder).toBe('继承默认值')
    const filesTimeout = screen.getByLabelText('「文件系统」工具调用超时（毫秒）') as HTMLInputElement
    expect(filesTimeout.value).toBe('')
    const token = screen.getByLabelText('「GITHUB_TOKEN」环境变量引用') as HTMLInputElement
    expect(token.value).toBe('GH_OLD')
    expect(token.placeholder).toBe('留空使用目录默认')
    expect((screen.getByLabelText('「GITHUB_ORG」环境变量引用') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('checkbox', { name: '文件系统' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '旧条目' }))
    fireEvent.change(timeout, { target: { value: '90000' } })
    fireEvent.change(token, { target: { value: 'GH_TOKEN_ALT' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }))

    expect(await screen.findByText('本会话 MCP 设置已保存。')).toBeTruthy()
    expect(callOf(fetchMock.mock.calls, '/set')).toMatchObject({
      projectId: 'p1',
      actorSessionId: 'w1',
      targetSessionId: 'w1',
      servers: [
        {
          id: 'github',
          enabled: true,
          overrides: { toolCallTimeoutMs: 90000, env: { GITHUB_TOKEN: { fromEnv: 'GH_TOKEN_ALT' } } },
        },
        { id: 'files', enabled: false },
        { id: 'legacy', enabled: true },
      ],
    })
    // Empty reference fields are not sent; unchanged keys keep no override.
    expect((callOf(fetchMock.mock.calls, '/set')['servers'] as { overrides?: { env?: object } }[])[0]?.overrides?.env)
      .toEqual({ GITHUB_TOKEN: { fromEnv: 'GH_TOKEN_ALT' } })
    // The echoed selection replaces the draft, including the saved override.
    expect((screen.getByLabelText('「GitHub」工具调用超时（毫秒）') as HTMLInputElement).value).toBe('90000')
    expect((screen.getByLabelText('「GITHUB_TOKEN」环境变量引用') as HTMLInputElement).value).toBe('GH_TOKEN_ALT')
    expect((screen.getByRole('checkbox', { name: '文件系统' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('已启用 2')).toBeTruthy()
  })

  it('edits its own Session for a plain session too', async () => {
    const healthOnly = { servers: CATALOG.servers, health: [{ id: 'github', state: 'ok' }] }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: true, result: { servers: [{ id: 'github', enabled: true }] } })
      return json({ ok: true, result: healthOnly })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreMcpTab {...props('plain', null)} />)
    expect(await screen.findByText('GitHub')).toBeTruthy()
    // A catalog without invalid rows shows no health warning.
    expect(document.querySelector('[data-mcp-health]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }))
    expect(await screen.findByText('本会话 MCP 设置已保存。')).toBeTruthy()
    for (const suffix of ['/catalog', '/set']) {
      expect(callOf(fetchMock.mock.calls, suffix)).toMatchObject({ projectId: 'p1', actorSessionId: 'plain', targetSessionId: 'plain' })
    }
    // The refreshed selection omits two rows, which read back as disabled.
    expect((screen.getByRole('checkbox', { name: '文件系统' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: '旧条目' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('已启用 1')).toBeTruthy()
  })

  it('shows a loading state until the catalog resolves', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => pending.promise))
    render(<CadreMcpTab {...props('w1')} />)
    expect(screen.getByRole('status').textContent).toBe('正在加载 MCP 服务器…')
    expect((screen.getByRole('button', { name: '保存 MCP 设置' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      pending.resolve(json({ ok: true, result: CATALOG }))
      await pending.promise
    })
    expect(await screen.findByText('GitHub')).toBeTruthy()
    expect(screen.queryByText('正在加载 MCP 服务器…')).toBeNull()
  })

  it('shows the empty state when the catalog has no servers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: { servers: [], health: [] } })))
    render(<CadreMcpTab {...props('w1')} />)
    expect(await screen.findByText('还没有可用的 MCP 服务器。')).toBeTruthy()
    expect(document.querySelector('[data-mcp-empty]')).toBeTruthy()
    expect(document.querySelectorAll('[data-mcp-card]')).toHaveLength(0)
  })

  it('renders the structured host failure with its remediation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({
      ok: false,
      code: 'MCP_FORBIDDEN',
      message: '只有主管可以操作其他成员的 MCP 服务器',
      remediation: '请由主管操作',
    }, 403)))
    render(<CadreMcpTab {...props('w1')} />)
    const alert = await screen.findByRole('alert')
    expect(alert.hasAttribute('data-mcp-error')).toBe(true)
    expect(alert.textContent).toContain('MCP_FORBIDDEN')
    expect(alert.textContent).toContain('只有主管可以操作其他成员的 MCP 服务器')
    expect(alert.textContent).toContain('请由主管操作')
    // A failed catalog is not reported as "no servers available", and cannot be saved over.
    expect(screen.queryByText('还没有可用的 MCP 服务器。')).toBeNull()
    expect((screen.getByRole('button', { name: '保存 MCP 设置' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('falls back to the localized failure when the transport itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { throw new Error('offline') }))
    render(<CadreMcpTab {...props('w1')} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MCP_REQUEST_FAILED')
    expect(alert.textContent).toContain('请求失败')
    expect(alert.textContent).toContain('请检查网络与宿主状态后重试。')
  })

  it('rejects a non-positive timeout before writing', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: CATALOG }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreMcpTab {...props('w1')} />)
    fireEvent.change(await screen.findByLabelText('「GitHub」工具调用超时（毫秒）'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }))
    expect(await screen.findByText('工具调用超时必须是大于 0 的整数毫秒数。')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/set'))).toBe(false)
  })

  it('reports a rejected write without remediation and re-enables the panel', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/set')) return json({ ok: false, code: 'MCP_INVALID', message: '覆盖越白名单' }, 400)
      return json({ ok: true, result: CATALOG })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreMcpTab {...props('w1')} />)
    expect(await screen.findByText('GitHub')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP 设置' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MCP_INVALID')
    expect(alert.textContent).toContain('覆盖越白名单')
    // No host remediation: the panel renders no remediation line.
    expect(document.querySelectorAll('[data-mcp-error] p')).toHaveLength(1)
    expect((screen.getByRole('button', { name: '保存 MCP 设置' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the current catalog when stale responses arrive later', async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error('Unexpected catalog request')
    })
      .mockImplementationOnce(async () => responses[0]!.promise)
      .mockImplementationOnce(async () => responses[1]!.promise)
      .mockImplementationOnce(async () => responses[2]!.promise)
    vi.stubGlobal('fetch', fetchMock)
    const ordinary: CadreRosterState = { ...roster, members: [] }
    const view = render(<CadreMcpTab {...props('plain', 'p1', 'p1', ordinary)} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    view.rerender(<CadreMcpTab {...props('w1')} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    view.rerender(<CadreMcpTab {...props('plain', 'p1', 'p1', ordinary)} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(3) })
    await act(async () => {
      responses[2]!.resolve(json({ ok: true, result: CATALOG }))
      await responses[2]!.promise
    })
    expect(await screen.findByText('GitHub')).toBeTruthy()
    // A superseded success is dropped.
    await act(async () => {
      responses[0]!.resolve(json({ ok: true, result: { servers: [{ id: 'late', name: '迟到条目' }] } }))
      await responses[0]!.promise
    })
    expect(screen.queryByText('迟到条目')).toBeNull()
    // A superseded failure is dropped as well: it must not replace the catalog.
    await act(async () => {
      responses[1]!.resolve(json({ ok: false, code: 'MCP_FORBIDDEN', message: '过期请求' }, 403))
      await responses[1]!.promise
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelectorAll('[data-mcp-card]')).toHaveLength(3)
  })

  it('waits for roster readiness before reading the catalog', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: CATALOG }))
    vi.stubGlobal('fetch', fetchMock)
    const loading: CadreRosterState = { ...roster, status: 'loading', members: [] }
    const view = render(<CadreMcpTab {...props('w1', 'p1', 'p1', loading)} />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '保存 MCP 设置' })).toBeNull()
    view.rerender(<CadreMcpTab {...props('w1')} />)
    expect(await screen.findByRole('checkbox', { name: 'GitHub' })).toBeTruthy()
    expect(callOf(fetchMock.mock.calls, '/catalog')).toMatchObject({ actorSessionId: 'w1', targetSessionId: 'w1' })
  })

  it('does not treat a failed roster read as an ordinary Session', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const failed: CadreRosterState = { ...roster, status: 'error', members: [], error: 'ROSTER_READ_FAILED' }
    const view = render(<CadreMcpTab {...props('plain', null, 'p1', failed)} />)
    expect(screen.getByRole('alert').textContent).toBe('ROSTER_READ_FAILED')
    expect(fetchMock).not.toHaveBeenCalled()
    view.rerender(<CadreMcpTab {...props('plain', null, 'p1', { ...failed, error: null })} />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(view.container.textContent).toBe('')
  })

  it('renders nothing for a departed member', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const departed: CadreRosterState = {
      ...roster,
      members: [{ sessionId: 'w1', role: 'worker', displayName: '前端', state: 'departed' }],
    }
    const view = render(<CadreMcpTab {...props('w1', 'p1', 'p1', departed)} />)
    expect(view.container.textContent).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows noProject when no project can be resolved', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreMcpTab {...props('plain', null, null)} />)
    expect(screen.getByText('无法确定本会话所属项目组，暂不能读取 MCP 服务器。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存 MCP 设置' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('cadre-mcp transport', () => {
  it('reads malformed results as empty and omits an absent locale', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true, result: {} }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchMcpCatalog('p1', 'w1', 'w1', undefined)).toEqual({ servers: [], health: [] })
    expect(callOf(fetchMock.mock.calls, '/catalog')).toEqual({
      projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1',
    })
    expect(await saveMcpSelection('p1', 'w1', 'w1', [])).toEqual({ servers: [] })
    expect(callOf(fetchMock.mock.calls, '/set')).toEqual({
      projectId: 'p1', actorSessionId: 'w1', targetSessionId: 'w1', servers: [],
    })
    // A failure without a host code or message falls back to HTTP_200 and generic copy.
    fetchMock.mockImplementationOnce(async () => json({ ok: false }))
    await expect(fetchMcpCatalog('p1', 'w1', 'w1', undefined)).rejects.toMatchObject({
      code: 'HTTP_200',
      detail: '请求失败',
    })
  })
})
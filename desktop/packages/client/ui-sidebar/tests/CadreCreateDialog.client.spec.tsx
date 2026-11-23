// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreCreateDialog, type CadreCreateRequest } from '../src/client/CadreCreateDialog.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as { cadre?: unknown }).cadre
})

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

type Props = ComponentProps<typeof CadreCreateDialog>

const providers = [
  {
    providerId: 'p1', name: '官方服务商', defaultModel: 'model-a',
    models: [
      { id: 'model-a' },
      { id: 'model-b', reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } },
    ],
  },
]

function mount(options: {
  request?: CadreCreateRequest
  roster?: readonly { sessionId: string; role: string; displayName?: string; state?: string }[]
  catalog?: readonly (typeof providers)[number][]
} = {}) {
  const request = options.request ?? {
    kind: 'supervisor', token: 1, workspaceId: 'ws-1', projectLabel: '项目组 A',
  }
  const createRosterEntry = vi.fn(async () => ({ ok: true as const, sessionId: 's-new' }))
  const bindSession = vi.fn(async () => ({ ok: true as const }))
  const reportIn = vi.fn(async () => ({ ok: true as const }))
  const closeCreate = vi.fn()
  ;(window as unknown as { cadre?: unknown }).cadre = {
    listRoster: async () => ({ members: options.roster ?? [] }),
    listProviders: async () => ({ ok: true, providers: options.catalog ?? providers }),
    bindSession,
    reportIn,
  }
  const props = {
    useCreateRequest: (selector: (value: CadreCreateRequest | null) => unknown) => selector(request),
    closeCreate,
    createRosterEntry,
    refreshSupervisor: vi.fn(),
    t: ((key: keyof typeof zh) => zh[key]) as never,
  } as unknown as Props
  render(<CadreCreateDialog {...props} />)
  return { createRosterEntry, bindSession, reportIn, closeCreate }
}

describe('CadreCreateDialog supervisor model selection', () => {
  it('offers providers/models and binds the chosen model to the supervisor Session', async () => {
    const m = mount()
    expect(await screen.findByText('服务商与模型（可选）')).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '服务商' })).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'model-b' }))
    fireEvent.click(await screen.findByRole('button', { name: '高' }))
    fireEvent.click(screen.getByRole('button', { name: '创建组长' }))

    await waitFor(() => {
      expect(m.createRosterEntry).toHaveBeenCalledWith(expect.objectContaining({ role: 'supervisor', displayName: '组长' }))
    })
    await waitFor(() => {
      expect(m.bindSession).toHaveBeenCalledWith({
        sessionId: 's-new', providerId: 'p1', model: 'model-b', reasoningEffort: 'high',
      })
    })
    expect(m.closeCreate).toHaveBeenCalledOnce()
  })

  it('creates the supervisor without a model when no provider is configured', async () => {
    const m = mount({ catalog: [] })
    expect(await screen.findByText('未配置服务商，将使用官方默认模型。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建组长' }))

    await waitFor(() => {
      expect(m.createRosterEntry).toHaveBeenCalledWith(expect.objectContaining({ role: 'supervisor' }))
    })
    expect(m.bindSession).not.toHaveBeenCalled()
    expect(m.closeCreate).toHaveBeenCalledOnce()
  })

  it('creates an employee without any skill picker; skills are configured in the session tab', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, json: async () => ({ ok: true, result: [] }) }) as Response)
    vi.stubGlobal('fetch', fetchMock)
    const m = mount({
      request: { kind: 'worker', token: 2, workspaceId: 'ws-1', projectLabel: '项目组 A' },
      roster: [{ sessionId: 'sup', role: 'supervisor', displayName: '组长', state: 'available' }],
    })
    expect(await screen.findByLabelText('名称')).toBeTruthy()
    expect(screen.queryByText('技能（可选）')).toBeNull()
    expect(screen.getByText('技能不在创建时选择：创建后到该会话的「技能」页勾选。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新员工' } })
    fireEvent.change(screen.getByLabelText('岗位职责（最多 2000 字）'), { target: { value: '负责测试' } })
    fireEvent.click(screen.getByRole('button', { name: '创建员工' }))
    await waitFor(() => {
      expect(m.createRosterEntry).toHaveBeenCalledOnce()
    })
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/set'))).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/catalog'))).toBe(false)
  })

  it('still refuses a second supervisor without touching the model bridge', async () => {
    const m = mount({ roster: [{ sessionId: 's-old', role: 'supervisor', displayName: '老组长', state: 'active' }] })
    expect(await screen.findByText(/本项目组已有组长/)).toBeTruthy()
    const submit = screen.getByRole('button', { name: '创建组长' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(m.createRosterEntry).not.toHaveBeenCalled()
  })
})

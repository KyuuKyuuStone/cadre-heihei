// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CadreEmailSettingsDialog, CadreEmailSettingsMenuItem, type CadreEmailRequest } from '../src/client/CadreEmailSettings.tsx'
import type { CadreRosterState } from '../src/client/CadreSidebar.tsx'
import { zh } from '../src/client/locales.ts'

const REQUEST: CadreEmailRequest = { sessionId: 'sup', projectId: 'p1', label: '项目部 A', token: 1 }
const VIEW = {
  enabled: true,
  provider: 'smtp',
  smtpPreset: 'qq',
  user: 'cadre@example.com',
  authCodeRef: 'smtp:p1',
  hasSecret: true,
  from: { email: 'cadre@example.com', name: 'Cadre' },
  recipients: ['owner@example.com'],
  dryRun: false,
  minIntervalMs: 60_000,
  hasKey: true,
}

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

function roster(role: 'supervisor' | 'worker'): CadreRosterState {
  return {
    status: 'ready',
    members: [{ sessionId: role === 'supervisor' ? 'sup' : 'w1', role, displayName: role, state: 'available' }],
    error: null,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Cadre email settings', () => {
  it('hides the menu entry from ordinary sessions', () => {
    const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector(roster('worker'))) as never
    const props = {
      sessionId: 'w1',
      displayTitle: '员工',
      useMenuOpenState: () => [false, vi.fn()] as const,
      useRoster,
      openEmail: vi.fn(),
      closeEmail: vi.fn(),
      t,
    }
    const { container } = render(<CadreEmailSettingsMenuItem {...props as unknown as ComponentProps<typeof CadreEmailSettingsMenuItem>} />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the supervisor menu entry', () => {
    const openEmail = vi.fn()
    const useRoster = ((selector: (value: CadreRosterState) => unknown) => selector(roster('supervisor'))) as never
    render(<CadreEmailSettingsMenuItem {...({
      sessionId: 'sup',
      displayTitle: '主管',
      useMenuOpenState: () => [false, vi.fn()] as const,
      useRoster,
      openEmail,
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsMenuItem>)} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '邮件通知…' }))
    expect(openEmail).toHaveBeenCalledWith('sup', '主管')
  })

  it('loads config, shows hasKey, and saves without a secret', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/get')) return json({ ok: true, method: 'getConfig', result: VIEW })
      return json({ ok: true, method: 'setConfig', result: VIEW })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    expect(await screen.findByText('授权码已保存')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText('邮件通知设置已保存。')).toBeTruthy() })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(call?.[1]).toMatchObject({ method: 'POST' })
    expect(body).toMatchObject({ projectId: 'p1', actorSessionId: 'sup', config: { provider: 'smtp', smtpPreset: 'qq' } })
    expect(JSON.stringify(body)).not.toContain('apiKey"')
  })

  it('shows noKey and validates recipient add/remove', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: { ...VIEW, hasKey: false, hasSecret: false } })))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    expect(await screen.findByText(/未检测到授权码/)).toBeTruthy()
    const input = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(input, { target: { value: 'bad-address' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByRole('alert').textContent).toContain('收件人地址格式不正确')
    fireEvent.change(input, { target: { value: 'second@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('second@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除 second@example.com' }))
    expect(screen.queryByText('second@example.com')).toBeNull()
  })

  it('does not show an error when the project has no config yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      ok: false,
      code: 'EMAIL_CONFIG_INVALID',
      message: 'ENOENT: no such file or directory',
    })))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    expect(await screen.findByText('未填写授权码')).toBeTruthy()
    expect(screen.getByPlaceholderText('粘贴邮箱授权码（不是登录密码）')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '测试发送' })).toBeTruthy()
  })

  it('expands help with official and domestic links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: VIEW })))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    fireEvent.click(screen.getByText('如何填写 / 推荐地址'))
    expect(screen.getByText('想免备案就选 SendGrid。')).toBeTruthy()
    expect(screen.getByText('无需备案 · 推荐')).toBeTruthy()
    expect(screen.getByText('需要 ICP 备案')).toBeTruthy()
    expect(screen.getByText(/SendGrid 当前版本可直接用/)).toBeTruthy()
    expect(screen.getByText(/大陆节点发信域名需要 ICP 备案/)).toBeTruthy()
    expect(screen.getByText(/当前版本未接入，仅作后续参考/)).toBeTruthy()
    expect(screen.getAllByText('无需备案')).toHaveLength(3)
    expect(screen.getAllByText('需备案')).toHaveLength(2)
    const links = screen.getAllByRole('link')
    expect(links.map(link => link.textContent)).toEqual([
      'SendGrid 注册',
      'SendGrid API Keys',
      'SendGrid Sender Authentication',
      '注册 Resend',
      'Resend API Keys',
      'Resend 域名验证',
      '阿里云邮件推送',
      '腾讯云邮件推送 SES',
    ])
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(screen.getByRole('link', { name: 'SendGrid API Keys' }).getAttribute('href'))
      .toBe('https://app.sendgrid.com/settings/api_keys')
    expect(screen.getByRole('link', { name: 'Resend API Keys' }).getAttribute('href'))
      .toBe('https://resend.com/api-keys')
    expect(screen.getByRole('link', { name: '阿里云邮件推送' }).getAttribute('href'))
      .toBe('https://www.aliyun.com/product/directmail')
    expect(screen.getByRole('link', { name: '腾讯云邮件推送 SES' }).getAttribute('href'))
      .toBe('https://cloud.tencent.com/product/ses')
  })

  it('saves the auth code before config, without environment variable fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/get')) return json({ ok: true, result: { ...VIEW, hasSecret: false, hasKey: false } })
      if (url.endsWith('/secret')) return json({ ok: true, result: { hasKey: true } })
      return json({ ok: true, result: VIEW })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    expect(await screen.findByText(/未检测到授权码/)).toBeTruthy()
    expect(screen.queryByLabelText(/环境变量/)).toBeNull()
    expect(screen.getByText(/QQ\/163 需在邮箱设置中开启 SMTP/)).toBeTruthy()
    expect(screen.getByText('如何获取授权码')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('邮箱类型'), { target: { value: '163' } })
    const auth = screen.getByPlaceholderText('粘贴邮箱授权码（不是登录密码）')
    fireEvent.change(auth, { target: { value: 'qq-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText('邮件通知设置已保存。')).toBeTruthy() })
    const secretIndex = fetchMock.mock.calls.findIndex(([input]) => requestUrl(input).endsWith('/secret'))
    const setIndex = fetchMock.mock.calls.findIndex(([input]) => requestUrl(input).endsWith('/set'))
    expect(secretIndex).toBeGreaterThan(-1)
    expect(setIndex).toBeGreaterThan(secretIndex)
    const secretBody = JSON.parse((fetchMock.mock.calls[secretIndex]?.[1] as RequestInit).body as string) as { authCode?: string }
    expect(secretBody).toMatchObject({ projectId: 'p1', actorSessionId: 'sup', authCode: 'qq-secret' })
    const setCall = fetchMock.mock.calls[setIndex]
    const body = JSON.parse((setCall?.[1] as RequestInit).body as string) as { config: Record<string, unknown> }
    expect(body.config).toMatchObject({
      provider: 'smtp',
      smtpPreset: '163',
      user: 'cadre@example.com',
      from: { email: 'cadre@example.com', name: 'Cadre' },
      recipients: ['owner@example.com'],
    })
    expect(body.config).not.toHaveProperty('authCodeEnv')
    expect(body.config).not.toHaveProperty('authCode')
    expect(body.config).not.toHaveProperty('verifiedDomains')
    expect(body.config).not.toHaveProperty('apiKeyEnv')
  })

  it('shows and hides the auth code, and can clear the saved value', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/get')) return json({ ok: true, result: VIEW })
      return json({ ok: true, result: { hasKey: false } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    const auth = await screen.findByPlaceholderText('已保存，留空则不修改')
    expect(auth.getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '显示' }))
    expect(screen.getByPlaceholderText('已保存，留空则不修改').getAttribute('type')).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: '清除授权码' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/secret'))
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
        projectId: 'p1', actorSessionId: 'sup', action: 'clear',
      })
    })
    expect(await screen.findByText(/未检测到授权码/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '清除授权码' })).toBeNull()
  })

  it('keeps the typed auth code when secure storage is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/get')) return json({ ok: true, result: { ...VIEW, hasSecret: false, hasKey: false } })
      if (url.endsWith('/secret')) {
        return json({ ok: false, code: 'SECRET_STORE_UNAVAILABLE', message: 'dpapi failed' })
      }
      return json({ ok: true, result: VIEW })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    const auth = await screen.findByPlaceholderText('粘贴邮箱授权码（不是登录密码）')
    fireEvent.change(auth, { target: { value: 'qq-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/系统安全存储不可用/)).toBeTruthy()
    expect(screen.getByDisplayValue('qq-secret')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).endsWith('/set'))).toBe(false)
  })

  it('keeps the typed auth code when config saving fails after the secret write', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/get')) return json({ ok: true, result: { ...VIEW, hasSecret: false, hasKey: false } })
      if (url.endsWith('/secret')) return json({ ok: true, result: { hasKey: true } })
      return json({ ok: false, code: 'EMAIL_CONFIG_INVALID', message: 'bad config' })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    const auth = await screen.findByPlaceholderText('粘贴邮箱授权码（不是登录密码）')
    fireEvent.change(auth, { target: { value: 'qq-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/邮件配置无效/)).toBeTruthy()
    expect(screen.getByDisplayValue('qq-secret')).toBeTruthy()
    expect(screen.getByText('授权码已保存')).toBeTruthy()
  })

  it('switches to Resend, prefills its key env, and saves provider without domains', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (requestUrl(input).endsWith('/get')) return json({ ok: true, result: VIEW })
      return json({ ok: true, result: { ...VIEW, provider: 'resend', apiKeyEnv: 'RESEND_API_KEY', verifiedDomains: ['example.com'] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'resend' } })
    expect(screen.getByDisplayValue('RESEND_API_KEY')).toBeTruthy()
    expect(screen.getByText(/先在 Resend 验证域名/)).toBeTruthy()
    expect(screen.getByText(/只能发到你的 Resend 注册邮箱/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText('邮件通知设置已保存。')).toBeTruthy() })
    const call = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith('/set'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      config: { provider: 'resend', apiKeyEnv: 'RESEND_API_KEY' },
    })
  })

  it('lets the backend decide Resend From/recipient restrictions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: VIEW })))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'resend' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByText('邮件通知设置已保存。')).toBeTruthy() })
  })

  it('maps the Resend unverified-domain error to readable copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/get')) return json({ ok: true, result: VIEW })
      return json({ ok: false, code: 'EMAIL_FROM_NOT_VERIFIED', message: 'not verified' })
    }))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'resend' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/发件地址未通过 Resend 验证/)).toBeTruthy()
  })

  it('maps the Resend recipient-restricted error to readable copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith('/get')) return json({ ok: true, result: VIEW })
      return json({ ok: false, code: 'EMAIL_RECIPIENT_RESTRICTED', message: 'restricted' })
    }))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'resend' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/只能发到你的 Resend 注册邮箱/)).toBeTruthy()
  })

  it('keeps save/test/run actions in the fixed footer outside the scroll area', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: true, result: VIEW })))
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    await screen.findByText('授权码已保存')
    const footer = document.querySelector('[data-email-footer]')
    const form = document.querySelector('[data-email-form]')
    expect(footer).toBeTruthy()
    expect(form).toBeTruthy()
    for (const name of ['保存', '测试发送', '演练']) {
      const button = screen.getByRole('button', { name })
      expect(footer?.contains(button)).toBe(true)
      expect(form?.contains(button)).toBe(false)
    }
  })

  it('rejects invalid email and still exposes test and dry-run results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.endsWith('/get')) return json({ ok: true, result: VIEW })
      if (url.endsWith('/test')) return json({ ok: true, result: { ok: true, status: 'sent' } })
      return json({ ok: true, result: { ok: true, status: 'dry-run' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CadreEmailSettingsDialog {...({
      useRequest: (selector: (value: CadreEmailRequest) => unknown) => selector(REQUEST),
      closeEmail: vi.fn(),
      t,
    } as unknown as ComponentProps<typeof CadreEmailSettingsDialog>)} />)
    const from = await screen.findByDisplayValue('cadre@example.com')
    fireEvent.change(from, { target: { value: 'not-an-email' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('alert').textContent).toContain('发件地址格式不正确')
    fireEvent.click(screen.getByRole('button', { name: '测试发送' }))
    expect(await screen.findByText(/操作成功（sent）/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '演练' }))
    expect(await screen.findByText(/操作成功（dry-run）/)).toBeTruthy()
  })
})

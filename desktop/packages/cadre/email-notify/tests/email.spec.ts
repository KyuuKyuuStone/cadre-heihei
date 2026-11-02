import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEmailConfig, parseEmailConfig } from '../src/config.ts'
import { CadreEmailNotifier, renderEmail } from '../src/notifier.ts'
import { dryRunEmail, getEmailConfigView, setEmailConfig, testEmail } from '../src/ipc.ts'
import { buildSendGridBody, redactSecret, sendWithSendGrid } from '../src/sendgrid.ts'
import { buildResendBody, sendWithResend } from '../src/resend.ts'
import { buildSmtpMail, sendWithSmtp } from '../src/smtp.ts'
import { PowerShellDpapi } from '../src/dpapi.ts'
import { EmailSecretStore, SecretStoreUnavailableError } from '../src/secret-store.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-email-'))
  roots.push(dir)
  return dir
}

function writeConfig(dir: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'p1.json'), JSON.stringify({
    enabled: true,
    from: { email: 'cadre@example.com', name: 'Cadre' },
    recipients: ['owner@example.com'],
    apiKeyEnv: 'SENDGRID_TEST_KEY',
    minIntervalMs: 60_000,
    ...overrides,
  }))
}

function response(status = 202): Response {
  return new Response(status === 202 ? '' : 'denied', { status })
}

describe('email config', () => {
  it('parses a valid project config and loads it by safe project id', () => {
    const dir = workspace()
    writeConfig(dir)
    expect(loadEmailConfig(dir, 'p1')).toMatchObject({
      enabled: true, recipients: ['owner@example.com'], apiKeyEnv: 'SENDGRID_TEST_KEY',
    })
  })

  it('rejects embedded secret values and malformed recipients', () => {
    expect(() => parseEmailConfig({
      enabled: true, from: { email: 'a@b.com' }, recipients: ['c@d.com'], apiKeyEnv: 'KEY', apiKey: 'SG.secret',
    })).toThrow(/EMAIL_SECRET_IN_CONFIG/)
    expect(() => parseEmailConfig({
      enabled: true, from: { email: 'not-an-address' }, recipients: ['c@d.com'], apiKeyEnv: 'KEY',
    })).toThrow(/EMAIL_CONFIG_INVALID/)
    expect(() => loadEmailConfig(workspace(), '../escape')).toThrow(/safe file name/)
  })
})

describe('SendGrid request', () => {
  it('builds the v3 body and reads the API key only from the environment', async () => {
    const dir = workspace()
    writeConfig(dir)
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response())
    const notifier = new CadreEmailNotifier({ configDir: dir, env: { SENDGRID_TEST_KEY: 'SG.test' }, fetch: fetch as never })
    const result = await notifier.notify({
      kind: 'task-summary', projectId: 'p1',
      tasks: [{ taskId: 't1', title: '交付登录页', assigneeName: '小明', status: 'delivered', deliverable: 'login.md' }],
    })
    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer SG.test' })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      personalizations: [{ to: [{ email: 'owner@example.com' }] }],
      from: { email: 'cadre@example.com', name: 'Cadre' },
      content: [{ type: 'text/plain' }],
    })
    expect(String(body.subject)).toContain('交付汇总')
    expect(JSON.stringify(body)).not.toContain('SG.test')
  })

  it('renders escalation with a user-decision subject', () => {
    const message = renderEmail({
      kind: 'escalation', projectId: 'p1', taskId: 't1', title: '登录修复', reason: '催办无回应', episodeId: 'e1',
    }, { enabled: true, from: { email: 'a@b.com' }, recipients: ['c@d.com'], apiKeyEnv: 'K' })
    expect(message.subject).toContain('[需要您决定]')
    expect(message.text).toContain('催办无回应')
  })
})

describe('dedupe, rate limit and failures', () => {
  it('dedupes the same summary and rate-limits a second project event', async () => {
    const dir = workspace()
    writeConfig(dir)
    const fetch = vi.fn(async () => response())
    let now = 0
    const notifier = new CadreEmailNotifier({ configDir: dir, env: { SENDGRID_TEST_KEY: 'k' }, fetch: fetch as never, now: () => now })
    const summary = { kind: 'task-summary' as const, projectId: 'p1', tasks: [{ taskId: 't1', title: 'x', assigneeName: 'w', status: 'verified' as const }] }
    expect(await notifier.notify(summary)).toMatchObject({ ok: true, status: 'sent' })
    expect(await notifier.notify(summary)).toMatchObject({ ok: true, status: 'deduped' })
    now = 1_000
    expect(await notifier.notify({ kind: 'escalation', projectId: 'p1', taskId: 't2', title: 'y', reason: 'z', episodeId: 'e2' }))
      .toMatchObject({ ok: true, status: 'rate-limited' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns a readable failure instead of throwing, and redacts the key', async () => {
    const dir = workspace()
    writeConfig(dir)
    const fetch = vi.fn(async () => { throw new Error('socket failed for SG.secret') })
    const notifier = new CadreEmailNotifier({ configDir: dir, env: { SENDGRID_TEST_KEY: 'SG.secret' }, fetch: fetch as never })
    const result = await notifier.notify({
      kind: 'escalation', projectId: 'p1', taskId: 't1', title: 'x', reason: 'y', episodeId: 'e1',
    })
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_TRANSPORT_FAILED' })
    expect(JSON.stringify(result)).not.toContain('SG.secret')
    expect(redactSecret('token SG.secret', 'SG.secret')).toBe('token [redacted]')
  })

  it('dry-run renders without network and test-send bypasses dedupe', async () => {
    const dir = workspace()
    writeConfig(dir, { dryRun: true })
    const fetch = vi.fn(async () => response())
    const notifier = new CadreEmailNotifier({ configDir: dir, env: {}, fetch: fetch as never })
    const result = await notifier.notify({ kind: 'escalation', projectId: 'p1', taskId: 't', title: 'x', reason: 'y', episodeId: 'e' })
    expect(result).toMatchObject({ ok: true, status: 'dry-run' })
    expect((await notifier.testSend('p1'))).toMatchObject({ ok: true, status: 'dry-run' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a missing API key without leaking anything', async () => {
    const dir = workspace()
    writeConfig(dir)
    const notifier = new CadreEmailNotifier({ configDir: dir, env: {}, fetch: vi.fn() as never })
    expect(await notifier.testSend('p1')).toMatchObject({ ok: false, code: 'EMAIL_MISSING_API_KEY' })
  })

  it('builds a stable SendGrid body and maps auth failures', async () => {
    const body = buildSendGridBody({ to: ['c@d.com'], from: { email: 'a@b.com' }, subject: 's', text: 't' })
    expect(body).toEqual({ personalizations: [{ to: [{ email: 'c@d.com' }] }], from: { email: 'a@b.com' }, subject: 's', content: [{ type: 'text/plain', value: 't' }] })
    const result = await sendWithSendGrid({ apiKey: 'bad', message: { to: ['c@d.com'], from: { email: 'a@b.com' }, subject: 's', text: 't' }, fetch: vi.fn(async () => response(401)) as never })
    expect(result).toMatchObject({ ok: false, code: 'EMAIL_AUTH_FAILED' })
  })

  it('IPC get returns the exact disabled default on first open instead of ENOENT', async () => {
    const dir = workspace()
    expect(await getEmailConfigView(dir, 'p1')).toEqual({
      enabled: false,
      provider: 'sendgrid',
      from: { email: '', name: '' },
      recipients: [],
      apiKeyEnv: 'SENDGRID_API_KEY',
      dryRun: false,
      minIntervalMs: 60_000,
      hasKey: false,
      configured: false,
    })
  })

  it('IPC set creates the directory and file on first save', async () => {
    const root = workspace()
    const dir = join(root, 'nested', 'cadre-email')
    const view = setEmailConfig(dir, 'p1', {
      enabled: true, from: { email: 'a@b.com' }, recipients: ['c@d.com'], apiKeyEnv: 'SENDGRID_API_KEY',
    }, {})
    expect(view.configured).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'p1.json'), 'utf8'))).toMatchObject({ enabled: true })
    expect(await getEmailConfigView(dir, 'p1', {})).toMatchObject({ enabled: true, configured: true })
  })

  it('IPC get reports malformed JSON as a readable config error without the file path', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'p1.json'), '{ not json')
    await expect(getEmailConfigView(dir, 'p1')).rejects.toThrow('EMAIL_CONFIG_INVALID: config is not valid JSON')
    try {
      await getEmailConfigView(dir, 'p1')
    } catch (error) {
      expect(String(error)).not.toContain(dir)
    }
  })

  it('IPC get/set never returns the secret and hasKey follows the environment', async () => {
    const dir = workspace()
    const config = {
      enabled: true, from: { email: 'a@b.com' }, recipients: ['c@d.com'],
      apiKeyEnv: 'SENDGRID_TEST_KEY', minIntervalMs: 60_000,
    }
    const view = setEmailConfig(dir, 'p1', config, { SENDGRID_TEST_KEY: 'SG.secret' })
    expect(view.hasKey).toBe(true)
    expect(JSON.stringify(view)).not.toContain('SG.secret')
    expect(await getEmailConfigView(dir, 'p1', {})).toMatchObject({ enabled: true, hasKey: false })
    expect(readFileSync(join(dir, 'p1.json'), 'utf8')).not.toContain('SG.secret')
    expect(() => setEmailConfig(dir, 'p1', { ...config, apiKey: 'SG.secret' })).toThrow(/EMAIL_SECRET_IN_CONFIG/)
    expect(() => setEmailConfig(dir, 'p1', { ...config, authCode: 'qq-secret' })).toThrow(/EMAIL_SECRET_IN_CONFIG/)
  })

  it('stores the SMTP authorization code encrypted and exposes only hasKey', async () => {
    const root = workspace()
    const configDir = join(root, 'config')
    const secretDir = join(root, 'secrets')
    const xor = (value: string | Buffer): Buffer => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x5a))
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => xor(value),
      decryptString: (value: Buffer) => xor(value).toString('utf8'),
    }
    const store = new EmailSecretStore({ dir: secretDir, safeStorage })
    setEmailConfig(configDir, 'p1', {
      enabled: true, provider: 'smtp', from: { email: 'owner@qq.com' }, recipients: ['r@example.com'],
    }, {})
    expect(JSON.parse(readFileSync(join(configDir, 'p1.json'), 'utf8'))).toMatchObject({ authCodeRef: 'smtp:p1' })
    await store.set('p1', 'qq-secret')
    expect(store.has('p1')).toBe(true)
    expect(await store.read('p1')).toBe('qq-secret')
    expect(readFileSync(join(secretDir, 'p1.bin')).toString('utf8')).not.toContain('qq-secret')
    expect(await getEmailConfigView(configDir, 'p1', {}, store)).toMatchObject({ hasKey: true })
    expect(JSON.stringify(await getEmailConfigView(configDir, 'p1', {}, store))).not.toContain('qq-secret')
    store.clear('p1')
    expect(store.has('p1')).toBe(false)
  })

  it('fails closed when safeStorage and DPAPI are both unavailable', async () => {
    const store = new EmailSecretStore({
      dir: workspace(),
      platform: 'win32',
      log: () => {},
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      dpapi: {
        encrypt: async () => { throw new Error('dpapi unavailable') },
        decrypt: async () => { throw new Error('dpapi unavailable') },
      },
    })
    await expect(store.set('p1', 'qq-secret')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' })
    await expect(store.set('p1', '')).rejects.toThrow(/EMAIL_SECRET_EMPTY/)
    expect(SecretStoreUnavailableError).toBeTypeOf('function')
  })

  it('falls back to DPAPI when safeStorage cannot load, and redacts the secret', async () => {
    const calls: string[] = []
    const store = new EmailSecretStore({
      dir: workspace(),
      platform: 'win32',
      log: () => {},
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      dpapi: {
        encrypt: async value => { calls.push(`encrypt:${value}`); return Buffer.from(`dpapi:${value}`) },
        decrypt: async value => value.toString('utf8').replace(/^dpapi:/u, ''),
      },
    })
    await store.set('p1', 'qq-secret')
    expect(await store.read('p1')).toBe('qq-secret')
    expect(calls).toEqual(['encrypt:qq-secret'])
    const failing = new EmailSecretStore({
      dir: workspace(),
      platform: 'win32',
      log: () => {},
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      dpapi: {
        encrypt: async () => { throw new Error('dpapi failed qq-secret') },
        decrypt: async () => { throw new Error('dpapi failed qq-secret') },
      },
    })
    const failure = await failing.set('p1', 'qq-secret').catch((error: unknown) => error)
    expect(String(failure)).not.toContain('qq-secret')
  })

  it.runIf(process.platform === 'win32')('roundtrips through real Windows DPAPI', async () => {
    const store = new EmailSecretStore({
      dir: workspace(),
      platform: 'win32',
      log: () => {},
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      dpapi: new PowerShellDpapi(),
    })
    await store.set('p1', 'qq-real-secret')
    expect(await store.read('p1')).toBe('qq-real-secret')
  })

  it('uses the encrypted secret for SMTP and warns when falling back to the old env', async () => {
    const root = workspace()
    const configDir = root
    const secretDir = join(root, 'secrets')
    const xor = (value: string | Buffer): Buffer => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x5a))
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => xor(value),
      decryptString: (value: Buffer) => xor(value).toString('utf8'),
    }
    writeConfig(configDir, { provider: 'smtp', apiKeyEnv: undefined, from: { email: 'owner@qq.com' } })
    const store = new EmailSecretStore({ dir: secretDir, safeStorage })
    await store.set('p1', 'qq-secret')
    const sent: unknown[] = []
    const notifier = new CadreEmailNotifier({
      configDir, env: {}, secretStore: store,
      smtpTransport: { sendMail: async mail => { sent.push(mail); return { accepted: ['r@example.com'] } } },
    })
    expect(await notifier.notify({
      kind: 'escalation', projectId: 'p1', taskId: 't1', title: 'x', reason: 'y', episodeId: 'e1',
    })).toMatchObject({ ok: true, status: 'sent' })
    expect(sent).toHaveLength(1)

    const envDir = workspace()
    writeConfig(envDir, { provider: 'smtp', apiKeyEnv: undefined, from: { email: 'owner@qq.com' } })
    const fallback = new CadreEmailNotifier({
      configDir: envDir, env: { QQ_EMAIL_AUTH_CODE: 'env-secret' },
      smtpTransport: { sendMail: async () => ({ accepted: ['r@example.com'] }) },
    })
    expect(await fallback.notify({
      kind: 'escalation', projectId: 'p1', taskId: 't2', title: 'x', reason: 'y', episodeId: 'e2',
    })).toMatchObject({ ok: true, warning: expect.stringContaining('旧环境变量') as string })
  })

  it('stays silent and structured when no project config exists', async () => {
    const notifier = new CadreEmailNotifier({ configDir: workspace(), env: {}, fetch: vi.fn() as never })
    expect(await notifier.notify({
      kind: 'escalation', projectId: 'missing', taskId: 't', title: 'x', reason: 'y', episodeId: 'e',
    })).toMatchObject({ ok: false, code: 'EMAIL_CONFIG_UNAVAILABLE' })
  })

  it('IPC dry-run/test-send delegate without exposing the key', async () => {
    const dir = workspace()
    writeConfig(dir, { dryRun: true })
    const notifier = new CadreEmailNotifier({ configDir: dir, env: {}, fetch: vi.fn() as never })
    expect(await dryRunEmail(notifier, 'p1')).toMatchObject({ ok: true, status: 'dry-run' })
    expect(await testEmail(notifier, 'p1')).toMatchObject({ ok: true, status: 'dry-run' })
  })

  it('defaults old configs to SendGrid and derives the provider env variable', () => {
    const old = parseEmailConfig({
      enabled: true, from: { email: 'a@b.com' }, recipients: ['c@d.com'], apiKeyEnv: 'SENDGRID_TEST_KEY',
    })
    expect(old).toMatchObject({ provider: 'sendgrid', apiKeyEnv: 'SENDGRID_TEST_KEY' })
    const resend = parseEmailConfig({
      enabled: true, provider: 'resend', from: { email: 'onboarding@resend.dev' }, recipients: ['c@d.com'],
    })
    expect(resend).toMatchObject({ provider: 'resend', apiKeyEnv: 'RESEND_API_KEY' })
    expect(() => parseEmailConfig({
      enabled: true, provider: 'invalid', from: { email: 'a@b.com' }, recipients: ['c@d.com'],
    })).toThrow(/provider must be sendgrid, resend or smtp/)
  })

  it('builds the Resend body and lets Resend decide domain verification', async () => {
    const message = { to: ['owner@example.com'], from: { email: 'cadre@example.com', name: 'Cadre' }, subject: 's', text: 't' }
    expect(buildResendBody(message)).toEqual({
      from: 'Cadre <cadre@example.com>', to: ['owner@example.com'], subject: 's', text: 't',
    })
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(202))
    const sent = await sendWithResend({ apiKey: 're_secret', message, fetch: fetch as never })
    expect(sent).toMatchObject({ ok: true, status: 'sent' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer re_secret' })
    expect(JSON.parse(String(init?.body))).toMatchObject({ from: 'Cadre <cadre@example.com>', to: ['owner@example.com'] })
  })

  it('maps provider-side from and onboarding recipient restrictions', async () => {
    const message = { to: ['owner@example.com'], from: { email: 'cadre@example.com' }, subject: 's', text: 't' }
    const unverified = await sendWithResend({
      apiKey: 're_secret', message,
      fetch: vi.fn(async () => new Response('The from domain is not verified', { status: 403 })) as never,
    })
    expect(unverified).toMatchObject({ ok: false, code: 'EMAIL_FROM_NOT_VERIFIED' })
    const restricted = await sendWithResend({
      apiKey: 're_secret',
      message: { ...message, from: { email: 'onboarding@resend.dev' }, to: ['someone@example.com'] },
      fetch: vi.fn(async () => new Response('You can only send testing emails to your own email address', { status: 422 })) as never,
    })
    expect(restricted).toMatchObject({ ok: false, code: 'EMAIL_RECIPIENT_RESTRICTED' })
    expect(JSON.stringify(restricted)).not.toContain('re_secret')
  })

  it('maps Resend auth/422 failures, retries transient errors, and redacts secrets', async () => {
    const message = { to: ['c@d.com'], from: { email: 'cadre@example.com' }, subject: 's', text: 't' }
    const auth = await sendWithResend({
      apiKey: 're_secret', message,
      fetch: vi.fn(async () => response(401)) as never,
    })
    expect(auth).toMatchObject({ ok: false, code: 'EMAIL_AUTH_FAILED' })
    const invalid = await sendWithResend({
      apiKey: 're_secret', message,
      fetch: vi.fn(async () => new Response('from domain not verified', { status: 422 })) as never,
    })
    expect(invalid).toMatchObject({ ok: false, code: 'EMAIL_FROM_NOT_VERIFIED' })
    const retry = vi.fn(async () => new Response('temporary', { status: 500 }))
    const failed = await sendWithResend({
      apiKey: 're_secret', message, fetch: retry as never,
    })
    expect(failed).toMatchObject({ ok: false, code: 'EMAIL_HTTP_FAILED' })
    expect(retry).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(failed)).not.toContain('re_secret')
  })

  it('uses Resend and RESEND_API_KEY in the notifier', async () => {
    const dir = workspace()
    writeConfig(dir, { provider: 'resend', apiKeyEnv: undefined, from: { email: 'cadre@example.com' }, verifiedDomains: ['example.com'] })
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response(202))
    const notifier = new CadreEmailNotifier({ configDir: dir, env: { RESEND_API_KEY: 're_key' }, fetch: fetch as never })
    expect(await notifier.notify({
      kind: 'escalation', projectId: 'p1', taskId: 't1', title: 'x', reason: 'y', episodeId: 'e1',
    })).toMatchObject({ ok: true, status: 'sent' })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails')
  })

  it('derives QQ/163 SMTP presets and the auth-code env', () => {
    const qq = parseEmailConfig({
      enabled: true, provider: 'smtp', from: { email: 'owner@qq.com', name: 'Owner' }, recipients: ['r@example.com'],
    })
    expect(qq).toMatchObject({
      provider: 'smtp', smtpPreset: 'qq', host: 'smtp.qq.com', port: 465, secure: true,
      user: 'owner@qq.com', fromName: 'Owner', authCodeEnv: 'QQ_EMAIL_AUTH_CODE',
    })
    const mail163 = parseEmailConfig({
      enabled: true, provider: 'smtp', smtpPreset: '163', from: { email: 'owner@163.com' }, recipients: ['r@example.com'],
    })
    expect(mail163).toMatchObject({ host: 'smtp.163.com', port: 465, secure: true, user: 'owner@163.com' })
  })

  it('builds the SMTP mail and maps auth/connection/timeout failures without leaking the code', async () => {
    const message = { to: ['r@example.com'], from: { email: 'owner@qq.com', name: 'Owner' }, subject: 's', text: 't' }
    expect(buildSmtpMail(message, 'Cadre')).toEqual({
      from: { name: 'Cadre', address: 'owner@qq.com' }, to: 'r@example.com', subject: 's', text: 't',
    })
    const sent = vi.fn(async () => ({ accepted: ['r@example.com'] }))
    expect(await sendWithSmtp({
      authCode: 'qq-secret', message, host: 'smtp.qq.com', port: 465, secure: true, user: 'owner@qq.com',
      transport: { sendMail: sent },
    })).toMatchObject({ ok: true, status: 'sent' })
    expect(sent).toHaveBeenCalledTimes(1)
    const fail = async (error: unknown) => sendWithSmtp({
      authCode: 'qq-secret', message, host: 'smtp.qq.com', port: 465, secure: true, user: 'owner@qq.com',
      transport: { sendMail: async () => { throw error } },
    })
    expect(await fail({ code: 'EAUTH', message: 'auth qq-secret' })).toMatchObject({ code: 'EMAIL_AUTH_FAILED' })
    expect(await fail({ code: 'ECONNECTION', message: 'offline' })).toMatchObject({ code: 'EMAIL_CONNECTION_FAILED' })
    expect(await fail({ code: 'ETIMEDOUT', message: 'timeout' })).toMatchObject({ code: 'EMAIL_TIMEOUT' })
    expect(JSON.stringify(await fail({ code: 'EAUTH', message: 'auth qq-secret' }))).not.toContain('qq-secret')
  })

  it('forces IPv4, retries 465 failures on 587 STARTTLS, and keeps detailed connection codes', async () => {
    const message = { to: ['r@example.com'], from: { email: 'owner@qq.com' }, subject: 's', text: 't' }
    const attempts: Array<{ port: number; secure: boolean; requireTLS: boolean; family: number }> = []
    const factory = (config: { port: number; secure: boolean; requireTLS: boolean; family: number }) => {
      attempts.push(config)
      return {
        sendMail: async () => {
          if (config.port === 465) throw Object.assign(new Error('connect ECONNECTION'), { code: 'ECONNECTION' })
          return { accepted: ['r@example.com'] }
        },
      }
    }
    const result = await sendWithSmtp({
      authCode: 'qq-secret', message, host: 'smtp.qq.com', port: 465, secure: true, user: 'owner@qq.com',
      factory,
    })
    expect(result).toMatchObject({ ok: true, status: 'sent' })
    expect(attempts).toEqual([
      { host: 'smtp.qq.com', port: 465, secure: true, requireTLS: false, family: 4, auth: { user: 'owner@qq.com', pass: 'qq-secret' }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000 },
      { host: 'smtp.qq.com', port: 587, secure: false, requireTLS: true, family: 4, auth: { user: 'owner@qq.com', pass: 'qq-secret' }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000 },
    ])

    const failing = await sendWithSmtp({
      authCode: 'qq-secret', message, host: 'smtp.qq.com', port: 465, secure: true, user: 'owner@qq.com',
      factory: config => ({
        sendMail: async () => {
          throw Object.assign(new Error(config.port === 465 ? 'handshake qq-secret' : '587 also timed out'), {
            code: 'ETIMEDOUT',
          })
        },
      }),
    })
    expect(failing).toMatchObject({ ok: false, code: 'EMAIL_TIMEOUT' })
    expect(failing.ok ? '' : failing.message).toContain('ETIMEDOUT')
    expect(failing.ok ? '' : failing.message).toContain('465')
    expect(failing.ok ? '' : failing.message).toContain('587')
    expect(JSON.stringify(failing)).not.toContain('qq-secret')

    const certificate = await sendWithSmtp({
      authCode: 'qq-secret', message, host: 'smtp.qq.com', port: 465, secure: true, user: 'owner@qq.com',
      factory: () => ({
        sendMail: async () => {
          throw Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
        },
      }),
    })
    expect(certificate).toMatchObject({ ok: false, code: 'EMAIL_CONNECTION_FAILED' })
    expect(certificate.ok ? '' : certificate.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT')
  })

  it('uses SMTP and QQ_EMAIL_AUTH_CODE in the notifier', async () => {
    const dir = workspace()
    writeConfig(dir, { provider: 'smtp', apiKeyEnv: undefined, from: { email: 'owner@qq.com' } })
    const sent: unknown[] = []
    const notifier = new CadreEmailNotifier({
      configDir: dir, env: { QQ_EMAIL_AUTH_CODE: 'qq-secret' },
      smtpTransport: { sendMail: async mail => { sent.push(mail); return { accepted: ['r@example.com'] } } },
    })
    expect(await notifier.notify({
      kind: 'escalation', projectId: 'p1', taskId: 't1', title: 'x', reason: 'y', episodeId: 'e1',
    })).toMatchObject({ ok: true, status: 'sent' })
    expect(sent).toHaveLength(1)
    expect(await new CadreEmailNotifier({ configDir: dir, env: {} }).notify({
      kind: 'escalation', projectId: 'p1', taskId: 't2', title: 'x', reason: 'y', episodeId: 'e2',
    })).toMatchObject({ ok: false, code: 'EMAIL_MISSING_API_KEY' })
  })
})

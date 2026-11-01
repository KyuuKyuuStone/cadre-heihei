import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEmailConfig, parseEmailConfig } from '../src/config.ts'
import { CadreEmailNotifier, renderEmail } from '../src/notifier.ts'
import { dryRunEmail, getEmailConfigView, setEmailConfig, testEmail } from '../src/ipc.ts'
import { buildSendGridBody, redactSecret, sendWithSendGrid } from '../src/sendgrid.ts'

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

  it('IPC get returns a disabled default on first open instead of ENOENT', () => {
    const dir = workspace()
    expect(getEmailConfigView(dir, 'p1')).toMatchObject({
      enabled: false, recipients: [], apiKeyEnv: 'SENDGRID_API_KEY', hasKey: false,
    })
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
    expect(getEmailConfigView(dir, 'p1', {})).toMatchObject({ enabled: true, hasKey: false })
    expect(readFileSync(join(dir, 'p1.json'), 'utf8')).not.toContain('SG.secret')
    expect(() => setEmailConfig(dir, 'p1', { ...config, apiKey: 'SG.secret' })).toThrow(/EMAIL_SECRET_IN_CONFIG/)
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
})

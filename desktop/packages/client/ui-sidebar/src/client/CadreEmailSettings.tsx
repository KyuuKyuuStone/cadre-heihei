/**
 * DF-016 supervisor email notification settings.
 *
 * The Host exposes `/cadre/email/{get,set,test,dry-run}`; only a supervisor
 * session menu opens this dialog, and the server repeats the project/role
 * check. The API key itself never enters this component.
 */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import css from './CadreEmailSettings.module.css'

type UseMenuOpenState = () => readonly [open: boolean, setOpen: (open: boolean) => void]

/** One email config view; `hasKey` is derived by the Host, never a secret. */
export interface CadreEmailConfigView {
  readonly enabled: boolean
  readonly provider?: 'sendgrid' | 'resend' | 'smtp'
  readonly from: { readonly email: string; readonly name?: string }
  readonly recipients: readonly string[]
  readonly apiKeyEnv?: string
  readonly smtpPreset?: 'qq' | '163'
  readonly user?: string
  readonly authCodeEnv?: string
  readonly dryRun?: boolean
  readonly minIntervalMs?: number
  readonly hasKey: boolean
}

export interface CadreEmailRequest {
  readonly sessionId: string
  readonly projectId: string
  readonly label: string
  readonly token: number
}

/** Row-menu and overlay face for the email settings. */
export interface CadreEmailInjected {
  hooks: {
    roster: HostObservable<CadreRosterState>
    request: HostObservable<CadreEmailRequest | null>
  }
  openEmail(sessionId: string, displayTitle: string): void
  closeEmail(): void
}

interface EmailResponse {
  readonly ok?: boolean
  readonly method?: string
  readonly result?: unknown
  readonly code?: string
  readonly message?: string
}

interface EmailResult {
  readonly ok: boolean
  readonly status?: string
  readonly code?: string
  readonly message?: string
}

async function emailCall(
  method: 'get' | 'set' | 'test' | 'dry-run',
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`/cadre/email/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json() as EmailResponse
  if (!response.ok || result.ok !== true) {
    throw new Error(result.code === undefined
      ? (result.message ?? `HTTP ${String(response.status)}`)
      : `${result.code} · ${result.message ?? '请求失败'}`)
  }
  return result.result
}

function emailErrorText(cause: unknown, t: PropsLocale<'sidebar'>['t']): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = /^(EMAIL_[A-Z_]+) ·/u.exec(message)?.[1]
  switch (code) {
    case 'EMAIL_FROM_NOT_VERIFIED': return t('email.error.fromNotVerified')
    case 'EMAIL_RECIPIENT_RESTRICTED': return t('email.error.recipientRestricted')
    case 'EMAIL_MISSING_API_KEY': return t('email.error.missingKey')
    case 'EMAIL_AUTH_FAILED': return t('email.error.authFailed')
    case 'EMAIL_TIMEOUT': return t('email.error.timeout')
    case 'EMAIL_CONNECTION_FAILED': return t('email.error.connection')
    case 'EMAIL_SMTP_FAILED': return t('email.error.smtp')
    case 'EMAIL_CONFIG_INVALID': return t('email.error.configInvalid')
    default: return message
  }
}

function resultText(result: EmailResult, t: PropsLocale<'sidebar'>['t']): string {
  if (result.ok) {
    return t('email.result.ok', { status: result.status ?? 'sent' })
  }
  if (result.code === 'EMAIL_FROM_NOT_VERIFIED') return t('email.error.fromNotVerified')
  if (result.code === 'EMAIL_RECIPIENT_RESTRICTED') return t('email.error.recipientRestricted')
  if (result.code === 'EMAIL_MISSING_API_KEY') return t('email.error.missingKey')
  if (result.code === 'EMAIL_TIMEOUT') return t('email.error.timeout')
  if (result.code === 'EMAIL_CONNECTION_FAILED') return t('email.error.connection')
  if (result.code === 'EMAIL_SMTP_FAILED') return t('email.error.smtp')
  return t('email.result.failed', { code: result.code ?? 'ERROR', message: result.message ?? '' })
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
}

const DEFAULT_CONFIG: CadreEmailConfigView = {
  enabled: false,
  provider: 'smtp',
  from: { email: '' },
  recipients: [],
  smtpPreset: 'qq',
  authCodeEnv: 'QQ_EMAIL_AUTH_CODE',
  dryRun: false,
  minIntervalMs: 60_000,
  hasKey: false,
}

function isMissingConfig(message: string): boolean {
  return /ENOENT|no such file|EMAIL_CONFIG_MISSING/iu.test(message)
}

const HELP_LINKS = {
  sendgridSignup: 'https://signup.sendgrid.com/',
  sendgridKeys: 'https://app.sendgrid.com/settings/api_keys',
  sendgridSender: 'https://app.sendgrid.com/settings/sender_auth',
  resendSignup: 'https://resend.com/signup',
  resendKeys: 'https://resend.com/api-keys',
  resendDomains: 'https://resend.com/domains',
  aliyun: 'https://www.aliyun.com/product/directmail',
  tencent: 'https://cloud.tencent.com/product/ses',
} as const

/** Supervisor row-menu item; ordinary/employee sessions return null. */
export function CadreEmailSettingsMenuItem({
  sessionId, displayTitle, useMenuOpenState, useRoster, openEmail, t,
}: { readonly sessionId: string; readonly displayTitle: string } & {
  readonly useMenuOpenState: UseMenuOpenState
} & InjectFace<CadreEmailInjected> & PropsLocale<'sidebar'>) {
  const [, setMenuOpen] = useMenuOpenState()
  const members = useRoster(state => state.members)
  const member = members.find(item => item.sessionId === sessionId)
  if (member?.role !== 'supervisor' || member.state === 'departed') return null
  return (
    <button type="button" role="menuitem" className={css.menuItem}
      onClick={() => { setMenuOpen(false); openEmail(sessionId, displayTitle) }}>
      {t('email.menu')}
    </button>
  )
}

/** Frame-level dialog; mounted only while a request exists. */
export function CadreEmailSettingsDialog({
  useRequest, closeEmail, t,
}: InjectFace<CadreEmailInjected> & PropsLocale<'sidebar'>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return <EmailForm key={request.token} request={request} onClose={closeEmail} t={t} />
}

function EmailForm({
  request, onClose, t,
}: {
  readonly request: CadreEmailRequest
  readonly onClose: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [config, setConfig] = useState<CadreEmailConfigView | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState<'sendgrid' | 'resend' | 'smtp'>('smtp')
  const [smtpPreset, setSmtpPreset] = useState<'qq' | '163'>('qq')
  const [authCodeEnv, setAuthCodeEnv] = useState('QQ_EMAIL_AUTH_CODE')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [recipient, setRecipient] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [minInterval, setMinInterval] = useState('60000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void emailCall('get', { projectId: request.projectId, actorSessionId: request.sessionId })
      .then((value) => {
        if (!alive) return
        const next = value as CadreEmailConfigView
        setConfig(next)
        setEnabled(next.enabled)
        setProvider(next.provider ?? 'smtp')
        setSmtpPreset(next.smtpPreset ?? 'qq')
        setAuthCodeEnv(next.authCodeEnv ?? 'QQ_EMAIL_AUTH_CODE')
        setFromEmail(next.from.email)
        setFromName(next.from.name ?? '')
        setRecipients([...next.recipients])
        setApiKeyEnv(next.apiKeyEnv ?? (next.provider === 'resend' ? 'RESEND_API_KEY' : 'SENDGRID_API_KEY'))
        setDryRun(next.dryRun === true)
        setMinInterval(String(next.minIntervalMs ?? 60_000))
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const message = cause instanceof Error ? cause.message : String(cause)
        // A project without a config file is a valid first-run state, not a
        // form error; backend may still add a dedicated missing-config code.
        if (isMissingConfig(message)) {
          setConfig(DEFAULT_CONFIG)
          setEnabled(DEFAULT_CONFIG.enabled)
          setProvider(DEFAULT_CONFIG.provider ?? 'smtp')
          setSmtpPreset(DEFAULT_CONFIG.smtpPreset ?? 'qq')
          setAuthCodeEnv(DEFAULT_CONFIG.authCodeEnv ?? 'QQ_EMAIL_AUTH_CODE')
          setFromEmail(DEFAULT_CONFIG.from.email)
          setFromName(DEFAULT_CONFIG.from.name ?? '')
          setRecipients([...DEFAULT_CONFIG.recipients])
          setApiKeyEnv(DEFAULT_CONFIG.apiKeyEnv ?? 'SENDGRID_API_KEY')
          setDryRun(DEFAULT_CONFIG.dryRun === true)
          setMinInterval(String(DEFAULT_CONFIG.minIntervalMs ?? 60_000))
          return
        }
        setError(message)
      })
    return () => { alive = false }
  }, [request.projectId, request.sessionId])

  const addRecipient = (): void => {
    const value = recipient.trim()
    if (!validEmail(value)) {
      setError(t('email.error.recipient'))
      return
    }
    if (recipients.includes(value)) {
      setError(t('email.error.duplicateRecipient'))
      return
    }
    setRecipients([...recipients, value])
    setRecipient('')
    setError(null)
  }

  const changeProvider = (next: 'sendgrid' | 'resend' | 'smtp'): void => {
    setProvider(next)
    if (next === 'smtp') {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(authCodeEnv.trim())) setAuthCodeEnv('QQ_EMAIL_AUTH_CODE')
    } else {
      setApiKeyEnv(next === 'resend' ? 'RESEND_API_KEY' : 'SENDGRID_API_KEY')
    }
    setError(null)
  }

  const changePreset = (next: 'qq' | '163'): void => {
    setSmtpPreset(next)
    if (authCodeEnv.trim() === '' || authCodeEnv === 'QQ_EMAIL_AUTH_CODE' || authCodeEnv === 'SMTP_163_AUTH_CODE') {
      setAuthCodeEnv(next === 'qq' ? 'QQ_EMAIL_AUTH_CODE' : 'SMTP_163_AUTH_CODE')
    }
  }

  const validate = (): string | null => {
    if (!validEmail(fromEmail.trim())) return t('email.error.from')
    if (recipients.length === 0) return t('email.error.noRecipients')
    if (provider === 'smtp') {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(authCodeEnv.trim())) return t('email.error.authCodeEnv')
    } else if (!/^[A-Z_][A-Z0-9_]*$/u.test(apiKeyEnv.trim())) {
      return t('email.error.env')
    }
    if (!/^\d+$/u.test(minInterval.trim())) return t('email.error.interval')
    return null
  }

  const save = async (): Promise<void> => {
    const problem = validate()
    if (problem !== null) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await emailCall('set', {
        projectId: request.projectId,
        actorSessionId: request.sessionId,
        config: {
          enabled,
          provider,
          from: { email: fromEmail.trim(), ...(fromName.trim() === '' ? {} : { name: fromName.trim() }) },
          recipients,
          ...(provider === 'smtp'
            ? {
              smtpPreset,
              user: fromEmail.trim(),
              authCodeEnv: authCodeEnv.trim(),
            }
            : { apiKeyEnv: apiKeyEnv.trim() }),
          dryRun,
          minIntervalMs: Number(minInterval),
        },
      }) as CadreEmailConfigView
      setConfig(result)
      setNotice(t('email.notice.saved'))
    } catch (cause) {
      setError(emailErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const run = async (method: 'test' | 'dry-run'): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await emailCall(method, {
        projectId: request.projectId,
        actorSessionId: request.sessionId,
      }) as EmailResult
      setNotice(resultText(result, t))
    } catch (cause) {
      setError(emailErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={t('email.title', { label: request.label })}
      description={t('email.description')}
      closeLabel={t('email.close')}
      className={css.dialog ?? ''}
      contentClassName={css.content ?? ''}
      footer={(
        <div className={css.footerActions} data-email-footer>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('email.close')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('email.save')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void run('test') }}>{t('email.test')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void run('dry-run') }}>{t('email.dryRunAction')}</Button>
        </div>
      )}
    >
      <div className={css.form} data-email-form>
        {config === null && error === null && <p className={css.hint}>{t('email.loading')}</p>}
        <Checkbox checked={enabled} disabled={busy} label={t('email.enabled')}
          onChange={setEnabled} />
        {provider === 'smtp' && (
          <label className={css.label}>{t('email.smtpPreset')}
            <select className={css.select} value={smtpPreset} disabled={busy}
              onChange={(event) => { changePreset(event.target.value === '163' ? '163' : 'qq') }}>
              <option value="qq">{t('email.smtpPreset.qq')}</option>
              <option value="163">{t('email.smtpPreset.163')}</option>
            </select>
          </label>
        )}
        <details className={css.advanced} data-email-advanced open={provider !== 'smtp'}>
          <summary>{t('email.advancedProvider')}</summary>
          <label className={css.label}>{t('email.provider')}
            <select className={css.select} value={provider} disabled={busy}
              onChange={(event) => {
                const value = event.target.value
                changeProvider(value === 'resend' ? 'resend' : value === 'sendgrid' ? 'sendgrid' : 'smtp')
              }}>
              <option value="smtp">{t('email.provider.smtp')}</option>
              <option value="sendgrid">{t('email.provider.sendgrid')}</option>
              <option value="resend">{t('email.provider.resend')}</option>
            </select>
          </label>
          {provider !== 'smtp' && (
            <p className={css.hint} data-email-provider-hint>
              {t(provider === 'resend' ? 'email.provider.resendHint' : 'email.provider.sendgridHint')}
            </p>
          )}
        </details>
        <label className={css.label}>{t(provider === 'smtp' ? 'email.smtpAddress' : 'email.fromEmail')}
          <Input value={fromEmail} disabled={busy} onChange={(event) => { setFromEmail(event.target.value) }} />
        </label>
        <p className={css.hint}>
          {t(provider === 'smtp'
            ? 'email.smtp.hint'
            : provider === 'resend' ? 'email.from.resendHint' : 'email.from.sendgridHint')}
        </p>
        {provider === 'smtp' && (
          <label className={css.label}>{t('email.authCodeEnv')}
            <Input value={authCodeEnv} disabled={busy}
              onChange={(event) => { setAuthCodeEnv(event.target.value) }} />
          </label>
        )}
        <label className={css.label}>{t('email.fromName')}
          <Input value={fromName} disabled={busy} onChange={(event) => { setFromName(event.target.value) }} />
        </label>
        <div className={css.label}>
          {t('email.recipients')}
          <div className={css.row}>
            <Input value={recipient} disabled={busy} placeholder={t('email.recipientPlaceholder')}
              onChange={(event) => { setRecipient(event.target.value) }} />
            <Button variant="outline" size="sm" disabled={busy} onClick={addRecipient}>{t('email.addRecipient')}</Button>
          </div>
          {recipients.length === 0
            ? <span className={css.hint}>{t('email.noRecipients')}</span>
            : <ul className={css.recipients}>{recipients.map(value => (
              <li key={value}>
                <span>{value}</span>
                <button type="button" className={css.remove} disabled={busy}
                  aria-label={t('email.removeRecipient', { email: value })}
                  onClick={() => { setRecipients(recipients.filter(item => item !== value)) }}>×</button>
              </li>
            ))}
            </ul>}
        </div>
        {provider !== 'smtp' && (
          <label className={css.label}>{t('email.apiKeyEnv')}
            <Input value={apiKeyEnv} disabled={busy} onChange={(event) => { setApiKeyEnv(event.target.value) }} />
          </label>
        )}
        {config !== null && (
          <span className={config.hasKey ? css.hasKey : css.noKey}>
            {config.hasKey ? t('email.hasKey') : t('email.noKey')}
          </span>
        )}
        <Checkbox checked={dryRun} disabled={busy} label={t('email.dryRun')} onChange={setDryRun} />
        <label className={css.label}>{t('email.minInterval')}
          <Input type="number" min={0} value={minInterval} disabled={busy}
            onChange={(event) => { setMinInterval(event.target.value) }} />
        </label>
        {error !== null && <p role="alert" className={css.error}>{error}</p>}
        {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
        <details className={css.help} data-email-help>
          <summary className={css.helpSummary}>{t('email.help.title')}</summary>
          <p>{t('email.help.from')}</p>
          <p>{t('email.help.recipients')}</p>
          <p>{t('email.help.apiKey')}</p>
          <p className={css.helpSummaryLine}>{t('email.help.summary')}</p>
          <div className={css.helpSection} data-filing-group="none">
            <strong>{t('email.help.noFilingGroup')}</strong>
            <p className={css.helpGroupNote}>{t('email.help.noFilingNote')}</p>
            <ul className={css.helpLinks}>
              <li>
                <span className={css.badgeNoFiling}>{t('email.help.badgeNoFiling')}</span>
                <a href={HELP_LINKS.sendgridSignup} target="_blank" rel="noopener noreferrer">{t('email.help.sendgridSignup')}</a>
              </li>
              <li>
                <span className={css.badgeNoFiling}>{t('email.help.badgeNoFiling')}</span>
                <a href={HELP_LINKS.sendgridKeys} target="_blank" rel="noopener noreferrer">{t('email.help.sendgridKeys')}</a>
              </li>
              <li>
                <span className={css.badgeNoFiling}>{t('email.help.badgeNoFiling')}</span>
                <a href={HELP_LINKS.sendgridSender} target="_blank" rel="noopener noreferrer">{t('email.help.sendgridSender')}</a>
              </li>
            </ul>
          </div>
          <div className={css.helpSection} data-email-resend-help>
            <strong>{t('email.help.resendTitle')}</strong>
            <p className={css.helpGroupNote}>{t('email.help.resendNote')}</p>
            <ul className={css.helpLinks}>
              <li><a href={HELP_LINKS.resendSignup} target="_blank" rel="noopener noreferrer">{t('email.help.resendSignup')}</a></li>
              <li><a href={HELP_LINKS.resendKeys} target="_blank" rel="noopener noreferrer">{t('email.help.resendKeys')}</a></li>
              <li><a href={HELP_LINKS.resendDomains} target="_blank" rel="noopener noreferrer">{t('email.help.resendDomains')}</a></li>
            </ul>
          </div>
          <div className={css.helpSection} data-filing-group="required">
            <strong>{t('email.help.filingGroup')}</strong>
            <p className={css.helpGroupNote}>{t('email.help.filingNote')}</p>
            <ul className={css.helpLinks}>
              <li>
                <span className={css.badgeFiling}>{t('email.help.badgeFiling')}</span>
                <a href={HELP_LINKS.aliyun} target="_blank" rel="noopener noreferrer">{t('email.help.aliyun')}</a>
              </li>
              <li>
                <span className={css.badgeFiling}>{t('email.help.badgeFiling')}</span>
                <a href={HELP_LINKS.tencent} target="_blank" rel="noopener noreferrer">{t('email.help.tencent')}</a>
              </li>
            </ul>
          </div>
        </details>
      </div>
    </Modal>
  )
}

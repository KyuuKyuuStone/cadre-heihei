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
  readonly provider?: 'smtp'
  readonly from: { readonly email: string; readonly name?: string }
  readonly recipients: readonly string[]
  readonly smtpPreset?: 'qq' | '163'
  readonly user?: string
  readonly authCodeRef?: string
  readonly hasSecret?: boolean
  readonly dryRun?: boolean
  readonly minIntervalMs?: number
  readonly idleReminder?: { readonly enabled: boolean; readonly minutes: number }
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
  method: 'get' | 'set' | 'test' | 'dry-run' | 'secret',
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
  const code = /^((?:EMAIL|SECRET)_[A-Z_]+) ·/u.exec(message)?.[1]
  switch (code) {
    case 'EMAIL_MISSING_API_KEY': return t('email.error.missingKey')
    case 'EMAIL_AUTH_FAILED': return t('email.error.authFailed')
    case 'EMAIL_TIMEOUT': return t('email.error.timeout')
    case 'EMAIL_CONNECTION_FAILED': return t('email.error.connection')
    case 'EMAIL_SMTP_FAILED': return t('email.error.smtp')
    case 'EMAIL_CONFIG_INVALID': return t('email.error.configInvalid')
    case 'SECRET_STORE_UNAVAILABLE': return t('email.error.secretStore')
    case 'EMAIL_SECRET_EMPTY': return t('email.error.authCodeRequired')
    default: return message
  }
}

function resultText(result: EmailResult, t: PropsLocale<'sidebar'>['t']): string {
  if (result.ok) {
    return t('email.result.ok', { status: result.status ?? 'sent' })
  }
  if (result.code === 'EMAIL_MISSING_API_KEY') return t('email.error.missingKey')
  if (result.code === 'EMAIL_TIMEOUT') return t('email.error.timeout')
  if (result.code === 'EMAIL_CONNECTION_FAILED') return t('email.error.connection')
  if (result.code === 'EMAIL_SMTP_FAILED') return t('email.error.smtp')
  if (result.code === 'SECRET_STORE_UNAVAILABLE') return t('email.error.secretStore')
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
  dryRun: false,
  minIntervalMs: 60_000,
  idleReminder: { enabled: false, minutes: 10 },
  hasKey: false,
}

function isMissingConfig(message: string): boolean {
  return /ENOENT|no such file|EMAIL_CONFIG_MISSING/iu.test(message)
}


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
  const [smtpPreset, setSmtpPreset] = useState<'qq' | '163'>('qq')
  const [authCode, setAuthCode] = useState('')
  const [showAuthCode, setShowAuthCode] = useState(false)
  const [hasSecret, setHasSecret] = useState(false)
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [recipient, setRecipient] = useState('')
  const [dryRun, setDryRun] = useState(false)
  const [minInterval, setMinInterval] = useState('60000')
  const [idleEnabled, setIdleEnabled] = useState(false)
  const [idleMinutes, setIdleMinutes] = useState('10')
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
        setSmtpPreset(next.smtpPreset ?? 'qq')
        setAuthCode('')
        setShowAuthCode(false)
        setHasSecret(next.hasSecret === true
          || (next.authCodeRef !== undefined && next.hasKey))
        setFromEmail(next.from.email)
        setFromName(next.from.name ?? '')
        setRecipients([...next.recipients])
        setDryRun(next.dryRun === true)
        setMinInterval(String(next.minIntervalMs ?? 60_000))
        setIdleEnabled(next.idleReminder?.enabled === true)
        setIdleMinutes(String(next.idleReminder?.minutes ?? 10))
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const message = cause instanceof Error ? cause.message : String(cause)
        // A project without a config file is a valid first-run state, not a
        // form error; backend may still add a dedicated missing-config code.
        if (isMissingConfig(message)) {
          setConfig(DEFAULT_CONFIG)
          setEnabled(DEFAULT_CONFIG.enabled)
          setSmtpPreset(DEFAULT_CONFIG.smtpPreset ?? 'qq')
          setAuthCode('')
          setShowAuthCode(false)
          setHasSecret(false)
          setFromEmail(DEFAULT_CONFIG.from.email)
          setFromName(DEFAULT_CONFIG.from.name ?? '')
          setRecipients([...DEFAULT_CONFIG.recipients])
          setDryRun(DEFAULT_CONFIG.dryRun === true)
          setMinInterval(String(DEFAULT_CONFIG.minIntervalMs ?? 60_000))
          setIdleEnabled(DEFAULT_CONFIG.idleReminder?.enabled === true)
          setIdleMinutes(String(DEFAULT_CONFIG.idleReminder?.minutes ?? 10))
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

  const validate = (): string | null => {
    if (!validEmail(fromEmail.trim())) return t('email.error.from')
    if (recipients.length === 0) return t('email.error.noRecipients')
    if (authCode.trim() === '' && !hasSecret) return t('email.error.authCodeRequired')
    if (!/^\d+$/u.test(minInterval.trim())) return t('email.error.interval')
    if (idleEnabled && !/^\d+$/u.test(idleMinutes.trim())) return t('email.error.idleMinutes')
    if (idleEnabled) {
      const minutes = Number(idleMinutes)
      if (minutes < 1 || minutes > 1_440) return t('email.error.idleMinutes')
    }
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
    let secretSaved = false
    try {
      if (authCode.trim() !== '') {
        const secret = await emailCall('secret', {
          projectId: request.projectId,
          actorSessionId: request.sessionId,
          authCode: authCode.trim(),
        }) as { hasKey?: boolean }
        secretSaved = secret.hasKey !== false
        setHasSecret(secretSaved)
      }
      const result = await emailCall('set', {
        projectId: request.projectId,
        actorSessionId: request.sessionId,
        config: {
          enabled,
          provider: 'smtp',
          from: { email: fromEmail.trim(), ...(fromName.trim() === '' ? {} : { name: fromName.trim() }) },
          recipients,
          smtpPreset,
          user: fromEmail.trim(),
          dryRun,
          minIntervalMs: Number(minInterval),
          idleReminder: {
            enabled: idleEnabled,
            minutes: idleMinutes.trim() === '' ? 10 : Number(idleMinutes),
          },
        },
      }) as CadreEmailConfigView
      setConfig(result)
      if (secretSaved) {
        setAuthCode('')
        setShowAuthCode(false)
        setHasSecret(true)
      }
      setNotice(t('email.notice.saved'))
    } catch (cause) {
      if (secretSaved) setHasSecret(true)
      setError(emailErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const clearSecret = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await emailCall('secret', {
        projectId: request.projectId,
        actorSessionId: request.sessionId,
        action: 'clear',
      })
      setHasSecret(false)
      setAuthCode('')
      setNotice(t('email.notice.secretCleared'))
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

  const idleReminderDisabled = !enabled || recipients.length === 0
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
          <Button variant="primary" disabled={busy} onClick={() => { void save() }}>
            {busy ? t('email.saving') : t('email.save')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => { void run('test') }}>{t('email.test')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void run('dry-run') }}>{t('email.dryRunAction')}</Button>
        </div>
      )}
    >
      <div className={css.form} data-email-form>
        {config === null && error === null && <p className={css.hint}>{t('email.loading')}</p>}
        <Checkbox checked={enabled} disabled={busy} label={t('email.enabled')}
          onChange={setEnabled} />
        <label className={css.label}>{t('email.smtpPreset')}
          <select className={css.select} value={smtpPreset} disabled={busy}
            onChange={(event) => { setSmtpPreset(event.target.value === '163' ? '163' : 'qq') }}>
            <option value="qq">{t('email.smtpPreset.qq')}</option>
            <option value="163">{t('email.smtpPreset.163')}</option>
          </select>
        </label>
        <label className={css.label}>{t('email.smtpAddress')}
          <Input value={fromEmail} disabled={busy} onChange={(event) => { setFromEmail(event.target.value) }} />
        </label>
        <p className={css.hint}>{t('email.smtp.hint')}</p>
        <div className={css.label}>
          <span>{t('email.authCode')}</span>
          <div className={css.row}>
            <Input type={showAuthCode ? 'text' : 'password'} value={authCode} disabled={busy}
              placeholder={hasSecret ? t('email.authCode.savedPlaceholder') : t('email.authCode.placeholder')}
              onChange={(event) => { setAuthCode(event.target.value) }} />
            <Button variant="outline" size="sm" disabled={busy}
              onClick={() => { setShowAuthCode(value => !value) }}>
              {t(showAuthCode ? 'email.authCode.hide' : 'email.authCode.show')}
            </Button>
          </div>
          <div className={css.authStatus} data-email-auth-status>
            {hasSecret
              ? <span className={css.hasKey}>{t('email.authCode.saved')}</span>
              : config?.authCodeRef !== undefined
                ? <span className={css.noKey}>{t('email.authCode.missing')}</span>
                : <span className={css.hint}>{t('email.authCode.empty')}</span>}
            {hasSecret && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void clearSecret() }}>
                {t('email.authCode.clear')}
              </Button>
            )}
          </div>
          <details className={css.help} data-email-auth-help>
            <summary>{t('email.authCode.howTo')}</summary>
            <ol className={css.authSteps}>
              {(smtpPreset === 'qq' ? [
                t('email.authCode.qq.1'), t('email.authCode.qq.2'), t('email.authCode.qq.3'),
              ] : [
                t('email.authCode.163.1'), t('email.authCode.163.2'), t('email.authCode.163.3'),
              ]).map(step => <li key={step}>{step}</li>)}
            </ol>
            <p>{t('email.authCode.note')}</p>
          </details>
        </div>
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
        <Checkbox checked={dryRun} disabled={busy} label={t('email.dryRun')} onChange={setDryRun} />
        <label className={css.label}>{t('email.minInterval')}
          <Input type="number" min={0} value={minInterval} disabled={busy}
            onChange={(event) => { setMinInterval(event.target.value) }} />
        </label>
        <Checkbox checked={idleEnabled} disabled={busy || idleReminderDisabled}
          label={t('email.idleReminder')} onChange={setIdleEnabled} />
        <label className={css.label}>{t('email.idleMinutes')}
          <Input type="number" min={1} max={1440} value={idleMinutes}
            disabled={busy || idleReminderDisabled || !idleEnabled}
            onChange={(event) => { setIdleMinutes(event.target.value) }} />
        </label>
        <p className={css.hint}>
          {t(idleReminderDisabled ? 'email.idleReminderDisabled' : 'email.idleReminder.hint')}
        </p>
        {error !== null && <p role="alert" className={css.error}>{error}</p>}
        {notice !== null && <p role="status" className={css.notice}>{notice}</p>}
      </div>
    </Modal>
  )
}

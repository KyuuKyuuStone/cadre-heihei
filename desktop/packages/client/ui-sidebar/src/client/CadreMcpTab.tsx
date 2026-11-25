/**
 * Per-conversation MCP server enablement and non-secret override panel,
 * opened from the Conversation view tabs. The catalog route carries masked
 * environment and header keys; this panel renders those names and lets a
 * member change only an environment reference name, never a plaintext key.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CadreRosterState } from './CadreSidebar.tsx'
import {
  fetchMcpCatalog,
  McpOperationError,
  saveMcpSelection,
  secretReferenceName,
  type McpCatalogEntry,
  type McpEnvReference,
  type McpHealthRow,
  type McpSelectionEntry,
  type McpServerOverrides,
} from './cadre-mcp.ts'
import css from './CadreMcpTab.module.css'

/** Seats the MCP view needs from its plugin; the dialog request store is P2. */
export interface CadreMcpTabInjected {
  hooks: { roster: HostObservable<CadreRosterState> }
  projectOfSession(sessionId: string): string | undefined
  defaultProjectId(): string | undefined
}

type McpTabProps = {
  readonly sessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
} & InjectFace<CadreMcpTabInjected>

type Translator = PropsLocale<'sidebar'>['t']

/** Editable draft of one server row; numeric text stays a string while controlled. */
interface ServerDraft {
  readonly enabled: boolean
  readonly timeout: string
  readonly env: Readonly<Record<string, string>>
}

const TIMEOUT_PATTERN = /^[1-9]\d*$/u

const isValidTimeout = (value: string): boolean => value.trim() === '' || TIMEOUT_PATTERN.test(value.trim())

const draftOf = (entry: McpCatalogEntry): ServerDraft => ({
  enabled: entry.enabled,
  timeout: entry.overrides?.toolCallTimeoutMs === undefined ? '' : String(entry.overrides.toolCallTimeoutMs),
  env: Object.fromEntries((entry.envKeys ?? []).map(name =>
    [name, secretReferenceName(entry.overrides?.env?.[name]) ?? ''])),
})

const asMcpError = (cause: unknown, t: Translator): McpOperationError => cause instanceof McpOperationError
  ? cause
  : new McpOperationError('MCP_REQUEST_FAILED', t('mcp.requestFailed'), t('mcp.error.retryHint'))

/** One Session's MCP server catalog, editable only by that Session's member. */
export function CadreMcpTab({ sessionId, useRoster, projectOfSession, defaultProjectId, t }: McpTabProps) {
  const { members, status: rosterStatus, error: rosterError } = useRoster(state => state)
  const member = members.find(item => item.sessionId === sessionId)
  const projectId = projectOfSession(sessionId) ?? defaultProjectId()
  const [entries, setEntries] = useState<readonly McpCatalogEntry[]>([])
  const [health, setHealth] = useState<readonly McpHealthRow[]>([])
  const [drafts, setDrafts] = useState<Readonly<Record<string, ServerDraft>>>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<McpOperationError | null>(null)
  const [validation, setValidation] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (projectId === undefined || member?.state === 'departed'
      || (member === undefined && rosterStatus !== 'ready')) return
    const request = ++requestVersion.current
    setBusy(true)
    setError(null)
    try {
      const catalog = await fetchMcpCatalog(projectId, sessionId, sessionId, navigator.language, t)
      if (request !== requestVersion.current) return
      setEntries(catalog.servers)
      setHealth(catalog.health)
      setDrafts(Object.fromEntries(catalog.servers.map(entry => [entry.id, draftOf(entry)])))
      setLoaded(true)
    } catch (cause) {
      if (request === requestVersion.current) setError(asMcpError(cause, t))
    } finally {
      if (request === requestVersion.current) setBusy(false)
    }
  }, [member, projectId, rosterStatus, sessionId, t])

  useEffect(() => {
    void load()
    return () => { requestVersion.current += 1 }
  }, [load])

  const setDraft = (id: string, patch: Partial<ServerDraft>): void => {
    setDrafts(current => ({ ...current, [id]: { ...current[id]!, ...patch } }))
  }

  // The set route echoes the persisted selection, so a write needs one round
  // trip: the directory itself did not change.
  const applySelection = (selection: readonly McpSelectionEntry[]): void => {
    const byId = new Map(selection.map(item => [item.id, item]))
    setDrafts(Object.fromEntries(entries.map((entry) => {
      const selected = byId.get(entry.id)
      return [entry.id, {
        enabled: selected?.enabled === true,
        timeout: selected?.overrides?.toolCallTimeoutMs === undefined
          ? ''
          : String(selected.overrides.toolCallTimeoutMs),
        env: Object.fromEntries((entry.envKeys ?? []).map(name =>
          [name, secretReferenceName(selected?.overrides?.env?.[name]) ?? ''])),
      }]
    })))
  }

  if (member?.state === 'departed') return null
  if (member === undefined && rosterStatus !== 'ready') {
    if (rosterStatus === 'error' && rosterError !== null) {
      return <section className={css.page}><p className={css.error} role="alert">{rosterError}</p></section>
    }
    return null
  }
  if (projectId === undefined) {
    return <section className={css.page}><p className={css.error} role="alert">{t('mcp.tab.noProject')}</p></section>
  }
  const save = async (): Promise<void> => {
    setError(null)
    setValidation(null)
    setNotice(null)
    const invalid = entries.find((entry) => {
      const draft = drafts[entry.id]!
      return draft.enabled && !isValidTimeout(draft.timeout)
    })
    if (invalid !== undefined) {
      setValidation(t('mcp.override.invalidTimeout'))
      return
    }
    const servers = entries.map((entry): McpSelectionEntry => {
      const draft = drafts[entry.id]!
      if (!draft.enabled) return { id: entry.id, enabled: false }
      const env: Record<string, McpEnvReference> = {}
      for (const [name, value] of Object.entries(draft.env)) {
        const reference = value.trim()
        if (reference !== '') env[name] = { fromEnv: reference }
      }
      const timeout = draft.timeout.trim()
      const overrides: McpServerOverrides = {
        ...(timeout === '' ? {} : { toolCallTimeoutMs: Number(timeout) }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      }
      return Object.keys(overrides).length === 0
        ? { id: entry.id, enabled: true }
        : { id: entry.id, enabled: true, overrides }
    })
    setBusy(true)
    try {
      const persisted = await saveMcpSelection(projectId, sessionId, sessionId, servers, t)
      applySelection(persisted.servers)
      setNotice(t('mcp.tab.saved'))
    } catch (cause) {
      setError(asMcpError(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const invalidHealth = health.filter(row => row.state === 'invalid')
  const enabledCount = entries.filter(entry => drafts[entry.id]!.enabled).length
  const renderCard = (entry: McpCatalogEntry) => {
    const draft = drafts[entry.id]!
    const envKeys = entry.envKeys ?? []
    const headerKeys = entry.headerKeys ?? []
    return (
      <li key={entry.id} className={draft.enabled ? `${css.card} ${css.cardSelected}` : css.card} data-mcp-card>
        <div className={css.cardHead}>
          <Checkbox checked={draft.enabled} label={entry.name}
            onChange={(next) => { setDraft(entry.id, { enabled: next }) }} />
          <span className={css.cardTransport}>{entry.transport}</span>
        </div>
        <p className={css.cardDescription}>{entry.description}</p>
        {(envKeys.length > 0 || headerKeys.length > 0) && (
          <ul className={css.references}>
            {envKeys.map((name) => {
              const override = entry.overrides?.env?.[name]
              const reference = secretReferenceName(override)
              return (
                <li key={`env:${name}`} className={css.reference}>
                  <span className={css.referenceName}>{t('mcp.env.name', { name })}</span>
                  <span className={css.referenceValue}>
                    {override === undefined
                      ? t('mcp.reference.catalog')
                      : reference === undefined ? t('mcp.secret.hidden') : t('mcp.reference', { fromEnv: reference })}
                  </span>
                </li>
              )
            })}
            {headerKeys.map(name => (
              <li key={`header:${name}`} className={css.reference}>
                <span className={css.referenceName}>{t('mcp.headers.name', { name })}</span>
              </li>
            ))}
          </ul>
        )}
        {draft.enabled && (
          <div className={css.overrides} data-mcp-overrides>
            <span className={css.overridesTitle}>{t('mcp.override.title')}</span>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('mcp.override.timeout')}</span>
              <Input
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.timeout}
                placeholder={t('mcp.override.inherit')}
                aria-label={t('mcp.override.timeoutLabel', { name: entry.name })}
                onChange={(event) => { setDraft(entry.id, { timeout: event.target.value }) }}
              />
            </label>
            {envKeys.map(name => (
              <label key={name} className={css.field}>
                <span className={css.fieldLabel}>{t('mcp.override.envLabel', { name })}</span>
                <Input
                  value={draft.env[name]!}
                  placeholder={t('mcp.override.envPlaceholder')}
                  aria-label={t('mcp.override.envLabel', { name })}
                  onChange={(event) => {
                    setDraft(entry.id, { env: { ...draft.env, [name]: event.target.value } })
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </li>
    )
  }
  return (
    <section className={css.page} data-cadre-mcp-tab>
      <header className={css.header}>
        <div>
          <h1>{t('mcp.tab.title')}</h1>
          <p>{t('mcp.tab.description')}</p>
        </div>
      </header>
      <div className={css.summary}>
        <span className={css.count}>{t('mcp.tab.count', { count: String(enabledCount) })}</span>
        <span className={css.total}>{t('mcp.installDir')}</span>
      </div>
      {invalidHealth.length > 0 && (
        <p className={css.health} role="status" data-mcp-health>
          {t('mcp.health.warning', {
            count: String(invalidHealth.length),
            ids: invalidHealth.map(row => row.id).join(', '),
          })}
        </p>
      )}
      {busy && !loaded
        ? <div className={css.empty} role="status" data-mcp-loading><p>{t('mcp.loading')}</p></div>
        : entries.length === 0
          ? error === null
            ? (
              <div className={css.empty} data-mcp-empty>
                <span aria-hidden="true">✦</span>
                <p>{t('mcp.empty')}</p>
              </div>
            )
            : null
          : <ul className={css.cards}>{entries.map(renderCard)}</ul>}
      {error !== null && (
        <div className={css.error} role="alert" data-mcp-error>
          <span className={css.errorCode}>{error.code}</span>
          <p className={css.errorMessage}>{error.detail}</p>
          {error.remediation !== undefined && <p className={css.errorRemediation}>{error.remediation}</p>}
        </div>
      )}
      {validation !== null && <p className={css.error} role="alert">{validation}</p>}
      {notice !== null && <p className={css.notice} role="status">{notice}</p>}
      <div className={css.footer}>
        <Button variant="primary" disabled={busy || !loaded} onClick={() => { void save() }}>{t('mcp.save')}</Button>
      </div>
    </section>
  )
}
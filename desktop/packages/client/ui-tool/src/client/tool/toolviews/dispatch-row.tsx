/**
 * W2 dispatch status row.
 *
 * Replaces the generic Tool row for `dispatch_task` / `retry_dispatch` in the
 * supervisor conversation. The row reads the persisted `presentationMeta`
 * (`dispatched` / `failed`) — never the rendered text — so wording changes do
 * not affect the card. Running → 拆解中; settled → per-item dispatch / failure
 * rows; then it joins the ledger so the same bar can show the flow back
 * (已交付，组长正在审).
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Button,
  IconBranchOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type Translate = TranslateNS<'conversation'>

const INK_PRIMARY = 'var(--dsw-alias-label-primary)'
const INK_SECONDARY = 'var(--dsw-alias-label-secondary)'
const INK_ERROR = 'var(--dsw-alias-state-error-primary)'

/** One dispatched item from `meta.dispatched`. */
interface DispatchedItem {
  readonly taskId: string
  readonly assigneeName: string
  readonly role: string
  readonly dueAt: string
}

/** One refused item from `meta.failed`; `pendingId` lets the row retry it. */
interface FailedItem {
  readonly target: string
  readonly reason: string
  readonly retryable: boolean
  readonly pendingId?: string
}

/** The structured card payload persisted with the tool result. */
interface DispatchMeta {
  readonly dispatched: readonly DispatchedItem[]
  readonly failed: readonly FailedItem[]
}

/** Outcome of one `retry_dispatch(pendingId)` call through the desktop bridge. */
export interface RetryOutcome {
  readonly ok: boolean
  readonly dispatched?: readonly DispatchedItem[]
  readonly failed?: readonly FailedItem[]
  readonly message?: string
}

/** Retry seam: replay one queued failure by its pending id. */
export interface DispatchRowInjected {
  retry(pendingId: string): Promise<RetryOutcome>
  /** Resolve the current Session's project at call time; a stale closure would query the wrong ledger. */
  resolveProjectId?(): string | undefined
}

type DispatchRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<DispatchRowInjected>

/** Minimal ledger row joined by task id for the returned state. */
interface LedgerRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
}

/** Optional desktop ledger bridge; the web shell simply has no join source. */
interface LedgerBridge {
  listTasks?(query?: { projectId?: string }): Promise<{ rows?: readonly LedgerRow[] } | undefined>
}

/** Structural validation: any malformed row rejects the whole payload. */
function asMeta(value: unknown): DispatchMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { dispatched?: unknown; failed?: unknown }
  if (!Array.isArray(record.dispatched) || !Array.isArray(record.failed)) return null
  const dispatched: DispatchedItem[] = []
  for (const raw of record.dispatched) {
    if (typeof raw !== 'object' || raw === null) return null
    const row = raw as Record<string, unknown>
    if (typeof row.taskId !== 'string' || typeof row.assigneeName !== 'string'
      || typeof row.role !== 'string' || typeof row.dueAt !== 'string') return null
    dispatched.push({ taskId: row.taskId, assigneeName: row.assigneeName, role: row.role, dueAt: row.dueAt })
  }
  const failed: FailedItem[] = []
  for (const raw of record.failed) {
    if (typeof raw !== 'object' || raw === null) return null
    const row = raw as Record<string, unknown>
    if (typeof row.target !== 'string' || typeof row.reason !== 'string' || typeof row.retryable !== 'boolean') return null
    if (row.pendingId !== undefined && typeof row.pendingId !== 'string') return null
    failed.push({
      target: row.target,
      reason: row.reason,
      retryable: row.retryable,
      ...(typeof row.pendingId === 'string' && row.pendingId !== '' ? { pendingId: row.pendingId } : {}),
    })
  }
  return { dispatched, failed }
}

/** Concatenate recorded text blocks; used only for an error or legacy fallback. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** `MM-DD HH:mm` in local time; invalid or empty timestamps stay visible. */
function dueText(iso: string, t: Translate): string {
  if (iso === '') return t('dispatch.dueUnset')
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** A reason the Host marked as pending hand-off (offline / not found / departed). */
function isPendingHandoff(reason: string): boolean {
  return reason.startsWith('待派') || reason.includes('离线')
    || reason.includes('找不到') || reason.includes('离职')
}

function accent(tone: 'neutral' | 'danger' | 'warning'): string {
  if (tone === 'danger') return 'var(--dsw-alias-state-error-primary)'
  if (tone === 'warning') return 'var(--dsw-alias-state-warn-primary)'
  return 'var(--dsw-alias-label-primary)'
}

function BarShell({ tone, children }: { readonly tone: 'neutral' | 'danger' | 'warning'; readonly children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        minWidth: 0,
      }}
    >
      <span style={{ width: 3, flex: 'none', alignSelf: 'stretch', borderRadius: 1, background: accent(tone) }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function Headline({ icon, title, tag, tagTone = 'neutral' }: {
  readonly icon?: ReactNode
  readonly title: string
  readonly tag?: string
  readonly tagTone?: 'neutral' | 'success' | 'info' | 'warning' | 'danger'
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {icon}
      <span style={{ flex: 1, minWidth: 0, color: INK_PRIMARY, fontWeight: 500 }}>{title}</span>
      {tag === undefined ? null : <Tag tone={tagTone}>{tag}</Tag>}
    </div>
  )
}

function RunningBar({ t }: { readonly t: Translate }) {
  return (
    <BarShell tone="neutral">
      <Headline
        icon={<StateDot state="ongoing" />}
        title={t('dispatch.running')}
        tag={t('dispatch.runningTag')}
        tagTone="info"
      />
      <span style={{ color: INK_SECONDARY, fontSize: 12 }}>
        {t('dispatch.runningHint')}
      </span>
    </BarShell>
  )
}

/**
 * One dispatch tool call as a status bar.
 * @param props - recorded phase/block, session identity, and the retry seam.
 * @returns the status bar for running, success, partial, or failure.
 */
export function DispatchStatusRow(props: DispatchRowProps) {
  const { t } = props
  const [ledger, setLedger] = useState<ReadonlyMap<string, LedgerRow>>(new Map())
  const [syncError, setSyncError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [addedDispatched, setAddedDispatched] = useState<readonly DispatchedItem[]>([])
  /** pendingId → null when the retry succeeded, or the replacement failure row. */
  const [resolved, setResolved] = useState<ReadonlyMap<string, FailedItem | null>>(new Map())
  const [retryNotices, setRetryNotices] = useState<ReadonlyMap<string, { tone: 'neutral' | 'danger'; text: string }>>(new Map())

  const meta: DispatchMeta | null = props.phase === 'result' ? asMeta(props.block.meta) : null
  const dispatched = [...(meta?.dispatched ?? []), ...addedDispatched]
  const failed = (meta?.failed ?? []).flatMap((item) => {
    if (item.pendingId === undefined || !resolved.has(item.pendingId)) return [item]
    const replacement = resolved.get(item.pendingId)
    return replacement === null || replacement === undefined ? [] : [replacement]
  })
  const taskKey = dispatched.map(item => item.taskId).join(',')

  // Join the ledger for the returned tasks so the same bar can show the flow
  // back (delivered → review). Poll for two minutes, then leave the last view.
  useEffect(() => {
    if (taskKey === '') return
    const list = typeof window === 'undefined'
      ? undefined
      : (window as unknown as { cadre?: LedgerBridge }).cadre?.listTasks
    if (list === undefined) {
      setSyncError(t('dispatch.sync.channelMissing'))
      return
    }
    let cancelled = false
    const tick = async () => {
      const projectId = props.resolveProjectId?.()
      if (projectId === undefined) {
        setSyncError(t('dispatch.sync.noProject'))
        return
      }
      try {
        const response = await list({ projectId })
        if (cancelled) return
        if (response === undefined || !Array.isArray(response.rows)) {
          setSyncError(t('dispatch.sync.rowsMissing'))
          return
        }
        setSyncError(null)
        const rows = response.rows as readonly LedgerRow[]
        setLedger(new Map(rows.map(row => [row.taskId, row])))
      } catch (error) {
        if (cancelled) return
        // Keep the last snapshot, but make the failed join visible instead of
        // letting the card imply that the ledger still agrees with it.
        setSyncError(t('dispatch.sync.failed', { message: error instanceof Error ? error.message : String(error) }))
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 5000)
    const stop = window.setTimeout(() => { window.clearInterval(timer) }, 120_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(stop)
    }
  }, [taskKey, t])

  if (props.phase !== 'result') return <RunningBar t={t} />

  const block = props.block
  if (block.isError) {
    const reason = block.error?.reason ?? (textOf(block.content).trim() || t('dispatch.failedDefault'))
    return (
      <BarShell tone="danger">
        <Headline title={t('dispatch.failedTitle')} tag={t('dispatch.notDispatched')} tagTone="danger" />
        <span style={{ color: INK_PRIMARY, fontSize: 13 }}>{reason}</span>
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('dispatch.failedHint')}</span>
      </BarShell>
    )
  }

  // Results recorded before the structured meta landed keep their recorded
  // text visible, but are never reinterpreted as fresh dispatch data.
  if (meta === null) {
    const raw = textOf(block.content).trim()
    return (
      <BarShell tone="neutral">
        <Headline title={t('dispatch.result')} tag={t('dispatch.legacyTag')} />
        <span style={{ color: INK_PRIMARY, fontSize: 12 }}>{raw || t('dispatch.noStructured')}</span>
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('dispatch.legacyHint')}</span>
      </BarShell>
    )
  }

  const groups = new Map<string, number>()
  for (const item of dispatched) groups.set(item.assigneeName, (groups.get(item.assigneeName) ?? 0) + 1)
  const groupText = [...groups].map(([name, count]) => t('dispatch.groupItem', { name, count })).join(' · ')
  const partial = dispatched.length > 0 && failed.length > 0
  const allFailed = dispatched.length === 0
  if (allFailed && failed.length === 0) {
    return (
      <BarShell tone="neutral">
        <Headline title={t('dispatch.result')} tag={t('dispatch.emptyTag')} />
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('dispatch.emptyHint')}</span>
      </BarShell>
    )
  }
  const dueValues = [...new Set(dispatched.map(item => item.dueAt).filter(value => value !== ''))]
  const dueSummary = dueValues.length === 0
    ? ''
    : dueValues.length === 1
      ? t('dispatch.due', { time: dueText(dueValues[0] ?? '', t) })
      : t('dispatch.dueEarliest', { time: dueText(dueValues[0] ?? '', t) })
  const headline = allFailed
    ? t('dispatch.allFailed', { count: failed.length })
    : partial
      ? t('dispatch.partial', { dispatched: dispatched.length, failed: failed.length })
      : t('dispatch.assigned', { groups: groupText })
  const tone: 'neutral' | 'danger' | 'warning' = allFailed
    ? 'danger'
    : failed.length > 0
      ? 'warning'
      : 'neutral'

  const statusLines = dispatched.flatMap((item) => {
    const row = ledger.get(item.taskId)
    if (row === undefined) return []
    const title = row.title === '' ? item.taskId : row.title
    if (row.status === 'delivered') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.delivered')}`]
    if (row.status === 'review') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.review')}`]
    if (row.status === 'verified') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.verified')}`]
    if (row.status === 'rework') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.rework')}`]
    if (row.status === 'failed') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.failed')}`]
    if (row.status === 'in_progress') return [`${item.assigneeName} · ${title} — ${t('dispatch.status.inProgress')}`]
    return []
  })

  const setNotice = (pendingId: string, notice: { tone: 'neutral' | 'danger'; text: string } | null): void => {
    setRetryNotices((previous) => {
      const next = new Map(previous)
      if (notice === null) next.delete(pendingId)
      else next.set(pendingId, notice)
      return next
    })
  }

  const onRetry = async (item: FailedItem): Promise<void> => {
    const pendingId = item.pendingId
    if (pendingId === undefined) return
    setRetrying(pendingId)
    setNotice(pendingId, null)
    try {
      const outcome = await props.retry(pendingId)
      if (outcome.ok) {
        const landed = outcome.dispatched ?? []
        setAddedDispatched(previous => [...previous, ...landed])
        setResolved(previous => new Map(previous).set(pendingId, null))
        setNotice(pendingId, { tone: 'neutral', text: landed.length > 0 ? t('dispatch.retryDispatched') : t('dispatch.retryOk') })
        return
      }
      const replacement = outcome.failed?.[0]
      if (replacement !== undefined) setResolved(previous => new Map(previous).set(pendingId, replacement))
      setNotice(pendingId, { tone: 'danger', text: outcome.message ?? replacement?.reason ?? t('dispatch.retryFailed') })
    } catch (error) {
      setNotice(pendingId, {
        tone: 'danger',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRetrying(null)
    }
  }

  return (
    <BarShell tone={tone}>
      <Headline
        icon={<IconBranchOutlineRegular size={14} />}
        title={headline}
        tag={allFailed ? t('dispatch.tag.failed') : partial ? t('dispatch.tag.partial') : t('dispatch.tag.dispatched')}
        tagTone={allFailed ? 'danger' : partial ? 'warning' : 'success'}
      />
      {dispatched.length > 0 && (
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>
          {t('dispatch.total', { count: dispatched.length })}
          {dueSummary === '' ? '' : ` · ${dueSummary}`}
        </span>
      )}

      {dispatched.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {dispatched.map(item => (
            <Tag key={item.taskId} tone="neutral">
              {`${item.assigneeName} · ${ledger.get(item.taskId)?.title || item.taskId}`}
            </Tag>
          ))}
        </div>
      )}

      {statusLines.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: '0.5px solid var(--dsw-alias-border-l1)', paddingTop: 6 }}>
          {statusLines.map(line => (
            <span key={line} style={{ color: INK_PRIMARY, fontSize: 12 }}>{line}</span>
          ))}
        </div>
      )}

      {syncError !== null && (
        <span role="status" style={{ color: INK_ERROR, fontSize: 12 }}>{syncError}</span>
      )}

      {failed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {failed.map(item => {
            const pending = isPendingHandoff(item.reason)
            const canRetry = item.retryable && item.pendingId !== undefined
            const notice = item.pendingId === undefined ? undefined : retryNotices.get(item.pendingId)
            return (
              <div key={`${item.pendingId ?? ''}:${item.target}:${item.reason}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag tone={pending ? 'warning' : 'danger'}>{pending ? t('dispatch.pendingTag') : t('dispatch.tag.failed')}</Tag>
                <span style={{ flex: 1, minWidth: 0, color: INK_PRIMARY, fontSize: 12 }}>
                  {`${item.target} · ${item.reason}`}
                </span>
                {pending && canRetry && (
                  <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('dispatch.pendingHint')}</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRetry || retrying !== null}
                  title={canRetry ? undefined : t('dispatch.notRetryable')}
                  onClick={() => { void onRetry(item) }}
                >
                  {retrying === item.pendingId ? t('dispatch.retrying') : t('dispatch.retry')}
                </Button>
                {notice !== undefined && (
                  <span
                    role={notice.tone === 'danger' ? 'alert' : 'status'}
                    style={{ color: notice.tone === 'danger' ? INK_ERROR : INK_SECONDARY, fontSize: 12 }}
                  >
                    {notice.text}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {allFailed && (
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('dispatch.allFailedHint')}</span>
      )}
    </BarShell>
  )
}

/** Minimal Workspace lookup used to address the ledger by the calling Session's project. */
interface WorkspaceSessionIndex {
  readonly list: {
    getSnapshot(): { readonly items: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[] }
  }
}

/** Registers the dispatch status row; retry replays one pending id over the app channel. */
export const dispatchToolview = {
  name: 'dispatch-toolview',
  inject: ['slots', 'workspaces', 'locale'],
  apply(ctx: Context): void {
    const workspaces = ctx.get('workspaces') as WorkspaceSessionIndex | undefined
    ctx.slots.inject('tool.call.toolview', function* () {
      const render = (sessionId: string) => ({
        resolveProjectId: (): string | undefined => workspaces?.list.getSnapshot().items
          .find(item => item.sessionIds.some(id => id === sessionId))?.workspaceId,
        retry: async (pendingId: string): Promise<RetryOutcome> => {
          try {
            const response = await fetch('/cadre/retry-dispatch', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pendingId, dispatcherSessionId: sessionId }),
            })
            const payload = await response.json().catch(() => undefined) as RetryOutcome | undefined
            if (!response.ok) {
              return {
                ok: false,
                message: payload?.message ?? ctx.locale.bind(NS)('dispatch.retryHttpFailed', { status: response.status }),
              }
            }
            return payload ?? { ok: false, message: ctx.locale.bind(NS)('dispatch.retryNoResult') }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) }
          }
        },
      })
      const register = (key: string) => ctx.slots.register({
        name: 'tool.call.toolview',
        key,
        locale: NS,
        inject: (sessionId: string) => render(sessionId),
      }, DispatchStatusRow)
      yield register('dispatch_task')
      yield register('retry_dispatch')
    })
  },
}

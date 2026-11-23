/**
 * Read-only project ledger overlay (one project, one book).
 *
 * Opened from the project row's 台账 button and rendered over the current
 * conversation so closing it returns to the same Session. Six columns plus a
 * per-row event timeline; no dispatch, transition, or message actions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Modal, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  type CadreStallState,
  type CadreStallTaskView,
  executionOf,
  executionText,
  lastErrorText,
  lastErrorTooltip,
  stallStateText,
} from './cadre-stall.ts'
import css from './CadreLedgerOverlay.module.css'
import type { SidebarKey } from './locales.ts'


/** One overlay request raised by a project row. */
export interface CadreLedgerRequest {
  readonly projectId: string
  readonly label: string
  readonly cwd?: string
  readonly token: number
}

export interface CadreLedgerInjected {
  hooks: {
    request: HostObservable<CadreLedgerRequest | null>
    stall: HostObservable<CadreStallState>
  }
  closeLedger: () => void
  retryStall: () => void
}

interface LedgerReport {
  readonly messageId: string
  readonly reporterSessionId: string
  readonly reporterName: string
  readonly summary: string
  readonly preview: string
  readonly deliverables: readonly string[]
  readonly receivedAt: string
  readonly deliveryState: string
}

interface LedgerEvent {
  readonly fromStatus: string | null
  readonly toStatus: string
  readonly actorSessionId: string
  readonly actorName?: string
  readonly reason?: string
  readonly at: string
}

interface LedgerRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly assigneeSessionId: string
  readonly updatedAt: string
  readonly dueAt?: string
  readonly assigneeName?: string
  readonly assigneeTitle?: string
  readonly assigneeRole?: string
  readonly latestReport?: LedgerReport
  readonly events?: readonly LedgerEvent[]
}

interface LedgerBridge {
  listTasks?(query: { projectId: string }): Promise<{
    projectId?: string
    rows?: readonly LedgerRow[]
    elapsedMs?: number
  } | undefined>
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly rows: readonly LedgerRow[]; readonly elapsedMs?: number }
  | { readonly kind: 'error'; readonly reason: string }

type Filter = 'all' | 'active' | 'pending' | 'done'

const PAGE_SIZE = 20

/** Page slots for a compact window such as `1 … 4 5 6 … 10`. */
export function ledgerPageWindow(current: number, total: number): readonly (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const pages = new Set<number>([1, total, current - 1, current, current + 1])
  if (current <= 3) for (const page of [2, 3, 4]) pages.add(page)
  if (current >= total - 2) for (const page of [total - 3, total - 2, total - 1]) pages.add(page)
  const sorted = [...pages].filter(page => page >= 1 && page <= total).sort((left, right) => left - right)
  const slots: (number | 'ellipsis')[] = []
  let previous = 0
  for (const page of sorted) {
    if (page - previous > 1) slots.push('ellipsis')
    slots.push(page)
    previous = page
  }
  return slots
}

const FILTERS: readonly { readonly id: Filter; readonly labelKey: SidebarKey }[] = [
  { id: 'all', labelKey: 'ledger.filter.all' },
  { id: 'active', labelKey: 'status.inProgress' },
  { id: 'pending', labelKey: 'status.pendingReview' },
  { id: 'done', labelKey: 'status.done' },
]

const STATUS_KEYS: Readonly<Record<string, SidebarKey>> = {
  dispatched: 'status.inProgress',
  accepted: 'status.inProgress',
  in_progress: 'status.inProgress',
  delivered: 'status.pendingReview',
  review: 'status.pendingReview',
  verified: 'status.done',
  rework: 'status.rework',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
}

function statusLabel(status: string, t: PropsLocale<'sidebar'>['t']): string {
  const key = STATUS_KEYS[status]
  return key === undefined ? status : t(key)
}

function filterOf(status: string): Filter {
  switch (status) {
    case 'dispatched':
    case 'accepted':
    case 'in_progress':
    case 'rework':
      return 'active'
    case 'delivered':
    case 'review':
      return 'pending'
    case 'verified':
      return 'done'
    default:
      return 'all'
  }
}

/** Acceptance result is read from status plus the recorded report; never invented. */
function acceptanceText(row: LedgerRow, t: PropsLocale<'sidebar'>['t']): string {
  switch (row.status) {
    case 'delivered': return t('ledger.acceptance.delivered')
    case 'review': return t('ledger.acceptance.review')
    case 'verified': return t('ledger.acceptance.verified')
    case 'rework': return t('ledger.acceptance.rework')
    case 'failed': return t('ledger.acceptance.failed')
    case 'cancelled': return t('ledger.acceptance.cancelled')
    default: return '—'
  }
}

function timeText(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function dueText(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  return timeText(iso)
}

/** Dispatch time is the created event; `updatedAt` moves on every transition. */
function dispatchedAtOf(row: LedgerRow): string {
  return row.events?.find(event => event.fromStatus === null)?.at ?? row.updatedAt
}

/** Statuses whose work is still outstanding; only these can be overdue. */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'dispatched', 'accepted', 'in_progress', 'rework', 'delivered', 'review',
])

/**
 * Due timestamps are overdue only when they parse, are strictly earlier than
 * now, and the task is still open. A closed task (verified/failed/cancelled)
 * keeps its due time as plain history: flagging it red forever would mark
 * every finished row overdue once its deadline passes.
 * @param dueAt - recorded deadline, ISO-8601 or absent.
 * @param now - epoch ms to compare against.
 * @param status - ledger task status.
 * @returns whether the open task is past its deadline.
 */
export function isCadreTaskOverdue(dueAt: string | undefined, now: number, status: string): boolean {
  if (!OPEN_STATUSES.has(status)) return false
  if (dueAt === undefined || dueAt === '') return false
  const at = Date.parse(dueAt)
  return !Number.isNaN(at) && at < now
}

/** Keep the overdue marker current while the overlay stays open. */
function useLedgerNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [])
  return now
}

function positionText(row: LedgerRow, t: PropsLocale<'sidebar'>['t']): string {
  const title = row.assigneeTitle?.trim()
  if (title !== undefined && title !== '') return title
  return row.assigneeRole === 'supervisor' ? t('role.supervisor') : t('role.worker')
}

function deliverablesText(row: LedgerRow, t: PropsLocale<'sidebar'>['t']): string {
  const items = row.latestReport?.deliverables ?? []
  if (items.length === 0) return '—'
  if (items.length === 1) return items[0] ?? '—'
  return t('ledger.fileCount', { count: String(items.length) })
}

function matches(row: LedgerRow, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return row.title.toLowerCase().includes(needle)
    || (row.assigneeName ?? row.assigneeSessionId).toLowerCase().includes(needle)
    || (row.latestReport?.deliverables ?? []).some(item => item.toLowerCase().includes(needle))
}

/**
 * The overlay body; separate from the host so every request remounts fresh
 * state (search, filter, expansion) without a reset effect.
 */
export function CadreLedgerOverlay({
  useRequest, useStall, closeLedger, retryStall, t,
}: PropsRuntime<'shell.overlay'> & InjectFace<CadreLedgerInjected> & PropsLocale<'sidebar'>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return (
    <LedgerBody
      key={`${request.projectId}:${String(request.token)}`}
      request={request}
      closeLedger={closeLedger}
      useStall={useStall}
      retryStall={retryStall}
      t={t}
    />
  )
}

function LedgerBody({ request, closeLedger, useStall, retryStall, t }: {
  readonly request: CadreLedgerRequest
  readonly closeLedger: () => void
  readonly useStall: InjectFace<CadreLedgerInjected>['useStall']
  readonly retryStall: () => void
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<string | null>(null)
  const now = useLedgerNow()
  const stallProject = useStall(state => state.byProject.get(request.projectId))
  const stallTasks = useMemo(
    () => new Map<string, CadreStallTaskView>((stallProject?.tasks ?? []).map(task => [task.taskId, task])),
    [stallProject],
  )

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' })
    const bridge = (window as unknown as { cadre?: LedgerBridge }).cadre
    if (bridge?.listTasks === undefined) {
      setLoad({ kind: 'error', reason: t('ledger.channelMissing') })
      return
    }
    void bridge.listTasks({ projectId: request.projectId }).then((result) => {
      if (result === undefined || !Array.isArray(result.rows)) {
        setLoad({ kind: 'error', reason: t('ledger.rowsMissing') })
        return
      }
      setLoad({
        kind: 'ready',
        rows: result.rows,
        ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
      })
    }).catch((reason: unknown) => {
      setLoad({ kind: 'error', reason: reason instanceof Error ? reason.message : String(reason) })
    })
  }, [request.projectId, t])

  useEffect(() => { reload() }, [reload])

  const rows = load.kind === 'ready' ? load.rows : []
  const visible = rows
    .filter(row => filter === 'all' || filterOf(row.status) === filter)
    .filter(row => matches(row, query.trim()))
  const counts = {
    all: rows.length,
    active: rows.filter(row => filterOf(row.status) === 'active').length,
    pending: rows.filter(row => filterOf(row.status) === 'pending').length,
    done: rows.filter(row => filterOf(row.status) === 'done').length,
  }
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const summary = load.kind === 'ready'
    ? t('ledger.summary', {
      total: String(counts.all),
      active: String(counts.active),
      pending: String(counts.pending),
      done: String(counts.done),
    })
    : load.kind === 'loading' ? t('ledger.loading') : load.reason

  return (
    <Modal
      open
      onClose={closeLedger}
      title={t('ledger.title', { label: request.label })}
      description={request.cwd === undefined ? summary : `${request.cwd} · ${summary}`}
      closeLabel={t('dialog.close')}
      className={css.dialog ?? ''}
      contentClassName={css.content ?? ''}
      footer={<Button variant="outline" onClick={closeLedger}>{t('dialog.close')}</Button>}
    >
      <div className={css.ledgerBody}>
        <div className={css.toolbar}>
          <Input
            value={query}
            placeholder={t('ledger.searchPlaceholder')}
            aria-label={t('ledger.searchAria')}
            onChange={(event) => { setQuery(event.target.value); setPage(1) }}
          />
          <Button variant="outline" size="sm" onClick={reload}>{t('ledger.refresh')}</Button>
        </div>

        {stallProject?.status === 'error' && (
          <div className={css.stallError} role="alert">
            <span>{t('stall.card.viewError', {
              message: stallProject.error ?? t('stall.readFailed'),
            })}</span>
            <Button variant="outline" size="sm" onClick={retryStall}>{t('stall.retry')}</Button>
          </div>
        )}
        {stallProject?.stale === true && (
          <p className={css.hint} role="status">{t('stall.card.ledgerStale')}</p>
        )}

        <div className={css.filters} role="radiogroup" aria-label={t('ledger.filtersAria')}>
          {FILTERS.map(item => (
            <Button
              key={item.id}
              variant={filter === item.id ? 'primary' : 'outline'}
              size="sm"
              onClick={() => { setFilter(item.id); setPage(1) }}
            >
              {t(item.labelKey)} {counts[item.id]}
            </Button>
          ))}
        </div>

        {load.kind === 'loading' && <p role="status" className={css.hint}>{t('ledger.loading')}</p>}
        {load.kind === 'error' && (
          <div className={css.errorBox} role="alert">
            <span>{load.reason}</span>
            <span className={css.hint}>{t('ledger.errorHint')}</span>
          </div>
        )}
        {load.kind === 'ready' && rows.length === 0 && (
          <p role="status" className={css.hint}>{t('ledger.empty')}</p>
        )}
        {load.kind === 'ready' && rows.length > 0 && visible.length === 0 && (
          <p role="status" className={css.hint}>{t('ledger.noMatch')}</p>
        )}
        {load.kind === 'ready' && load.elapsedMs !== undefined && (
          <span className={css.hint}>{t('ledger.readonlyQuery', { ms: String(load.elapsedMs) })}</span>
        )}
        {pageRows.length > 0 && (
          <div className={css.tableScroll} data-ledger-scroll>
            <div className={css.table} role="table" aria-label={t('ledger.tableAria')}>
              <div className={css.headerRow} role="row">
                <span role="columnheader">{t('ledger.col.task')}</span>
                <span role="columnheader">{t('ledger.col.assignee')}</span>
                <span role="columnheader">{t('ledger.col.status')}</span>
                <span role="columnheader">{t('ledger.col.due')}</span>
                <span role="columnheader">{t('ledger.col.deliverables')}</span>
                <span role="columnheader">{t('ledger.col.acceptance')}</span>
              </div>
              {pageRows.map((row) => {
                const open = expanded === row.taskId
                const overdue = isCadreTaskOverdue(row.dueAt, now, row.status)
                const assigneeName = row.assigneeName ?? row.assigneeSessionId
                const position = positionText(row, t)
                const stallTask = stallTasks.get(row.taskId)
                const lastError = stallTask?.lastError ?? null
                const execution = stallTask === undefined ? null : executionOf(stallTask)
                const progress = executionText(execution, t)
                const stallText = progress !== ''
                  ? progress
                  : stallTask !== undefined
                    ? stallStateText(stallTask.stallState, stallTask.lastActivityAt, t)
                    : stallProject?.status === 'ready' && OPEN_STATUSES.has(row.status)
                      ? t('stall.activityUnknown')
                      : null
                const stallClass = progress !== ''
                  ? css.stallNormal
                  : stallTask?.stallState === 'stalled'
                    ? css.stallStalled
                    : stallTask?.stallState === 'possibly_stalled'
                      ? css.stallPossiblyStalled
                      : css.stallNormal
                return (
                  <div key={row.taskId} className={css.rowGroup} role="rowgroup">
                    <button
                      type="button"
                      role="row"
                      className={overdue ? `${css.row} ${css.overdueRow}` : css.row}
                      data-ledger-row
                      data-overdue={overdue ? 'true' : undefined}
                      data-stall-state={stallTask?.stallState}
                      data-execution-state={execution?.state}
                      aria-expanded={open}
                      onClick={() => { setExpanded(open ? null : row.taskId) }}
                    >
                      <span role="cell" className={css.taskCell}>
                        <span className={css.taskTitle}>{row.title}</span>
                        <span className={css.taskMeta} title={row.taskId}>
                          {t('ledger.dispatchedAt', { time: timeText(dispatchedAtOf(row)) })} · {row.taskId.slice(0, 8)}
                        </span>
                        {stallText !== null && <span className={`${css.taskStall} ${stallClass}`}>{stallText}</span>}
                        {lastError !== null && (
                          <span className={css.taskError} title={lastErrorTooltip(lastError, t)}
                            data-last-error-code={lastError.code}>
                            <span className={css.taskErrorDot} aria-hidden="true" />
                            <span className={css.taskErrorText}>{lastErrorText(lastError, t)}</span>
                          </span>
                        )}
                      </span>
                      <span role="cell">{position === assigneeName ? assigneeName : t('ledger.assigneeCell', { name: assigneeName, position })}</span>
                      <span role="cell"><Pill>{statusLabel(row.status, t)}</Pill></span>
                      <span role="cell" className={overdue ? css.dueOverdue : undefined}>
                        {overdue && <span className={css.overdueLabel}>{t('ledger.overdue')}</span>}
                        {dueText(row.dueAt)}
                      </span>
                      <span role="cell">{deliverablesText(row, t)}</span>
                      <span role="cell">{acceptanceText(row, t)}</span>
                      <span className={css.chevron} aria-hidden="true">{open ? '⌄' : '›'}</span>
                    </button>
                    {open && <Timeline row={row} t={t} />}
                  </div>
                )
              })}
            </div>
          </div>
        )}
        {visible.length > 0 && (
          <nav className={css.pager} data-ledger-pager aria-label={t('ledger.pager.aria')}>
            <span className={css.pageSummary}>
              {t('ledger.page.summary', { total: visible.length, page: currentPage, pages: totalPages })}
            </span>
            <div className={css.pageNumbers}>
              {ledgerPageWindow(currentPage, totalPages).map((slot, index) => slot === 'ellipsis'
                ? <span key={`ellipsis:${index}`} className={css.pageEllipsis} aria-hidden="true">…</span>
                : (
                  <Button
                    key={slot}
                    variant={slot === currentPage ? 'primary' : 'ghost'}
                    size="sm"
                    aria-label={t('ledger.page.goto', { page: slot })}
                    aria-current={slot === currentPage ? 'page' : undefined}
                    onClick={() => { setPage(slot) }}
                  >
                    {String(slot)}
                  </Button>
                ))}
            </div>
            <div className={css.pageNav}>
              <Button variant="outline" size="sm" disabled={currentPage <= 1}
                onClick={() => { setPage(currentPage - 1) }}>
                {t('ledger.page.prev')}
              </Button>
              <Button variant="outline" size="sm" disabled={currentPage >= totalPages}
                onClick={() => { setPage(currentPage + 1) }}>
                {t('ledger.page.next')}
              </Button>
            </div>
          </nav>
        )}
      </div>
    </Modal>
  )
}

function Timeline({ row, t }: { readonly row: LedgerRow; readonly t: PropsLocale<'sidebar'>['t'] }) {
  const events = row.events ?? []
  return (
    <div className={css.timeline} role="region" aria-label={t('ledger.timelineAria')}>
      <div className={css.timelineHead}>
        <Tag tone="neutral">{t('ledger.timeline')}</Tag>
        <span className={css.hint}>{t('ledger.timelineHint')}</span>
      </div>
      {events.length === 0
        ? <p className={css.hint}>{t('ledger.timelineEmpty')}</p>
        : (
          <ol className={css.eventList}>
            {events.map((event, index) => (
              <li key={`${event.at}:${String(index)}`} className={css.event}>
                <span className={css.eventTime}>{timeText(event.at)}</span>
                <span className={css.eventText}>
                  {event.fromStatus === null ? t('ledger.created') : statusLabel(event.fromStatus, t)}
                  {' → '}
                  {statusLabel(event.toStatus, t)}
                  {event.actorName === undefined ? '' : ` · ${event.actorName}`}
                  {event.reason === undefined ? '' : ` · ${event.reason}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      {row.latestReport !== undefined && (
        <div className={css.reportBox}>
          <div className={css.timelineHead}>
            <Tag tone="neutral">{t('ledger.latestReport')}</Tag>
            <span className={css.hint}>{row.latestReport.reporterName} · {timeText(row.latestReport.receivedAt)}</span>
          </div>
          <p className={css.reportText}>{row.latestReport.summary.trim() === '' ? t('ledger.reportEmptyBody') : row.latestReport.summary}</p>
          <div className={css.deliverables}>
            <span className={css.hint}>{t('ledger.col.deliverables')}</span>
            {row.latestReport.deliverables.length === 0
              ? <span className={css.hint}>{t('ledger.reportNone')}</span>
              : row.latestReport.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
          </div>
        </div>
      )}
    </div>
  )
}

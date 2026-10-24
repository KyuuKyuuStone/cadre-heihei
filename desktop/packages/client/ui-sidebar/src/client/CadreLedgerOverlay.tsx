/**
 * Read-only project ledger overlay (one project, one book).
 *
 * Opened from the project row's 台账 button and rendered over the current
 * conversation so closing it returns to the same Session. Six columns plus a
 * per-row event timeline; no dispatch, transition, or message actions.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CadreLedgerOverlay.module.css'


/** One overlay request raised by a project row. */
export interface CadreLedgerRequest {
  readonly projectId: string
  readonly label: string
  readonly cwd?: string
  readonly token: number
}

export interface CadreLedgerInjected {
  hooks: { request: HostObservable<CadreLedgerRequest | null> }
  closeLedger: () => void
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

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'pending', label: '待验收' },
  { id: 'done', label: '已完成' },
]

const STATUS_LABELS: Readonly<Record<string, string>> = {
  dispatched: '进行中',
  accepted: '进行中',
  in_progress: '进行中',
  delivered: '待验收',
  review: '待验收',
  verified: '已完成',
  rework: '返工中',
  failed: '失败',
  cancelled: '已取消',
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
function acceptanceText(row: LedgerRow): string {
  switch (row.status) {
    case 'delivered': return '员工已交付 · 待主管审'
    case 'review': return '主管已审 · 待确认'
    case 'verified': return '已确认收货'
    case 'rework': return '主管打回'
    case 'failed': return '已标记失败'
    case 'cancelled': return '已取消'
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

function positionText(row: LedgerRow): string {
  const title = row.assigneeTitle?.trim()
  if (title !== undefined && title !== '') return title
  return row.assigneeRole === 'supervisor' ? '主管' : '员工'
}

function deliverablesText(row: LedgerRow): string {
  const items = row.latestReport?.deliverables ?? []
  if (items.length === 0) return '—'
  if (items.length === 1) return items[0]!
  return `${items.length} 个文件`
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
export function CadreLedgerOverlay({ useRequest, closeLedger }: PropsRuntime<'shell.overlay'> & InjectFace<CadreLedgerInjected>) {
  const request = useRequest(value => value)
  if (request === null) return null
  return <LedgerBody key={`${request.projectId}:${String(request.token)}`} request={request} closeLedger={closeLedger} />
}

function LedgerBody({ request, closeLedger }: { readonly request: CadreLedgerRequest; readonly closeLedger: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' })
    const bridge = (window as unknown as { cadre?: LedgerBridge }).cadre
    if (bridge?.listTasks === undefined) {
      setLoad({ kind: 'error', reason: '台账通道未接入：window.cadre.listTasks 未注册' })
      return
    }
    void bridge.listTasks({ projectId: request.projectId }).then((result) => {
      if (result === undefined || !Array.isArray(result.rows)) {
        setLoad({ kind: 'error', reason: '响应缺少 rows' })
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
  }, [request.projectId])

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
  const summary = load.kind === 'ready'
    ? `${String(counts.all)} 条：进行中 ${String(counts.active)} · 待验收 ${String(counts.pending)} · 已完成 ${String(counts.done)}`
    : load.kind === 'loading' ? '读取台账…' : load.reason

  return (
    <Modal
      open
      onClose={closeLedger}
      title={`项目部「${request.label}」· 台账`}
      description={request.cwd === undefined ? summary : `${request.cwd} · ${summary}`}
      closeLabel="关闭"
      className={css.dialog ?? ''}
      contentClassName={css.content ?? ''}
      footer={<Button variant="outline" onClick={closeLedger}>关闭</Button>}
    >
      <div className={css.toolbar}>
        <Input
          value={query}
          placeholder="搜索任务 / 员工 / 交付物…"
          aria-label="搜索台账"
          onChange={event => { setQuery(event.target.value) }}
        />
        <Button variant="outline" size="sm" onClick={reload}>刷新</Button>
      </div>

      <div className={css.filters} role="radiogroup" aria-label="台账筛选">
        {FILTERS.map(item => (
          <Button
            key={item.id}
            variant={filter === item.id ? 'primary' : 'outline'}
            size="sm"
            onClick={() => { setFilter(item.id) }}
          >
            {item.label} {counts[item.id]}
          </Button>
        ))}
      </div>

      {load.kind === 'loading' && <p role="status" className={css.hint}>读取台账…</p>}
      {load.kind === 'error' && (
        <div className={css.errorBox} role="alert">
          <span>{load.reason}</span>
          <span className={css.hint}>台账不可用时不展示示例数据；请检查主进程台账路径或稍后重试。</span>
        </div>
      )}
      {load.kind === 'ready' && rows.length === 0 && (
        <p role="status" className={css.hint}>这个项目部还没有台账记录。</p>
      )}
      {load.kind === 'ready' && rows.length > 0 && visible.length === 0 && (
        <p role="status" className={css.hint}>没有匹配的任务；换一个筛选或关键词。</p>
      )}
      {visible.length > 0 && (
        <div className={css.table} role="table" aria-label="项目台账">
          <div className={css.headerRow} role="row">
            <span role="columnheader">任务</span>
            <span role="columnheader">归属</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">截止</span>
            <span role="columnheader">交付物</span>
            <span role="columnheader">验收结果</span>
          </div>
          {visible.map(row => {
            const open = expanded === row.taskId
            return (
              <div key={row.taskId} className={css.rowGroup} role="rowgroup">
                <button
                  type="button"
                  role="row"
                  className={css.row}
                  aria-expanded={open}
                  onClick={() => { setExpanded(open ? null : row.taskId) }}
                >
                  <span role="cell" className={css.taskCell}>
                    <span className={css.taskTitle}>{row.title}</span>
                    <span className={css.taskMeta}>派发 {timeText(row.updatedAt)} · {row.taskId}</span>
                  </span>
                  <span role="cell">{row.assigneeName ?? row.assigneeSessionId}（{positionText(row)}）</span>
                  <span role="cell"><Pill>{STATUS_LABELS[row.status] ?? row.status}</Pill></span>
                  <span role="cell">{dueText(row.dueAt)}</span>
                  <span role="cell">{deliverablesText(row)}</span>
                  <span role="cell">{acceptanceText(row)}</span>
                  <span className={css.chevron} aria-hidden="true">{open ? '⌄' : '›'}</span>
                </button>
                {open && <Timeline row={row} />}
              </div>
            )
          })}
        </div>
      )}
      {load.kind === 'ready' && load.elapsedMs !== undefined && (
        <span className={css.hint}>只读查询 {String(load.elapsedMs)} ms</span>
      )}
    </Modal>
  )
}

function Timeline({ row }: { readonly row: LedgerRow }) {
  const events = row.events ?? []
  return (
    <div className={css.timeline} role="region" aria-label="任务时间线">
      <div className={css.timelineHead}>
        <Tag tone="neutral">时间线</Tag>
        <span className={css.hint}>只读；状态变化与汇报都来自台账。</span>
      </div>
      {events.length === 0
        ? <p className={css.hint}>这条任务还没有状态事件记录（旧账本）。</p>
        : (
          <ol className={css.eventList}>
            {events.map((event, index) => (
              <li key={`${event.at}:${String(index)}`} className={css.event}>
                <span className={css.eventTime}>{timeText(event.at)}</span>
                <span className={css.eventText}>
                  {event.fromStatus === null ? '创建' : STATUS_LABELS[event.fromStatus] ?? event.fromStatus}
                  {' → '}
                  {STATUS_LABELS[event.toStatus] ?? event.toStatus}
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
            <Tag tone="neutral">最新汇报</Tag>
            <span className={css.hint}>{row.latestReport.reporterName} · {timeText(row.latestReport.receivedAt)}</span>
          </div>
          <p className={css.reportText}>{row.latestReport.summary.trim() === '' ? '（汇报没有正文）' : row.latestReport.summary}</p>
          <div className={css.deliverables}>
            <span className={css.hint}>交付物</span>
            {row.latestReport.deliverables.length === 0
              ? <span className={css.hint}>（未提供）</span>
              : row.latestReport.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { TaskId } from '../../../collab/protocol/ids.ts'
import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useCadreApi } from '../../data/CadreApiProvider.tsx'
import { useIdentity, type Identity } from '../../data/IdentityProvider.tsx'
import {
  emptyListToViewState,
  failureToViewState,
  isValidationError,
} from '../../data/failureMapping.ts'
import { TASK_FILTERS, TASK_STATUS_LABEL_KEYS } from '../../data/labels.ts'
import type { TaskDetail, TaskSummary } from '../../data/ipcContract.ts'
import { useLocale } from '../../i18n/LocaleProvider.tsx'
import { formatMessageTimestamp } from '../../lib/formatMessageTimestamp.ts'
import { DispatchPanel } from './DispatchPanel.tsx'
import { TaskActions } from './TaskActions.tsx'

type Filter = (typeof TASK_FILTERS)[number]

export function LedgerScreen() {
  const api = useCadreApi()
  const { t, locale } = useLocale()
  const { identity } = useIdentity()
  const [filter, setFilter] = useState<Filter>('all')
  const [listState, setListState] = useState<ViewState<readonly TaskSummary[]>>({ status: 'loading' })
  const [filterError, setFilterError] = useState<string | null>(null)
  const [detail, setDetail] = useState<ViewState<TaskDetail> | null>(null)
  const [since, setSince] = useState<TaskSummary['updatedAt'] | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchSupersedes, setDispatchSupersedes] = useState<TaskId | undefined>(undefined)

  const load = useCallback(async (options: { since?: TaskSummary['updatedAt']; merge?: boolean } = {}) => {
    const res = await api.listTasks({
      ...(filter === 'all' ? {} : { status: filter }),
      ...(options.since ? { since: options.since } : {}),
    })

    if (!res.ok) {
      const mapped = failureToViewState<readonly TaskSummary[]>(res, {
        emptyHint: t('ledger.empty.hint'),
      })
      if (isValidationError(mapped)) {
        // 参数错误就地提示，不清空已有列表。
        setFilterError(mapped.message)
        return
      }
      setFilterError(null)
      if (mapped.status === 'denied') setDetail(null)
      setListState(mapped)
      return
    }

    setFilterError(null)

    if ('empty' in res && res.empty) {
      setListState(emptyListToViewState<readonly TaskSummary[]>(res, t))
      return
    }

    const items = res.items
    if (items.length === 0) {
      setListState({
        status: 'empty',
        reason: t('empty.reason.no_tasks_for_filter'),
        hint: t('ledger.empty.hint'),
      })
      return
    }

    setListState((prev) => {
      if (options.merge && prev.status === 'ready') {
        const merged = new Map(prev.data.map((item) => [item.taskId, item]))
        for (const item of items) merged.set(item.taskId, item)
        return { status: 'ready', data: [...merged.values()] }
      }
      return { status: 'ready', data: items }
    })

    const newest = items.reduce(
      (max, item) => (item.updatedAt > max ? item.updatedAt : max),
      items[0]!.updatedAt,
    )
    setSince(newest)
  }, [api, filter, t])

  useEffect(() => {
    setListState({ status: 'loading' })
    void load()
  }, [load])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void load({ since, merge: true }).finally(() => setRefreshing(false))
  }, [load, since])

  const openDetail = useCallback(async (taskId: TaskSummary['taskId']) => {
    setDetail({ status: 'loading' })
    const res = await api.getTask({ taskId })
    if (!res.ok) {
      const mapped = failureToViewState<TaskDetail>(res, { emptyHint: t('ledger.detail.missing') })
      if (mapped.status === 'denied') {
        setDetail(null)
        setListState({ status: 'denied', code: mapped.code, message: mapped.message })
        return
      }
      setDetail(mapped)
      return
    }
    setDetail({ status: 'ready', data: res })
  }, [api, t])

  /** 静默刷新详情：不切 loading，避免写操作后的回执面板被卸载。 */
  const refreshDetail = useCallback(async (taskId: TaskId) => {
    const res = await api.getTask({ taskId })
    if (res.ok) setDetail({ status: 'ready', data: res })
  }, [api])

  const afterMutation = useCallback((taskId: TaskId) => {
    void load()
    void refreshDetail(taskId)
  }, [load, refreshDetail])

  return (
    <section className="screen" data-screen="ledger" aria-label={t('nav.ledger')}>
      <h1 className="screen__title">{t('nav.ledger')}</h1>

      <div className="toolbar">
        <label className="toolbar__field">
          <span>{t('ledger.filter.label')}</span>
          <select
            data-testid="ledger-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            {TASK_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === 'all' ? t('ledger.filter.all') : t(TASK_STATUS_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button" onClick={refresh} disabled={refreshing}>
          {t('ledger.refresh')}
        </button>
        {identity?.role === 'supervisor' ? (
          <button
            type="button"
            className="button"
            data-testid="dispatch-open"
            onClick={() => {
              setDispatchSupersedes(detail?.status === 'ready' ? detail.data.taskId : undefined)
              setDispatchOpen(true)
            }}
          >
            {t('dispatch.open')}
          </button>
        ) : null}
      </div>

      {dispatchOpen ? (
        <DispatchPanel
          supersedesTaskId={dispatchSupersedes}
          onClose={() => setDispatchOpen(false)}
          onDispatched={() => { void load() }}
        />
      ) : null}

      {filterError ? (
        <p className="form-error" role="alert" data-testid="ledger-filter-error">{filterError}</p>
      ) : null}

      <StateBoundary
        state={listState}
        emptyTitle={t('ledger.empty.title')}
        renderReady={(items) => (
          <ul className="task-list" aria-label={t('nav.ledger')}>
            {items.map((item) => (
              <li key={item.taskId}>
                <button
                  type="button"
                  className="task-row"
                  data-testid={`task-row-${item.taskId}`}
                  onClick={() => void openDetail(item.taskId)}
                >
                  <span className="task-row__title">{item.title}</span>
                  <span className="status-badge" data-status={item.status}>
                    {t(TASK_STATUS_LABEL_KEYS[item.status])}
                  </span>
                  <span className="task-row__meta">{item.assigneeName ?? item.assigneeSessionId}</span>
                  <time className="task-row__time">
                    {formatMessageTimestamp(item.updatedAt, t, locale)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      />

      {detail ? (
        <aside className="task-detail" aria-label={t('ledger.detail.body')} data-testid="task-detail">
          <StateBoundary
            state={detail}
            emptyTitle={t('ledger.empty.title')}
            renderReady={(task) => (
              <TaskDetailPanel detail={task} identity={identity} onChanged={afterMutation} />
            )}
          />
        </aside>
      ) : null}
    </section>
  )
}

function TaskDetailPanel({
  detail,
  identity,
  onChanged,
}: {
  detail: TaskDetail
  identity: Identity | null
  onChanged: (taskId: TaskId) => void
}) {
  const { t, locale } = useLocale()

  return (
    <div className="task-detail__body">
      <h2 className="task-detail__title">{detail.title}</h2>
      <p className="task-detail__meta">
        <span className="status-badge" data-status={detail.status}>
          {t(TASK_STATUS_LABEL_KEYS[detail.status])}
        </span>
        <span>{detail.assigneeName ?? detail.assigneeSessionId}</span>
        <span>{formatMessageTimestamp(detail.updatedAt, t, locale)}</span>
      </p>

      <h3 className="task-detail__section">{t('ledger.detail.body')}</h3>
      <pre className="task-detail__pre">{detail.body}</pre>

      <h3 className="task-detail__section">{t('ledger.detail.transitions')}</h3>
      <ol className="transition-list">
        {detail.transitions.map((transition, index) => (
          <li key={`${transition.at}-${index}`} data-testid="transition-row">
            <span>
              {transition.from ?? '∅'} → {transition.to}
            </span>
            <span className="task-row__meta">
              {transition.actorSessionId} · {formatMessageTimestamp(transition.at, t, locale)}
            </span>
            {transition.reason ? <span className="task-row__meta">{transition.reason}</span> : null}
          </li>
        ))}
      </ol>

      {detail.report ? (
        <>
          <h3 className="task-detail__section">{t('ledger.detail.report')}</h3>
          <p>{detail.report.summary}</p>
          {detail.report.deliverables.length > 0 ? (
            <>
              <h4 className="task-detail__section">{t('ledger.detail.deliverables')}</h4>
              <ul className="deliverable-list">
                {detail.report.deliverables.map((path) => <li key={path}><code>{path}</code></li>)}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      <p className="task-detail__meta">
        <span>{t('ledger.detail.source')}: {detail.sourceSessionId}</span>
      </p>

      <TaskActions
        task={detail}
        identity={identity}
        onChanged={() => onChanged(detail.taskId)}
      />
    </div>
  )
}

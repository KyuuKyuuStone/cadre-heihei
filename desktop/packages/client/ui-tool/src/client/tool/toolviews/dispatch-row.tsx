/**
 * W2 dispatch status row.
 *
 * Replaces the generic Tool row for `dispatch_task` / `retry_dispatch` in the
 * supervisor conversation. The row reads the persisted `presentationMeta`
 * (`dispatched` / `failed`) — never the rendered text — so wording changes do
 * not affect the card. Running → 拆解中; settled → per-item dispatch / failure
 * rows; then it joins the ledger so the same bar can show the flow back
 * (已交付，主管正在审).
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  Button,
  IconBranchOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'

const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
const TEXT_ERROR = 'var(--dsw-alias-state-error-primary)'

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

type DispatchRowProps = ToolCallViewProps & InjectFace<DispatchRowInjected>

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
function dueText(iso: string): string {
  if (iso === '') return '未注明'
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
      <span style={{ flex: 1, minWidth: 0, color: TEXT_PRIMARY, fontWeight: 500 }}>{title}</span>
      {tag === undefined ? null : <Tag tone={tagTone}>{tag}</Tag>}
    </div>
  )
}

function RunningBar() {
  return (
    <BarShell tone="neutral">
      <Headline
        icon={<StateDot state="ongoing" />}
        title="拆解中…"
        tag="进行中"
        tagTone="info"
      />
      <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
        主管正在读你的话，判断要拆成几件事、派给谁
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
      setSyncError('状态未同步：台账通道未接入')
      return
    }
    let cancelled = false
    const tick = async () => {
      const projectId = props.resolveProjectId?.()
      if (projectId === undefined) {
        setSyncError('状态未同步：当前会话不属于任何项目部')
        return
      }
      try {
        const response = await list({ projectId })
        if (cancelled) return
        if (response === undefined || !Array.isArray(response.rows)) {
          setSyncError('状态未同步：台账响应缺少 rows')
          return
        }
        setSyncError(null)
        const rows = response.rows as readonly LedgerRow[]
        setLedger(new Map(rows.map(row => [row.taskId, row])))
      } catch (error) {
        if (cancelled) return
        // Keep the last snapshot, but make the failed join visible instead of
        // letting the card imply that the ledger still agrees with it.
        setSyncError(`状态未同步：${error instanceof Error ? error.message : String(error)}`)
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
  }, [taskKey])

  if (props.phase !== 'result') return <RunningBar />

  const block = props.block
  if (block.isError) {
    const reason = block.error?.reason ?? (textOf(block.content).trim() || '主管没能完成拆解')
    return (
      <BarShell tone="danger">
        <Headline title="拆解失败" tag="未派活" tagTone="danger" />
        <span style={{ color: TEXT_PRIMARY, fontSize: 13 }}>{reason}</span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>没有产生任何任务 · 请重新说一次</span>
      </BarShell>
    )
  }

  // Results recorded before the structured meta landed keep their recorded
  // text visible, but are never reinterpreted as fresh dispatch data.
  if (meta === null) {
    const raw = textOf(block.content).trim()
    return (
      <BarShell tone="neutral">
        <Headline title="派活结果" tag="旧格式" />
        <span style={{ color: TEXT_PRIMARY, fontSize: 12 }}>{raw || '这条记录没有结构化数据'}</span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>该结果早于结构化回传，仅作原文展示；重新派活后按新格式显示</span>
      </BarShell>
    )
  }

  const groups = new Map<string, number>()
  for (const item of dispatched) groups.set(item.assigneeName, (groups.get(item.assigneeName) ?? 0) + 1)
  const groupText = [...groups].map(([name, count]) => `${name}（${count} 条）`).join(' · ')
  const partial = dispatched.length > 0 && failed.length > 0
  const allFailed = dispatched.length === 0
  if (allFailed && failed.length === 0) {
    return (
      <BarShell tone="neutral">
        <Headline title="派活结果" tag="空" />
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>后端返回了空的 dispatched / failed</span>
      </BarShell>
    )
  }
  const dueValues = [...new Set(dispatched.map(item => item.dueAt).filter(value => value !== ''))]
  const dueSummary = dueValues.length === 0
    ? ''
    : dueValues.length === 1
      ? `截止 ${dueText(dueValues[0] ?? '')}`
      : `最早截止 ${dueText(dueValues[0] ?? '')}`
  const headline = allFailed
    ? `派活未成功 · ${failed.length} 条待处理`
    : partial
      ? `部分成功 · 成功 ${dispatched.length} 条 · 失败 ${failed.length} 条`
      : `已派给 ${groupText}`
  const tone: 'neutral' | 'danger' | 'warning' = allFailed
    ? 'danger'
    : failed.length > 0
      ? 'warning'
      : 'neutral'

  const statusLines = dispatched.flatMap((item) => {
    const row = ledger.get(item.taskId)
    if (row === undefined) return []
    const title = row.title === '' ? item.taskId : row.title
    if (row.status === 'delivered') return [`${item.assigneeName} · ${title} — 已交付，主管正在审`]
    if (row.status === 'review') return [`${item.assigneeName} · ${title} — 待你确认`]
    if (row.status === 'verified') return [`${item.assigneeName} · ${title} — 已完成`]
    if (row.status === 'rework') return [`${item.assigneeName} · ${title} — 被退回重做`]
    if (row.status === 'failed') return [`${item.assigneeName} · ${title} — 失败`]
    if (row.status === 'in_progress') return [`${item.assigneeName} · ${title} — 正在执行`]
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
        setNotice(pendingId, { tone: 'neutral', text: landed.length > 0 ? '重试成功，已派出' : '重试成功' })
        return
      }
      const replacement = outcome.failed?.[0]
      if (replacement !== undefined) setResolved(previous => new Map(previous).set(pendingId, replacement))
      setNotice(pendingId, { tone: 'danger', text: outcome.message ?? replacement?.reason ?? '重试失败' })
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
        tag={allFailed ? '失败' : partial ? '部分成功' : '已派出'}
        tagTone={allFailed ? 'danger' : partial ? 'warning' : 'success'}
      />
      {dispatched.length > 0 && (
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
          {`共 ${dispatched.length} 条任务`}
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
            <span key={line} style={{ color: TEXT_PRIMARY, fontSize: 12 }}>{line}</span>
          ))}
        </div>
      )}

      {syncError !== null && (
        <span role="status" style={{ color: TEXT_ERROR, fontSize: 12 }}>{syncError}</span>
      )}

      {failed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {failed.map(item => {
            const pending = isPendingHandoff(item.reason)
            const canRetry = item.retryable && item.pendingId !== undefined
            const notice = item.pendingId === undefined ? undefined : retryNotices.get(item.pendingId)
            return (
              <div key={`${item.pendingId ?? ''}:${item.target}:${item.reason}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag tone={pending ? 'warning' : 'danger'}>{pending ? '待派' : '失败'}</Tag>
                <span style={{ flex: 1, minWidth: 0, color: TEXT_PRIMARY, fontSize: 12 }}>
                  {`${item.target} · ${item.reason}`}
                </span>
                {pending && canRetry && (
                  <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>补人后可重试</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRetry || retrying !== null}
                  title={canRetry ? undefined : '该失败不可重试，请重新派活'}
                  onClick={() => { void onRetry(item) }}
                >
                  {retrying === item.pendingId ? '重试中…' : '重试'}
                </Button>
                {notice !== undefined && (
                  <span
                    role={notice.tone === 'danger' ? 'alert' : 'status'}
                    style={{ color: notice.tone === 'danger' ? TEXT_ERROR : TEXT_SECONDARY, fontSize: 12 }}
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
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>没有产生任何任务 · 可重试的条目不依赖重新派活</span>
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
  inject: ['slots', 'workspaces'],
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
                message: payload?.message ?? `重试请求失败（HTTP ${response.status}）`,
              }
            }
            return payload ?? { ok: false, message: '重试通道未返回结果' }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) }
          }
        },
      })
      const register = (key: string) => ctx.slots.register({
        name: 'tool.call.toolview',
        key,
        inject: (sessionId: string) => render(sessionId),
      }, DispatchStatusRow)
      yield register('dispatch_task')
      yield register('retry_dispatch')
    })
  },
}

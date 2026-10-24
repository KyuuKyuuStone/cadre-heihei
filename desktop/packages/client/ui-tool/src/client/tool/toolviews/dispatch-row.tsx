/**
 * W2 dispatch status row.
 *
 * Replaces the generic Tool row for `dispatch_task` in the supervisor
 * conversation. The row reads the recorded call/result (never invents data):
 * running → 拆解中; settled → the per-item `dispatched` / `failed` lines the
 * Host render produced; then it joins the ledger so the same bar can show what
 * came back (已交付，主管正在审).
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

/** One `已派发` line the Host render emitted. */
interface DispatchedItem {
  readonly taskId: string
  readonly assigneeName: string
  readonly role: string
  readonly dueAt: string
}

/** One `未派出「target」：reason` line. */
interface FailedItem {
  readonly target: string
  readonly reason: string
}

interface DispatchResult {
  readonly dispatched: readonly DispatchedItem[]
  readonly failed: readonly FailedItem[]
  readonly raw: string
}

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

/** Retry seam: ask the supervisor to re-dispatch one failed target. */
export interface DispatchRowInjected {
  retry(target: string, reason: string): Promise<{ ok: boolean; message?: string }>
}

type DispatchRowProps = ToolCallViewProps & InjectFace<DispatchRowInjected>

const DISPATCHED_LINE = /^已派发 (\S+) → (.+?)（(.+?)），截止 (.+)$/
const FAILED_LINE = /^未派出「(.*)」：(.*)$/

/** Concatenate the recorded text blocks; other block kinds are not presented. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** Parse the Host's `dispatched` / `failed` render; unknown lines stay in `raw`. */
function parseResult(text: string): DispatchResult {
  const dispatched: DispatchedItem[] = []
  const failed: FailedItem[] = []
  for (const line of text.split('\n')) {
    const ok = DISPATCHED_LINE.exec(line.trim())
    if (ok !== null) {
      dispatched.push({
        taskId: ok[1] ?? '',
        assigneeName: ok[2] ?? '',
        role: ok[3] ?? '',
        dueAt: ok[4] ?? '',
      })
      continue
    }
    const bad = FAILED_LINE.exec(line.trim())
    if (bad !== null) failed.push({ target: bad[1] ?? '', reason: bad[2] ?? '' })
  }
  return { dispatched, failed, raw: text.trim() }
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
  const [retrying, setRetrying] = useState<string | null>(null)
  const [retryNotice, setRetryNotice] = useState<{ target: string; tone: 'neutral' | 'danger'; text: string } | null>(null)

  const result: DispatchResult | null = props.phase === 'result'
    ? parseResult(textOf(props.block.content))
    : null
  const dispatched = result?.dispatched ?? []
  const failed = result?.failed ?? []
  const taskKey = dispatched.map(item => item.taskId).join(',')

  // Join the ledger for the returned tasks so the same bar can show the flow
  // back (delivered → review). Poll for two minutes, then leave the last view.
  useEffect(() => {
    if (taskKey === '') return
    const list = typeof window === 'undefined'
      ? undefined
      : (window as unknown as { cadre?: LedgerBridge }).cadre?.listTasks
    if (list === undefined) return
    let cancelled = false
    const tick = async () => {
      try {
        const response = await list()
        if (cancelled) return
        setLedger(new Map((response?.rows ?? []).map(row => [row.taskId, row])))
      } catch {
        // Keep the last snapshot; a ledger read failure never blanks the bar.
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

  if (dispatched.length === 0 && failed.length === 0) {
    const reason = result?.raw === '' ? '主管没有返回可识别的派活结果' : result?.raw ?? ''
    return (
      <BarShell tone="danger">
        <Headline title="拆解失败" tag="未派活" tagTone="danger" />
        <span style={{ color: TEXT_PRIMARY, fontSize: 13 }}>{reason}</span>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>没有产生任何任务 · 请重新说一次</span>
      </BarShell>
    )
  }

  const groups = new Map<string, number>()
  for (const item of dispatched) groups.set(item.assigneeName, (groups.get(item.assigneeName) ?? 0) + 1)
  const groupText = [...groups].map(([name, count]) => `${name}（${count} 条）`).join(' · ')
  const partial = dispatched.length > 0 && failed.length > 0
  const allFailed = dispatched.length === 0
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

  const onRetry = async (item: FailedItem) => {
    setRetrying(item.target)
    setRetryNotice(null)
    try {
      const outcome = await props.retry(item.target, item.reason)
      setRetryNotice(outcome.ok
        ? { target: item.target, tone: 'neutral', text: '已请主管重试' }
        : { target: item.target, tone: 'danger', text: outcome.message ?? '重试请求失败' })
    } catch (error) {
      setRetryNotice({
        target: item.target,
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

      {failed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {failed.map(item => {
            const pending = isPendingHandoff(item.reason)
            const notice = retryNotice?.target === item.target ? retryNotice : undefined
            return (
              <div key={`${item.target}:${item.reason}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag tone={pending ? 'warning' : 'danger'}>{pending ? '待派' : '失败'}</Tag>
                <span style={{ flex: 1, minWidth: 0, color: TEXT_PRIMARY, fontSize: 12 }}>
                  {`${item.target} · ${item.reason}`}
                </span>
                {pending
                  ? <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>请换人</span>
                  : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retrying !== null}
                      onClick={() => { void onRetry(item) }}
                    >
                      {retrying === item.target ? '重试中…' : '重试'}
                    </Button>
                  )}
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
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>没有产生任何任务 · 请换人或重新说一次</span>
      )}
    </BarShell>
  )
}

/** Registers the dispatch status row; retry asks the same Session to re-dispatch. */
export const dispatchToolview = {
  name: 'dispatch-toolview',
  inject: ['slots', 'sessions'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'dispatch_task',
      inject: (sessionId): DispatchRowInjected => ({
        retry: async (target, reason) => {
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === undefined) return { ok: false, message: '会话不可用，无法重试' }
          const result = await session.prompt(
            [{ type: 'text', text: `请重试未派出的任务：${target}（原因：${reason}）` }],
            'queue',
          )
          return result.ok ? { ok: true } : { ok: false, message: result.error.message }
        },
      }),
    }, DispatchStatusRow))
  },
}

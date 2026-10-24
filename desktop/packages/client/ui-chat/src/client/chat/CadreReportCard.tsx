/**
 * Cadre employee report card, rendered in the supervisor conversation.
 *
 * The Host delivers a report to the supervisor as a plain user message with
 * a fixed header (`【员工汇报】`). The card turns that message into a compact
 * summary with deliverables and the two acceptance actions. Acceptance stays
 * in the conversation: no panel hop, no manual task id typing. Rejecting
 * requires a reason because the ledger's transition rule requires one.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { Button, Modal, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

const TEXT_PRIMARY = 'var(--dsw-alias-label-primary)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary)'
const TEXT_ERROR = 'var(--dsw-alias-state-error-primary)'
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: TEXT_PRIMARY,
  minWidth: 0,
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  delivered: '待主管审',
  review: '待你确认',
  verified: '已完成',
  rework: '返工中',
  failed: '失败',
  cancelled: '已取消',
}

interface TaskRow {
  readonly taskId: string
  readonly title?: string
  readonly status: string
}

interface TransitionResult {
  readonly ok?: boolean
  readonly ledgerUpdated?: boolean
  readonly tasks?: readonly TaskRow[]
  readonly code?: string
  readonly message?: string
}

interface CadreChatBridge {
  listTasks?(query: { projectId: string }): Promise<{ rows?: readonly TaskRow[] } | undefined>
  transitionTask?(query: {
    projectId: string
    /** Calling Session; the host rejects a write without it. */
    sessionId: string
    taskId: string
    status: string
    reason?: string
  }): Promise<TransitionResult | undefined>
}

interface ParsedReport {
  readonly taskId: string
  readonly title: string
  readonly reporter: string
  readonly summary: string
  readonly deliverables: readonly string[]
}

function bridge(): CadreChatBridge | undefined {
  return (window as unknown as { cadre?: CadreChatBridge }).cadre
}

/**
 * Parse the Host's report prompt. Anything that does not carry the exact
 * header shape stays an ordinary user message.
 * @param content - one user message's plain text.
 * @returns the report fields, or undefined when this is not a report.
 */
export function parseCadreReport(content: string): ParsedReport | undefined {
  if (!content.startsWith('【员工汇报】')) return undefined
  const taskId = /^任务号：(.+)$/m.exec(content)?.[1]?.trim()
  const title = /^标题：(.+)$/m.exec(content)?.[1]?.trim()
  const reporter = /^回报人：(.+)$/m.exec(content)?.[1]?.trim()
  if (taskId === undefined || taskId === '' || reporter === undefined || reporter === '') return undefined
  const summaryStart = content.indexOf('\n\n')
  const deliverablesStart = content.indexOf('\n交付物：', summaryStart === -1 ? 0 : summaryStart)
  if (summaryStart === -1 || deliverablesStart === -1) return undefined
  const summary = content.slice(summaryStart + 2, deliverablesStart).trim()
  const deliverablesText = content.slice(deliverablesStart + '\n交付物：'.length).split('\n')[0]?.trim() ?? ''
  const deliverables = deliverablesText === '' || deliverablesText === '（未提供）'
    ? []
    : deliverablesText.split(',').map(item => item.trim()).filter(item => item !== '')
  return { taskId, title: title ?? taskId, reporter, summary, deliverables }
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return '（汇报没有正文）'
  const head = (trimmed.split(/[。！？!?\n]/)[0] ?? '').trim() || trimmed
  return head.length > 120 ? `${head.slice(0, 120)}…` : head
}

function failureText(result: TransitionResult | undefined): string {
  return `${result?.code ?? 'LEDGER_NOT_UPDATED'} · ${result?.message ?? '台账未确认写入'}`
}

/**
 * Report card with the two acceptance actions; every write is confirmed by
 * the ledger (`ok`/`ledgerUpdated`) before the card claims success.
 * @param props - report message text and the Workspace id of the Session
 * that owns the card (the ledger addresses projects by Workspace id).
 */
export function CadreReportNodeView({ content, projectId, sessionId }: {
  readonly content: string
  readonly projectId: string | undefined
  /** The Session showing the card; it becomes the ledger actor. */
  readonly sessionId: string | undefined
}) {
  const report = parseCadreReport(content)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (report === undefined) return
    const target = bridge()
    if (target?.listTasks === undefined) {
      setLoadError('台账通道未接入：window.cadre.listTasks 未注册')
      return
    }
    if (projectId === undefined) {
      setLoadError('当前会话不属于任何项目部，无法读取台账。')
      return
    }
    let cancelled = false
    void target.listTasks({ projectId }).then((response) => {
      if (cancelled) return
      const row = response?.rows?.find(task => task.taskId === report.taskId)
      if (row === undefined) {
        setLoadError('台账中找不到这条任务；卡片仅展示汇报原文。')
        return
      }
      setStatus(row.status)
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [content, projectId])

  if (report === undefined) return null

  const transition = async (to: string, reasonText?: string): Promise<void> => {
    const target = bridge()
    if (target?.transitionTask === undefined) {
      setNotice('写入通道未接入：window.cadre.transitionTask 未注册')
      return
    }
    if (projectId === undefined) {
      setNotice('当前会话不属于任何项目部，无法写入台账。')
      return
    }
    if (sessionId === undefined) {
      setNotice('无法确定当前会话身份，写入已拒绝。')
      return
    }
    setPending(true)
    setNotice(null)
    try {
      // The ledger requires review as a mandatory stop after delivery; a
      // user verdict records that stop first instead of bypassing it.
      if (status === 'delivered') {
        const reviewed = await target.transitionTask({
          projectId, sessionId, taskId: report.taskId, status: 'review',
        })
        if (reviewed?.ok === false) {
          setNotice(`主管审核步骤失败：${failureText(reviewed)}`)
          return
        }
      }
      const final = await target.transitionTask({
        projectId,
        sessionId,
        taskId: report.taskId,
        status: to,
        ...(reasonText === undefined ? {} : { reason: reasonText }),
      })
      if (final?.ok === false || (final?.ok !== true && final?.ledgerUpdated !== true)) {
        setNotice(`写入失败：${failureText(final)}`)
        return
      }
      setStatus(to)
      setResult(to === 'verified' ? '已确认收货，任务完成。' : '已打回，任务退回员工返工。')
      setReasonOpen(false)
      setReason('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  const final = status === 'verified' || status === 'rework' || status === 'failed' || status === 'cancelled'
  const actionable = status === 'delivered' || status === 'review'

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag tone="neutral">员工汇报</Tag>
        <span style={{ fontWeight: 600, minWidth: 0 }}>{report.title}</span>
        <span style={{ flex: 1 }} />
        {status === undefined
          ? <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>读取状态…</span>
          : <Pill>{STATUS_LABELS[status] ?? status}</Pill>}
      </div>
      <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
        {report.reporter} · 任务号 {report.taskId}
      </span>
      <p style={{ margin: 0, color: TEXT_PRIMARY, lineHeight: 1.55 }}>
        {expanded ? report.summary : firstLine(report.summary)}
      </p>
      {report.summary.trim() !== '' && (
        <div>
          <Button variant="outline" size="sm" onClick={() => { setExpanded(value => !value) }}>
            {expanded ? '收起全文' : '展开全文'}
          </Button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>交付物</span>
        {report.deliverables.length === 0
          ? <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>（未提供）</span>
          : report.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
      </div>
      {loadError !== null && (
        <p role="status" style={{ margin: 0, color: TEXT_SECONDARY, fontSize: 12 }}>{loadError}</p>
      )}
      {actionable && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => { setReasonOpen(true); setNotice(null); setReason('') }}
          >
            打回重做
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => { void transition('verified') }}
          >
            {pending ? '处理中…' : status === 'delivered' ? '主管通过并确认收货' : '确认收货'}
          </Button>
          <span style={{ color: TEXT_SECONDARY, fontSize: 11 }}>
            {status === 'delivered' ? '通过会先记录主管审核，再确认收货。' : '确认后任务进入已完成。'}
          </span>
        </div>
      )}
      {final && (
        <p role="status" style={{ margin: 0, color: TEXT_SECONDARY, fontSize: 12 }}>
          {result ?? `当前状态：${STATUS_LABELS[status!] ?? status}`}
        </p>
      )}
      {notice !== null && <p role="alert" style={{ margin: 0, color: TEXT_ERROR, fontSize: 12 }}>{notice}</p>}
      <Modal
        open={reasonOpen}
        onClose={() => { if (!pending) setReasonOpen(false) }}
        title="打回重做"
        description={`${report.title} · ${report.taskId}`}
        closeLabel="关闭"
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setReasonOpen(false) }}>取消</Button>
            <Button
              variant="primary"
              disabled={pending || reason.trim() === ''}
              onClick={() => { void transition('rework', reason.trim()) }}
            >
              {pending ? '处理中…' : '确认打回'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="cadre-report-reason" style={{ color: TEXT_PRIMARY, fontSize: 13 }}>
            打回原因（必填）
          </label>
          <textarea
            id="cadre-report-reason"
            value={reason}
            rows={4}
            disabled={pending}
            placeholder="例如：交付物不全 / 没按要求 / 结论不成立"
            onChange={event => { setReason(event.target.value) }}
            style={{
              boxSizing: 'border-box', width: '100%', resize: 'vertical', font: 'inherit',
              padding: '8px 10px', border: '0.5px solid var(--dsw-alias-border-l4)',
              borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-1)',
              color: TEXT_PRIMARY,
            }}
          />
          <span style={{ color: TEXT_SECONDARY, fontSize: 12 }}>
            打回后任务回到员工返工；原因会写入台账事件。
          </span>
        </div>
      </Modal>
    </div>
  )
}

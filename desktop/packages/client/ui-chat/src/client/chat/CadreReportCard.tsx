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
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconDeliverDocRegular,
  Modal,
  Pill,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatKey } from '../locale.ts'

const INK_PRIMARY = 'var(--dsw-alias-label-primary)'
const INK_SECONDARY = 'var(--dsw-alias-label-secondary)'
const INK_ERROR = 'var(--dsw-alias-state-error-primary)'
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: INK_PRIMARY,
  minWidth: 0,
}

/** One-line collapsed report: compact, so many reports can stack without noise. */
const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  padding: '6px 10px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: INK_PRIMARY,
}

const STATUS_KEYS: Readonly<Record<string, ChatKey>> = {
  delivered: 'report.status.delivered',
  review: 'report.status.review',
  verified: 'report.status.verified',
  rework: 'report.status.rework',
  failed: 'report.status.failed',
  cancelled: 'report.status.cancelled',
}

function statusLabel(status: string, t: PropsLocale<'chat'>['t']): string {
  const key = STATUS_KEYS[status]
  return key === undefined ? status : t(key)
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

/** Prefer a conclusion/completion sentence, then fall back to the first line. */
function firstLine(text: string, t: PropsLocale<'chat'>['t']): string {
  const trimmed = text.trim()
  if (trimmed === '') return t('report.emptyBody')
  const lines = trimmed.split('\n').map(line => line.trim()).filter(line => line !== '')
  const conclusion = lines.find(line => /^(结论|完成|已完成|结果|交付)[:：]?/.test(line)) ?? lines[0] ?? trimmed
  const sentence = (conclusion.split(/[。！？!?]/)[0] ?? '').trim() || conclusion
  return sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence
}

/**
 * Stable per-report key so a user's expanded choice survives a Session refresh.
 * The content hash distinguishes a rework report from the earlier one.
 */
function expansionKey(taskId: string, content: string): string {
  let hash = 5381
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0
  }
  return `cadre.report.expanded:${taskId}:${Math.abs(hash).toString(36)}`
}

function readExpanded(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeExpanded(key: string, value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Storage disabled: keep the in-memory state for this mount.
  }
}

function failureText(result: TransitionResult | undefined, t: PropsLocale<'chat'>['t']): string {
  return `${result?.code ?? 'LEDGER_NOT_UPDATED'} · ${result?.message ?? t('report.ledgerUnconfirmed')}`
}

/**
 * Report card with the two acceptance actions; every write is confirmed by
 * the ledger (`ok`/`ledgerUpdated`) before the card claims success.
 * @param props - report message text and the Workspace id of the Session
 * that owns the card (the ledger addresses projects by Workspace id).
 */
export function CadreReportNodeView({ content, projectId, sessionId, t }: {
  readonly content: string
  readonly projectId: string | undefined
  /** The Session showing the card; it becomes the ledger actor. */
  readonly sessionId: string | undefined
  readonly t: PropsLocale<'chat'>['t']
}) {
  const report = parseCadreReport(content)
  const expandKey = report === undefined ? '' : expansionKey(report.taskId, content)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(() => readExpanded(expandKey))
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (report === undefined) return
    const target = bridge()
    if (target?.listTasks === undefined) {
      setLoadError(t('report.channelMissing'))
      return
    }
    if (projectId === undefined) {
      setLoadError(t('report.noProjectRead'))
      return
    }
    let cancelled = false
    void target.listTasks({ projectId }).then((response) => {
      if (cancelled) return
      const row = response?.rows?.find(task => task.taskId === report.taskId)
      if (row === undefined) {
        setLoadError(t('report.taskMissing'))
        return
      }
      setStatus(row.status)
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [content, projectId, t])

  useEffect(() => {
    setExpanded(readExpanded(expandKey))
  }, [expandKey])

  if (report === undefined) return null

  const toggleExpanded = (): void => {
    setExpanded((value) => {
      const next = !value
      writeExpanded(expandKey, next)
      return next
    })
  }

  const transition = async (to: string, reasonText?: string): Promise<void> => {
    const target = bridge()
    if (target?.transitionTask === undefined) {
      setNotice(t('report.writeChannelMissing'))
      return
    }
    if (projectId === undefined) {
      setNotice(t('report.noProjectWrite'))
      return
    }
    if (sessionId === undefined) {
      setNotice(t('report.noActor'))
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
          setNotice(t('report.reviewStepFailed', { detail: failureText(reviewed, t) }))
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
        setNotice(t('report.writeFailed', { detail: failureText(final, t) }))
        return
      }
      setStatus(to)
      setResult(to === 'verified' ? t('report.verified') : t('report.reworked'))
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
  const preview = firstLine(report.summary, t)

  if (!expanded) {
    return (
      <div style={BAR} data-cadre-report-collapsed="">
        <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none', color: INK_SECONDARY }}>
          <IconDeliverDocRegular size={14} />
        </span>
        <span style={{ flex: 'none', fontWeight: 500 }}>{t('report.title')}</span>
        <span style={{ flex: 'none', color: INK_SECONDARY, fontSize: 12 }}>{report.taskId}</span>
        <span
          title={report.summary}
          style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', color: INK_PRIMARY, fontSize: 13,
          }}
        >
          {preview}
        </span>
        <Button variant="ghost" size="sm" onClick={toggleExpanded} aria-expanded={false}>
          {t('report.expand')} <IconChevronDownOutlineRegular size={12} />
        </Button>
      </div>
    )
  }

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag tone="neutral">{t('report.title')}</Tag>
        <span style={{ fontWeight: 600, minWidth: 0 }}>{report.title}</span>
        <span style={{ flex: 1 }} />
        {status === undefined
          ? <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('report.loadingStatus')}</span>
          : <Pill>{statusLabel(status, t)}</Pill>}
        <Button variant="ghost" size="sm" onClick={toggleExpanded} aria-expanded={true}>
          {t('report.collapse')} <IconChevronUpOutlineRegular size={12} />
        </Button>
      </div>
      <span style={{ color: INK_SECONDARY, fontSize: 12 }}>
        {report.reporter} · {t('report.taskId', { id: report.taskId })}
      </span>
      <p style={{ margin: 0, color: INK_PRIMARY, lineHeight: 1.55 }}>
        {report.summary}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('report.deliverables')}</span>
        {report.deliverables.length === 0
          ? <span style={{ color: INK_SECONDARY, fontSize: 12 }}>{t('report.none')}</span>
          : report.deliverables.map(item => <Tag key={item} tone="neutral">{item}</Tag>)}
      </div>
      {loadError !== null && (
        <p role="status" style={{ margin: 0, color: INK_SECONDARY, fontSize: 12 }}>{loadError}</p>
      )}
      {actionable && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => { setReasonOpen(true); setNotice(null); setReason('') }}
          >
            {t('report.reject')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => { void transition('verified') }}
          >
            {pending ? t('report.processing') : status === 'delivered' ? t('report.approveAndAccept') : t('report.accept')}
          </Button>
          <span style={{ color: INK_SECONDARY, fontSize: 11 }}>
            {status === 'delivered' ? t('report.approveHint') : t('report.acceptHint')}
          </span>
        </div>
      )}
      {final && (
        <p role="status" style={{ margin: 0, color: INK_SECONDARY, fontSize: 12 }}>
          {result ?? t('report.currentState', { status: statusLabel(status!, t) })}
        </p>
      )}
      {notice !== null && <p role="alert" style={{ margin: 0, color: INK_ERROR, fontSize: 12 }}>{notice}</p>}
      <Modal
        open={reasonOpen}
        onClose={() => { if (!pending) setReasonOpen(false) }}
        title={t('report.reject')}
        description={`${report.title} · ${report.taskId}`}
        closeLabel={t('report.close')}
        footer={(
          <>
            <Button variant="outline" disabled={pending} onClick={() => { setReasonOpen(false) }}>{t('report.cancel')}</Button>
            <Button
              variant="primary"
              disabled={pending || reason.trim() === ''}
              onClick={() => { void transition('rework', reason.trim()) }}
            >
              {pending ? t('report.processing') : t('report.confirmReject')}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="cadre-report-reason" style={{ color: INK_PRIMARY, fontSize: 13 }}>
            {t('report.reasonLabel')}
          </label>
          <textarea
            id="cadre-report-reason"
            value={reason}
            rows={4}
            disabled={pending}
            placeholder={t('report.reasonPlaceholder')}
            onChange={event => { setReason(event.target.value) }}
            style={{
              boxSizing: 'border-box', width: '100%', resize: 'vertical', font: 'inherit',
              padding: '8px 10px', border: '0.5px solid var(--dsw-alias-border-l4)',
              borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-1)',
              color: INK_PRIMARY,
            }}
          />
          <span style={{ color: INK_SECONDARY, fontSize: 12 }}>
            {t('report.rejectHint')}
          </span>
        </div>
      </Modal>
    </div>
  )
}

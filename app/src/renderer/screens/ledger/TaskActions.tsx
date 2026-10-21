import { useCallback, useRef, useState } from 'react'
import type { ReportReceipt } from '../../../collab/protocol/report.ts'
import type { TaskDetail, TransitionReceipt } from '../../../collab/protocol/tool-outputs.ts'
import type { TextKey } from '../../i18n/index.ts'
import type { ViewState } from '../../components/viewState.ts'
import { InlineFailure } from '../../components/InlineFailure.tsx'
import { useCadreApi } from '../../data/CadreApiProvider.tsx'
import type { Identity } from '../../data/IdentityProvider.tsx'
import { failureToViewState } from '../../data/failureMapping.ts'
import { newIdempotencyKey } from '../../data/idempotency.ts'
import { REVIEW_ACTIONS, type ReviewAction } from '../../data/ipcContract.ts'
import { TASK_STATUS_LABEL_KEYS } from '../../data/labels.ts'
import { useLocale } from '../../i18n/LocaleProvider.tsx'

const REVIEW_ACTION_LABEL_KEYS: Record<ReviewAction, TextKey> = {
  enter_review: 'review.action.enter_review',
  verify: 'review.action.verify',
  rework: 'review.action.rework',
  fail: 'review.action.fail',
}

type Props = {
  task: TaskDetail
  identity: Identity | null
  onChanged: () => void
}

export function TaskActions({ task, identity, onChanged }: Props) {
  const canReport = identity !== null && identity.sessionId === task.assigneeSessionId
  const canReview = identity?.role === 'supervisor'

  return (
    <div className="task-actions">
      {canReport ? <ReportForm task={task} onChanged={onChanged} /> : null}
      {canReview ? <ReviewForm task={task} onChanged={onChanged} /> : null}
    </div>
  )
}

function ReportForm({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const api = useCadreApi()
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [deliverablesText, setDeliverablesText] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ViewState<unknown> | null>(null)
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null)
  const inFlight = useRef(false)

  const submit = useCallback(async () => {
    if (inFlight.current) return
    if (!api.reportTask) {
      setError({ status: 'error', kind: 'system', code: 'INTERNAL_ERROR', message: 'Not connected', retryable: false })
      return
    }
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      const res = await api.reportTask({
        taskId: task.taskId,
        body,
        deliverables: deliverablesText.split('\n').map((line) => line.trim()).filter(Boolean),
        idempotencyKey,
      })
      if (!res.ok) {
        setError(failureToViewState(res, { emptyHint: t('report.sent') }))
        return
      }
      setReceipt(res)
      setIdempotencyKey(newIdempotencyKey())
      setBody('')
      setDeliverablesText('')
      onChanged()
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [api, body, deliverablesText, idempotencyKey, onChanged, t, task.taskId])

  return (
    <section className="panel panel--inline" data-testid="report-section">
      <button
        type="button"
        className="button button--ghost"
        data-testid="report-open"
        onClick={() => setOpen((value) => !value)}
      >
        {t('report.open')}
      </button>

      {open ? (
        <>
          <h3 className="panel__title">{t('report.heading')}</h3>
          <label className="field">
            <span>{t('report.body')}</span>
            <textarea
              data-testid="report-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={4}
              disabled={pending}
            />
          </label>
          <label className="field">
            <span>{t('report.deliverables')}</span>
            <textarea
              data-testid="report-deliverables"
              value={deliverablesText}
              onChange={(event) => setDeliverablesText(event.target.value)}
              rows={3}
              disabled={pending}
            />
          </label>

          <InlineFailure state={error} testId="report-error" />

          <div className="action-row">
            <button
              type="button"
              className="button"
              data-testid="report-submit"
              onClick={() => void submit()}
              disabled={pending}
            >
              {pending ? t('common.pending') : t('report.submit')}
            </button>
          </div>

          {receipt ? (
            <div className="receipt" data-testid="report-receipt">
              <h4 className="receipt__title">{t('report.sent')}</h4>
              <p>
                {t('receipt.status')}: {t(TASK_STATUS_LABEL_KEYS[receipt.taskStatusBefore])} →{' '}
                {t(TASK_STATUS_LABEL_KEYS[receipt.taskStatusAfter])}
              </p>
              <p>{t('receipt.bodyBytes')}: {receipt.bodyBytes}</p>
              <p>{t('receipt.preview')}: {receipt.preview}</p>
              {receipt.ledgerUpdated ? null : (
                <p className="form-error" data-testid="report-ledger-error">
                  {t('report.ledgerNotUpdated')} {receipt.ledgerError}
                </p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function ReviewForm({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const api = useCadreApi()
  const { t } = useLocale()
  const [action, setAction] = useState<ReviewAction>('enter_review')
  const [reason, setReason] = useState('')
  const [reasonMissing, setReasonMissing] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ViewState<unknown> | null>(null)
  const [receipt, setReceipt] = useState<TransitionReceipt | null>(null)
  const inFlight = useRef(false)

  const submit = useCallback(async () => {
    if (inFlight.current) return
    if ((action === 'rework' || action === 'fail') && reason.trim() === '') {
      setReasonMissing(true)
      // 缺失 reason 时不发送（后端也会拒，但就地提示更明确）。
      return
    }
    if (!api.reviewTask) {
      setError({ status: 'error', kind: 'system', code: 'INTERNAL_ERROR', message: 'Not connected', retryable: false })
      return
    }
    setReasonMissing(false)
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      const res = await api.reviewTask({
        taskId: task.taskId,
        action,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        idempotencyKey,
      })
      if (!res.ok) {
        setError(failureToViewState(res, { emptyHint: t('review.sent') }))
        return
      }
      setReceipt(res)
      setIdempotencyKey(newIdempotencyKey())
      setReason('')
      onChanged()
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [action, api, idempotencyKey, onChanged, reason, t, task.taskId])

  return (
    <section className="panel panel--inline" data-testid="review-section">
      <h3 className="panel__title">{t('review.heading')}</h3>
      <label className="field">
        <span>{t('review.action')}</span>
        <select
          data-testid="review-action"
          value={action}
          onChange={(event) => setAction(event.target.value as ReviewAction)}
          disabled={pending}
        >
          {REVIEW_ACTIONS.map((value) => (
            <option key={value} value={value}>{t(REVIEW_ACTION_LABEL_KEYS[value])}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('review.reason')}</span>
        <input
          data-testid="review-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
        />
      </label>
      {reasonMissing ? (
        <p className="form-error" role="alert" data-testid="review-reason-required">
          {t('review.reasonRequired')}
        </p>
      ) : null}

      <InlineFailure state={error} testId="review-error" />

      <div className="action-row">
        <button
          type="button"
          className="button"
          data-testid="review-submit"
          onClick={() => void submit()}
          disabled={pending}
        >
          {pending ? t('common.pending') : t('review.submit')}
        </button>
      </div>

      {receipt ? (
        <div className="receipt" data-testid="review-receipt">
          <h4 className="receipt__title">{t('review.sent')}</h4>
          <p>
            {t('receipt.status')}: {t(TASK_STATUS_LABEL_KEYS[receipt.from])} →{' '}
            {t(TASK_STATUS_LABEL_KEYS[receipt.to])}
          </p>
          <p>{t('receipt.taskId')}: <code>{receipt.taskId}</code></p>
          {receipt.ledgerUpdated ? null : (
            <p className="form-error" data-testid="review-ledger-error">
              {t('receipt.ledgerNotUpdated')}: {receipt.ledgerError}
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}

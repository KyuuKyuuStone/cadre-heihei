import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId, TaskId } from '../../../collab/protocol/ids.ts'
import type { DispatchReceipt } from '../../../collab/protocol/dispatch.ts'
import type { MemberSummary } from '../../../collab/protocol/roster.ts'
import type { ViewState } from '../../components/viewState.ts'
import { InlineFailure } from '../../components/InlineFailure.tsx'
import { useCadreApi } from '../../data/CadreApiProvider.tsx'
import { failureToViewState } from '../../data/failureMapping.ts'
import { newIdempotencyKey } from '../../data/idempotency.ts'
import type { DispatchResponse } from '../../data/ipcContract.ts'
import { useLocale } from '../../i18n/LocaleProvider.tsx'

type Props = {
  supersedesTaskId?: TaskId
  onClose: () => void
  onDispatched: (receipt: DispatchReceipt) => void
}

export function DispatchPanel({ supersedesTaskId, onClose, onDispatched }: Props) {
  const api = useCadreApi()
  const { t } = useLocale()
  const [targets, setTargets] = useState<MemberSummary[] | null>(null)
  const [rosterError, setRosterError] = useState<ViewState<unknown> | null>(null)
  const [toSessionId, setToSessionId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [supersedes, setSupersedes] = useState(supersedesTaskId ?? '')
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ViewState<unknown> | null>(null)
  const [receipt, setReceipt] = useState<DispatchResponse | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    void api.listRoster({ scope: 'project' }).then((res) => {
      if (!alive) return
      if (!res.ok) {
        setRosterError(failureToViewState(res, { emptyHint: t('dispatch.noTargets') }))
        setTargets([])
        return
      }
      setTargets(res.members.filter((member) =>
        member.dispatchable && member.role === 'worker' && member.state !== 'offline'))
    })
    return () => {
      alive = false
    }
  }, [api, t])

  const submit = useCallback(async () => {
    if (inFlight.current || !toSessionId) return
    if (!api.dispatchTask) {
      setError({ status: 'error', kind: 'system', code: 'INTERNAL_ERROR', message: 'Not connected', retryable: false })
      return
    }
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      const res = await api.dispatchTask({
        toSessionId: toSessionId as SessionId,
        title,
        body,
        idempotencyKey,
        ...(supersedes.trim() ? { supersedesTaskId: supersedes.trim() as TaskId } : {}),
      })
      if (!res.ok) {
        setError(failureToViewState(res, { emptyHint: t('dispatch.sent') }))
        return
      }
      setReceipt(res)
      onDispatched(res)
      // 成功后换新键；失败时保留同键供重试。
      setIdempotencyKey(newIdempotencyKey())
      setTitle('')
      setBody('')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [api, body, idempotencyKey, onDispatched, supersedes, t, title, toSessionId])

  const noTargets = targets !== null && targets.length === 0

  return (
    <div className="panel" data-testid="dispatch-panel">
      <h2 className="panel__title">{t('dispatch.heading')}</h2>

      <InlineFailure state={rosterError} testId="dispatch-roster-error" />

      <label className="field">
        <span>{t('dispatch.target')}</span>
        <select
          data-testid="dispatch-target"
          value={toSessionId}
          onChange={(event) => setToSessionId(event.target.value)}
          disabled={pending}
        >
          <option value="">—</option>
          {(targets ?? []).map((member) => (
            <option key={member.sessionId} value={member.sessionId}>{member.displayName}</option>
          ))}
        </select>
      </label>
      {noTargets ? <p className="hint" data-testid="dispatch-no-targets">{t('dispatch.noTargets')}</p> : null}

      <label className="field">
        <span>{t('dispatch.title')}</span>
        <input
          data-testid="dispatch-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={pending}
        />
      </label>

      <label className="field">
        <span>{t('dispatch.body')}</span>
        <textarea
          data-testid="dispatch-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          disabled={pending}
        />
      </label>

      <label className="field">
        <span>{t('dispatch.supersedes')}</span>
        <input
          data-testid="dispatch-supersedes"
          value={supersedes}
          onChange={(event) => setSupersedes(event.target.value)}
          disabled={pending}
        />
      </label>

      <InlineFailure state={error} testId="dispatch-error" />

      <div className="action-row">
        <button
          type="button"
          className="button"
          data-testid="dispatch-submit"
          onClick={() => void submit()}
          disabled={pending || noTargets || targets === null || !toSessionId}
        >
          {pending ? t('common.pending') : t('dispatch.submit')}
        </button>
        <button type="button" className="button button--ghost" onClick={onClose} disabled={pending}>
          {t('dispatch.cancel')}
        </button>
      </div>

      {receipt?.ok ? (
        <div className="receipt" data-testid="dispatch-receipt">
          <h3 className="receipt__title">{t('dispatch.sent')}</h3>
          <p>{t('receipt.taskId')}: <code>{receipt.taskId}</code></p>
          <p>{t('receipt.bodyBytes')}: {receipt.bodyBytes}</p>
          <p>{t('receipt.preview')}: {receipt.preview}</p>
          {receipt.ledgerUpdated ? null : (
            <p className="form-error" data-testid="dispatch-ledger-error">
              {t('receipt.ledgerNotUpdated')}: {receipt.ledgerError}
            </p>
          )}
          {receipt.supersededTask ? (
            <p>{t('receipt.status')}: {receipt.supersededTask.taskId} → {receipt.supersededTask.status}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { StateBoundary } from '../../components/StateBoundary.tsx'
import type { ViewState } from '../../components/viewState.ts'
import { useCadreApi } from '../../data/CadreApiProvider.tsx'
import { failureToViewState } from '../../data/failureMapping.ts'
import type { SessionId } from '../../../collab/protocol/ids.ts'
import { useLocale } from '../../i18n/LocaleProvider.tsx'
import {
  applySessionEvent,
  emptyConversationState,
  type ConversationState,
  type LocalMessage,
} from './sessionEvents.ts'

export function ConversationScreen() {
  const api = useCadreApi()
  const { t } = useLocale()
  const [identity, setIdentity] = useState<{ sessionId: SessionId } | null>(null)
  const [conversation, setConversation] = useState<ConversationState>(emptyConversationState)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<ViewState<null> | null>(null)

  useEffect(() => {
    if (!api.available) return
    let alive = true
    void api.whoami().then((res) => {
      if (alive && res.ok) setIdentity({ sessionId: res.sessionId })
    })
    return () => {
      alive = false
    }
  }, [api])

  // 事件订阅预留（契约 §5）：preload 事件泵就绪后自动生效。
  useEffect(() => {
    if (!identity || !api.subscribeSession || !api.onSessionEvent) return
    let alive = true
    let subscriptionId: string | undefined
    let stopListening: (() => void) | undefined
    void api.subscribeSession({ sessionId: identity.sessionId }).then((res) => {
      if (!alive || !res.ok) return
      subscriptionId = res.subscriptionId
      stopListening = api.onSessionEvent?.((event) => {
        setConversation((prev) => applySessionEvent(prev, event))
      })
    })
    return () => {
      alive = false
      stopListening?.()
      if (subscriptionId && api.unsubscribeSession) {
        void api.unsubscribeSession({ subscriptionId })
      }
    }
  }, [api, identity])

  const canSend = api.available && identity !== null && typeof api.sendMessage === 'function'

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!canSend || !body || !identity || !api.sendMessage) return
    setSending(true)
    const res = await api.sendMessage({ sessionId: identity.sessionId, body })
    setSending(false)

    if (res.ok) {
      const message: LocalMessage = {
        id: res.messageId,
        role: 'user',
        text: body,
        at: res.acceptedAt,
        status: 'sent',
      }
      setConversation((prev) => ({ ...prev, messages: [...prev.messages, message] }))
      setDraft('')
      setSendError(null)
      return
    }

    const mapped = failureToViewState<null>(res, { emptyHint: t('conversation.empty.hint') })
    if (mapped.status === 'denied') {
      // 跨项目拒绝：清空数据，不保留旧消息。
      setConversation(emptyConversationState)
    }
    setSendError(mapped)
  }, [api, canSend, draft, identity, t])

  const messagesState: ViewState<readonly LocalMessage[]> = conversation.messages.length === 0
    ? { status: 'empty', reason: t('conversation.empty.reason'), hint: t('conversation.empty.hint') }
    : { status: 'ready', data: conversation.messages }

  return (
    <section className="screen" data-screen="conversation" aria-label={t('nav.conversation')}>
      <h1 className="screen__title">{t('nav.conversation')}</h1>

      <StateBoundary
        state={messagesState}
        emptyTitle={t('conversation.empty.title')}
        renderReady={(messages) => (
          <ul className="message-list">
            {messages.map((message) => (
              <li key={message.id} className="message" data-role={message.role}>
                <p className="message__text">{message.text}</p>
              </li>
            ))}
          </ul>
        )}
      />

      {sendError?.status === 'denied' ? (
        <div className="state state--denied" role="alert" data-testid="conversation-denied">
          <p className="state__reason">{sendError.message}</p>
        </div>
      ) : null}
      {sendError?.status === 'error' ? (
        <p className="form-error" role="alert" data-testid="composer-error">{sendError.message}</p>
      ) : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          className="composer__input"
          data-testid="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('conversation.composer.placeholder')}
          aria-label={t('conversation.composer.placeholder')}
          disabled={!canSend || sending}
          rows={3}
        />
        <button
          type="submit"
          className="button"
          data-testid="composer-send"
          disabled={!canSend || sending || draft.trim() === ''}
        >
          {t('conversation.composer.send')}
        </button>
        {!canSend ? (
          <p className="composer-note" role="status" data-testid="composer-note">
            {t('conversation.composer.notConnected')}
          </p>
        ) : null}
      </form>
    </section>
  )
}

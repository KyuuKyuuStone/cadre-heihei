import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [subscribeNonce, setSubscribeNonce] = useState(0)
  const [subscription, setSubscription] = useState<'none' | 'loading' | 'ready' | 'error'>('none')
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  const canSubscribe = Boolean(api.subscribeSession && api.onSessionEvent)
  // 订阅 effect 只读 ref，避免每收到一个事件就重订阅。
  const lastSeqRef = useRef(0)
  useEffect(() => {
    lastSeqRef.current = conversation.lastSeq
  }, [conversation.lastSeq])

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

  // 事件订阅（契约 §5 / dc974a8）：重订阅携带本地 lastSeq，后端补发 seq > lastSeq 的事件。
  useEffect(() => {
    if (!identity || !api.subscribeSession || !api.onSessionEvent) {
      setSubscription('none')
      return
    }
    let alive = true
    let subscriptionId: string | undefined
    let stopListening: (() => void) | undefined
    const lastSeq = lastSeqRef.current
    setSubscription('loading')
    void api.subscribeSession({
      sessionId: identity.sessionId,
      ...(lastSeq > 0 ? { lastSeq } : {}),
    }).then((res) => {
      if (!alive) return
      if (!res.ok) {
        setSubscription('error')
        setSubscriptionError(res.error.message)
        return
      }
      setSubscription('ready')
      setSubscriptionError(null)
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
  }, [api, identity, subscribeNonce])

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

  const hasMessages = conversation.messages.length > 0
  // loading ≠ empty：可订阅时在订阅建立前/重订阅期间显示进行中，不落入空态。
  const messagesState: ViewState<readonly LocalMessage[]> = hasMessages
    ? { status: 'ready', data: conversation.messages }
    : conversation.error
      ? {
        status: 'error',
        kind: 'system',
        code: conversation.error.code,
        message: conversation.error.message,
        retryable: conversation.error.retryable,
      }
      : canSubscribe && (subscription === 'none' || subscription === 'loading')
        ? { status: 'loading' }
        : canSubscribe && subscription === 'error'
          ? {
            status: 'error',
            kind: 'system',
            code: 'SUBSCRIPTION_FAILED',
            message: subscriptionError ?? t('state.error'),
            retryable: true,
          }
          : { status: 'empty', reason: t('conversation.empty.reason'), hint: t('conversation.empty.hint') }

  return (
    <section className="screen" data-screen="conversation" aria-label={t('nav.conversation')}>
      <h1 className="screen__title">{t('nav.conversation')}</h1>

      {api.subscribeSession && api.onSessionEvent ? (
        <div className="action-row">
          <button
            type="button"
            className="button button--ghost"
            data-testid="conversation-reconnect"
            onClick={() => setSubscribeNonce((value) => value + 1)}
          >
            {t('conversation.reconnect')}
          </button>
        </div>
      ) : null}

      {conversation.streaming ? (
        <div className="state state--progress" role="status" data-testid="conversation-streaming">
          {t('state.streaming')}
        </div>
      ) : null}
      {conversation.error && conversation.messages.length > 0 ? (
        <p className="form-error" role="alert" data-testid="conversation-error">
          {conversation.error.message}
          <code className="state__code">{conversation.error.code}</code>
        </p>
      ) : null}

      <StateBoundary
        state={messagesState}
        emptyTitle={t('conversation.empty.title')}
        renderReady={(messages) => (
          <ul className="message-list">
            {messages.map((message) => (
              <li key={message.id} className="message" data-role={message.role}>
                <MessageBody message={message} />
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

const MAX_MESSAGE_LINES = 10

/** A-F2：超长消息/工具输出默认截断，保留「展开全文」入口。 */
function MessageBody({ message }: { message: LocalMessage }) {
  const [expanded, setExpanded] = useState(false)
  const lines = message.text.split('\n')
  if (expanded || lines.length <= MAX_MESSAGE_LINES) {
    return <p className="message__text">{message.text}</p>
  }
  return (
    <StateBoundary
      state={{
        status: 'truncated',
        data: lines.slice(0, MAX_MESSAGE_LINES).join('\n'),
        truncated: {
          totalLines: lines.length,
          shownLines: MAX_MESSAGE_LINES,
          ...(message.outputFile ? { outputFile: message.outputFile } : {}),
        },
      }}
      renderReady={(text) => <p className="message__text">{text}</p>}
      onExpand={() => setExpanded(true)}
    />
  )
}

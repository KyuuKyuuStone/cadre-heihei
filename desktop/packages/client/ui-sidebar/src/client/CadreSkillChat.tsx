/** Supervisor skill chat: one bound admin conversation, inline messages, no modal or session switch. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSkillAdminSession,
  listSkillAdminSessions,
  readSkillAdminMessages,
  sendSkillAdminMessage,
  SkillAdminError,
  skillAdminErrorKey,
  type SkillAdminMessage,
} from './CadreSkillAdmin.ts'
import css from './CadreSkillChat.module.css'

function errorText(cause: unknown, t: PropsLocale<'sidebar'>['t']): string {
  return cause instanceof SkillAdminError
    ? t(skillAdminErrorKey(cause.code) as never)
    : cause instanceof Error ? cause.message : String(cause)
}

export function CadreSkillChat({
  projectId, actorSessionId, t,
}: {
  readonly projectId: string
  readonly actorSessionId: string
  readonly t: PropsLocale<'sidebar'>['t']
}) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<readonly SkillAdminMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextSeq = useRef(0)
  const pendingRef = useRef<string | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  const boot = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const sessions = await listSkillAdminSessions(projectId)
      const existing = [...sessions]
        .filter(session => typeof session.sessionId === 'string' && session.sessionId !== '')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const chosen = existing ?? await createSkillAdminSession(projectId)
      if (typeof chosen.sessionId !== 'string' || chosen.sessionId === '') {
        throw new Error(t('skills.chat.errorSession'))
      }
      setSessionId(chosen.sessionId)
    } catch (cause) {
      setError(errorText(cause, t))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => { void boot() }, [boot])

  const poll = useCallback(async (): Promise<void> => {
    if (sessionId === null) return
    const page = await readSkillAdminMessages(projectId, actorSessionId, sessionId, nextSeq.current)
    nextSeq.current = Math.max(nextSeq.current, page.nextSeq)
    if (page.messages.length > 0) {
      setMessages((current) => {
        const seen = new Set(current.map(message => message.seq))
        return [...current, ...page.messages.filter(message => !seen.has(message.seq))]
      })
      if (pendingRef.current !== null && page.messages.some(message =>
        message.role === 'user' && message.text === pendingRef.current)) {
        pendingRef.current = null
        setPending(null)
      }
    }
  }, [actorSessionId, projectId, sessionId])

  useEffect(() => {
    if (sessionId === null) return
    let alive = true
    const tick = (): void => {
      void poll().catch((cause: unknown) => {
        if (alive) setError(errorText(cause, t))
      })
    }
    tick()
    const timer = window.setInterval(tick, 1500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [poll, sessionId, t])

  useEffect(() => {
    if (typeof endRef.current?.scrollIntoView === 'function') {
      endRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [messages, pending])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sessionId === null || sending) return
    setSending(true)
    setError(null)
    try {
      await sendSkillAdminMessage(projectId, actorSessionId, sessionId, text)
      setDraft('')
      pendingRef.current = text
      setPending(text)
      await poll()
    } catch (cause) {
      setError(errorText(cause, t))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={css.panel} data-skill-chat>
      <header className={css.head}>
        <div>
          <h2>{t('skills.chat.title')}</h2>
          <p>{t('skills.chat.description')}</p>
        </div>
      </header>
      <div className={css.messages} aria-live="polite">
        {loading && <p className={css.state}>{t('skills.chat.loading')}</p>}
        {!loading && messages.length === 0 && pending === null && (
          <div className={css.empty}>
            <p>{t('skills.chat.empty')}</p>
            <ul>
              <li>{t('skills.chat.exampleCatalog')}</li>
              <li>{t('skills.chat.exampleInstall')}</li>
              <li>{t('skills.chat.exampleSafety')}</li>
            </ul>
          </div>
        )}
        {messages.map(message => (
          <article key={message.seq} className={message.role === 'user' ? css.userBubble : css.assistantBubble}>
            <span className={css.role}>{t(message.role === 'user' ? 'skills.chat.you' : 'skills.chat.assistant')}</span>
            <p>{message.text}</p>
          </article>
        ))}
        {pending !== null && (
          <article className={css.userBubble}>
            <span className={css.role}>{t('skills.chat.you')}</span>
            <p>{pending}</p>
            <span className={css.pending}>{t('skills.chat.sending')}</span>
          </article>
        )}
        <div ref={endRef} />
      </div>
      {error !== null && (
        <div className={css.errorRow} role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => { setError(null); void boot() }}>
            {t('skills.chat.retry')}
          </Button>
        </div>
      )}
      <div className={css.composer}>
        <Input value={draft} disabled={loading || sending || sessionId === null}
          placeholder={t('skills.chat.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }} />
        <Button variant="primary" disabled={draft.trim() === '' || sending || sessionId === null}
          onClick={() => { void send() }}>
          {sending ? t('skills.chat.sending') : t('skills.chat.send')}
        </Button>
      </div>
    </section>
  )
}

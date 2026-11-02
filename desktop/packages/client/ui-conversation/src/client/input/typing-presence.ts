/** Debounced "user is typing" presence for the composer. */
import { useEffect, useRef } from 'react'

export const TYPING_DEBOUNCE_MS = 300

/** Report one typing transition; failures stay silent (advisory presence only). */
export function reportTyping(sessionId: string, typing: boolean): void {
  try {
    void fetch('/cadre/session/typing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, typing }),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // A missing transport must never affect drafting or submitting.
  }
}

/**
 * Debounce draft changes into typing true/false reports and clear on blur,
 * submit, session change, or unmount.
 * @param sessionId - current Session, absent outside a Session seat.
 * @param draft - current composer text.
 * @param root - editable root element, used for blur.
 * @param phase - input machine phase; `submitting` ends typing immediately.
 */
export function useTypingPresence(
  sessionId: string | undefined,
  draft: string,
  root: HTMLElement | null,
  phase: string | undefined,
): void {
  const timer = useRef<number | undefined>(undefined)
  const active = useRef(false)
  const controller = useRef<AbortController | undefined>(undefined)

  const send = (typing: boolean): void => {
    if (sessionId === undefined) return
    if (active.current === typing) return
    active.current = typing
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    try {
      void fetch('/cadre/session/typing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, typing }),
        keepalive: true,
        signal: next.signal,
      }).catch(() => undefined)
    } catch {
      // Presence is advisory; never surface transport failures in the composer.
    }
  }

  useEffect(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    if (sessionId === undefined) return
    if (draft.trim() === '') {
      send(false)
      return
    }
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      send(true)
    }, TYPING_DEBOUNCE_MS)
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [draft, sessionId])

  useEffect(() => {
    if (phase === 'submitting') send(false)
  }, [phase])

  useEffect(() => {
    if (sessionId === undefined) return
    const stored = sessionId
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      active.current = false
      reportTyping(stored, false)
    }
  }, [sessionId])

  useEffect(() => {
    if (root === null || sessionId === undefined) return
    const clear = (): void => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = undefined
      send(false)
    }
    root.addEventListener('blur', clear)
    window.addEventListener('blur', clear)
    return () => {
      root.removeEventListener('blur', clear)
      window.removeEventListener('blur', clear)
    }
  }, [root, sessionId])
}

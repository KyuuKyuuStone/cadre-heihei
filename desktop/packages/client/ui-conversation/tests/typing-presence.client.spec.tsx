// @vitest-environment jsdom
import { useCallback, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TYPING_DEBOUNCE_MS, useTypingPresence } from '../src/client/input/typing-presence.ts'

function Harness({ phase }: { readonly phase?: string }) {
  const [draft, setDraft] = useState('你')
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((node: HTMLDivElement | null) => { setRoot(node) }, [])
  useTypingPresence('s1', draft, root, phase)
  return (
    <div>
      <div ref={attach} data-typing-root tabIndex={0} />
      <button onClick={() => { setDraft('') }}>clear</button>
    </div>
  )
}

const json = (): Response => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('composer typing presence', () => {
  it('debounces a non-empty draft into typing true', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => json())
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    act(() => { vi.advanceTimersByTime(TYPING_DEBOUNCE_MS - 1) })
    expect(fetchMock).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string))
      .toEqual({ sessionId: 's1', typing: true })
  })

  it('clears immediately when the draft empties', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => json())
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    act(() => { vi.advanceTimersByTime(TYPING_DEBOUNCE_MS) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'clear' })) })
    expect(JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string))
      .toEqual({ sessionId: 's1', typing: false })
  })

  it('clears on blur without waiting for the debounce', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => json())
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<Harness />)
    act(() => { vi.advanceTimersByTime(TYPING_DEBOUNCE_MS) })
    act(() => { fireEvent.blur(view.container.querySelector('[data-typing-root]')!) })
    expect(JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string))
      .toEqual({ sessionId: 's1', typing: false })
  })

  it('clears when submission starts', () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => json())
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<Harness />)
    act(() => { vi.advanceTimersByTime(TYPING_DEBOUNCE_MS) })
    view.rerender(<Harness phase="submitting" />)
    expect(JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string))
      .toEqual({ sessionId: 's1', typing: false })
  })

  it('stays silent when the presence request fails', () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<Harness />)
    expect(() => { act(() => { vi.advanceTimersByTime(TYPING_DEBOUNCE_MS) }) }).not.toThrow()
  })
})

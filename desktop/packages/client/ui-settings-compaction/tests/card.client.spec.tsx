// @vitest-environment jsdom
/** User-visible behavior of the context compaction settings form. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { CompactionCard, type CompactionCardProps } from '../src/client/CompactionCard.tsx'
import type { CompactionCardState } from '../src/client/compaction-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]
const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function renderCard(state: Partial<CompactionCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<CompactionCardState>({
    ...settled, auto: field(''), thresholdRatio: field(''), ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  const props = { ...actions, view, t, useCompactionCard: bindSnapshotSelector(store) } as CompactionCardProps
  const rendered = render(<CompactionCard {...props} />)
  return { ...actions, ...rendered }
}

describe('CompactionCard', () => {
  it('renders only the summary in the Plugins list', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('shows inherited auto as its own selected state, not as off', () => {
    renderCard()

    expect(screen.getByRole('tab', { name: en.autoInherited }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: en.autoDisabled }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('plugin-config-compaction-auto-inherit')
    expect(screen.getByRole('tabpanel').textContent).toBe(en.autoInheritedHint)
    cleanup()

    renderCard({ auto: field('true', { overridden: true }) })
    expect(screen.getByRole('tabpanel').textContent).toBe(en.autoEnabledHint)
    cleanup()

    renderCard({ auto: field('false', { overridden: true }) })
    expect(screen.getByRole('tab', { name: en.autoDisabled }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe(en.autoDisabledHint)
  })

  it('stages on, off, and inherited auto choices', () => {
    const actions = renderCard({ auto: field('true', { overridden: true }) })

    fireEvent.click(screen.getByRole('tab', { name: en.autoDisabled }))
    fireEvent.click(screen.getByRole('tab', { name: en.autoInherited }))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('auto', 'false')
    expect(actions.resetField).toHaveBeenCalledWith('auto')
    expect(actions.resetField).toHaveBeenCalledTimes(2)
  })

  it('supports keyboard selection of automatic compaction', () => {
    const actions = renderCard()
    const inherited = screen.getByRole('tab', { name: en.autoInherited })
    inherited.focus()

    fireEvent.keyDown(inherited, { key: 'ArrowRight' })

    expect(actions.edit).toHaveBeenCalledWith('auto', 'true')
  })

  it('stages ratio edits, reset, and save', () => {
    const actions = renderCard({ dirty: true, thresholdRatio: field('0.8', { overridden: true }) })

    fireEvent.change(screen.getByLabelText(en.thresholdRatio), { target: { value: '0.7' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('thresholdRatio', '0.7')
    expect(actions.resetField).toHaveBeenCalledWith('thresholdRatio')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('explains pressure, overflow recovery, manual compaction, and read-only safety fields', () => {
    renderCard()

    expect(screen.getByText(en.pressureBudget)).toBeTruthy()
    expect(screen.getByText(en.overflowFallback)).toBeTruthy()
    expect(screen.getByText(en.manualCompaction).textContent).toContain('/compact')
    expect(screen.getByText(en.safetyDescription)).toBeTruthy()
    expect(screen.getByText('thresholdTokens')).toBeTruthy()
    expect(screen.getByText(/stepPressureCheck/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /thresholdTokens/ })).toBeNull()
  })

  it('renders unavailable and read-only states and disables every editable control', () => {
    renderCard({ available: false })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByRole('tablist')).toBeNull()
    cleanup()

    renderCard({ writable: false })
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.thresholdRatio)).toHaveProperty('disabled', true)
  })

  it('renders invalid, saving, and failed states without losing the draft', () => {
    renderCard({ dirty: true, invalid: true, thresholdRatio: field('1.5', { invalid: true }) })
    expect(screen.getByText(en.invalidRatio)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    cleanup()

    renderCard({ dirty: true, saving: true, thresholdRatio: field('0.8') })
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveProperty('disabled', true)
    cleanup()

    renderCard({ dirty: true, failed: true, thresholdRatio: field('0.8') })
    expect(screen.getByRole('status').textContent).toBe(en.saveFailed)
    expect(screen.getByLabelText(en.thresholdRatio)).toHaveProperty('value', '0.8')
  })

  it('discards staged edits when the page unmounts', () => {
    const actions = renderCard({ dirty: true })

    actions.unmount()

    expect(actions.discard).toHaveBeenCalledOnce()
  })
})

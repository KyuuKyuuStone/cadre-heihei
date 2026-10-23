// @vitest-environment jsdom
/**
 * Employee promotion dialog: what it writes as the employee template.
 *
 * A blank Session applies the chosen preset and records it. A Session that has
 * already started keeps its composition, so the dialog must record the preset
 * the Session actually projects instead of leaving `template_id` empty; a
 * preset outside `cadre-*` is not an employee template and stays empty.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmployeeDialog, type EmployeeRecord, type EmployeeWrite } from '../src/client/CadreEmployee.tsx'

type DialogProps = Parameters<typeof EmployeeDialog>[0]

const request = { sessionId: 'ses-promote-1', displayTitle: '待升格会话' }

afterEach(() => { cleanup() })

interface Harness {
  readonly saveEmployee: ReturnType<typeof vi.fn>
  readonly applyPreset: ReturnType<typeof vi.fn>
  readonly applyModel: ReturnType<typeof vi.fn>
  /** Row the fake bridge returns from the post-save read-back. */
  stored(): EmployeeRecord | null
}

function renderDialog(overrides: {
  readonly blank: boolean | undefined
  readonly projectedPreset: string | undefined
  readonly presets?: readonly { id: string; name: string }[]
}): Harness {
  let stored: EmployeeRecord | null = null
  const saveEmployee = vi.fn(async (input: EmployeeWrite) => {
    stored = {
      sessionId: input.sessionId,
      ...(input.displayName === undefined || input.displayName === null ? {} : { displayName: input.displayName }),
      ...(input.templateId === undefined || input.templateId === null ? {} : { templateId: input.templateId }),
      ...(input.preferredProviderId === undefined || input.preferredProviderId === null
        ? {}
        : { preferredProviderId: input.preferredProviderId }),
      ...(input.preferredModel === undefined || input.preferredModel === null ? {} : { preferredModel: input.preferredModel }),
    }
    return { ok: true, employee: stored }
  })
  const applyPreset = vi.fn(async () => ({ ok: true }))
  const applyModel = vi.fn(async () => ({ ok: true }))
  const props = {
    useRequest: <T,>(selector: (value: typeof request | null) => T): T => selector(request),
    closeEmployeeDialog: vi.fn(),
    getEmployee: async () => ({ ok: true, employee: stored }),
    listPresets: async () => ({
      ok: true,
      value: overrides.presets ?? [
        { id: 'cadre-general', name: '通用 · General Assistant' },
        { id: 'cadre-dev', name: '开发 · Development' },
      ],
    }),
    loadModels: async () => ({
      ok: true,
      value: {
        groups: [{ id: 'p-openai', name: 'OpenAI 兼容', models: [{ id: 'm-flash', name: 'Flash' }] }],
        defaultProvider: 'p-openai',
        defaultModel: 'm-flash',
      },
    }),
    isBlank: () => overrides.blank,
    currentPreset: () => overrides.projectedPreset,
    applyPreset,
    applyModel,
    saveEmployee,
    refreshEmployees: vi.fn(),
  } as unknown as DialogProps
  render(<EmployeeDialog {...props} />)
  return { saveEmployee, applyPreset, applyModel, stored: () => stored }
}

async function submit(): Promise<void> {
  const button = await waitFor(() => {
    const candidate = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    if (candidate.disabled) throw new Error('still loading')
    return candidate
  })
  fireEvent.click(button)
}

describe('employee promotion template', () => {
  it('records the preset a non-blank Session projects', async () => {
    const harness = renderDialog({ blank: false, projectedPreset: 'cadre-general' })
    await submit()
    await waitFor(() => { expect(harness.saveEmployee).toHaveBeenCalledTimes(1) })
    const written = harness.saveEmployee.mock.calls[0]?.[0] as EmployeeWrite
    expect(written.templateId).toBe('cadre-general')
    // The preset is locked after the first turn, so nothing may re-select it.
    expect(harness.applyPreset).not.toHaveBeenCalled()
    expect(harness.stored()?.templateId).toBe('cadre-general')
  })

  it('still applies and records the chosen template for a blank Session', async () => {
    const harness = renderDialog({ blank: true, projectedPreset: 'standard' })
    await submit()
    await waitFor(() => { expect(harness.applyPreset).toHaveBeenCalledTimes(1) })
    expect(harness.applyPreset).toHaveBeenCalledWith('ses-promote-1', 'cadre-general')
    const written = harness.saveEmployee.mock.calls[0]?.[0] as EmployeeWrite
    expect(written.templateId).toBe('cadre-general')
    expect(harness.stored()?.templateId).toBe('cadre-general')
  })

  it('leaves the template empty when the Session runs a non-cadre preset', async () => {
    const harness = renderDialog({ blank: false, projectedPreset: 'standard' })
    await submit()
    await waitFor(() => { expect(harness.saveEmployee).toHaveBeenCalledTimes(1) })
    const written = harness.saveEmployee.mock.calls[0]?.[0] as EmployeeWrite
    expect(written.templateId).toBeUndefined()
    expect(harness.stored()?.templateId).toBeUndefined()
  })
})

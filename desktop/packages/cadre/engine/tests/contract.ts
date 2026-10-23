/**
 * One contract, two bindings: every case here runs against the Client binding
 * and the Host binding through the same `EnginePort` surface. The harness hides
 * where the official values come from; the expectations do not change.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionAssistantStreamFrame, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { EnginePort } from '../src/types.ts'

/** Session identity shared by every contract case. */
export const SESSION = SessionId('ses-contract-1')
/** Identity of the Session a create call returns. */
export const CREATED = SessionId('ses-created')
/** One prompt admission identity. */
export const REQUEST = brandString<SessionRequestId>('req-contract-1')

/** Official method a failure is injected into. */
export type InjectKey =
  | 'modelCatalog' | 'list' | 'create' | 'rename' | 'selectModel' | 'projections'
  | 'prompt' | 'cancel' | 'presetsList' | 'presetsRead' | 'presetsSelect'

/** One recorded official invocation. */
export interface RecordedCall {
  readonly method: InjectKey
  readonly args: readonly unknown[]
}

/** Official fixtures both bindings must return unchanged. */
export const FIXTURES = {
  catalog: {
    default: { provider: 'p-contract', model: 'm-contract' },
    routableProviders: ['p-contract'],
    groups: [{ id: 'p-contract', name: 'Contract Provider', models: [{ id: 'm-contract', name: 'Contract Model' }] }],
    failures: [],
  },
  presetRow: { id: 'cadre-dev', isDefault: false, name: 'Development' },
  presetDocument: { agentPreset: 'cadre-dev', content: '- id: example\n', name: 'Development' },
  followFrames: [
    {
      type: 'snapshot',
      header: { version: 1, id: SESSION, createdAt: 0, isSeeded: false },
      cursor: 7,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 7, values: {} },
    },
    { type: 'event', event: { type: 'turn/started', seq: 8, time: 0, data: {} } },
    {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId: LlmAttemptId('attempt-1'), revision: 1, index: 0, outcome: { kind: 'abandoned' },
      } satisfies SessionAssistantStreamFrame,
    },
  ] satisfies readonly SessionFollowFrame[],
} as const

/** One list row a binding must present. */
export interface ContractSessionRow {
  readonly sessionId: string
  readonly blank?: boolean
  readonly running?: boolean
}

/** Binding-specific fixture control; the contract only calls these. */
export interface ContractHarness {
  readonly port: EnginePort
  readonly calls: readonly RecordedCall[]
  /** Make the next official call of `method` fail with this official code. */
  failNext(method: InjectKey, code: string): void
  /** Replace the Session list and projections the binding reads. */
  seedSessions(rows: readonly ContractSessionRow[]): void
  /** Report the seeded Session as absent (no list row, null projections). */
  seedMissingSession(): void
  /** Replace the preset roster. */
  seedPresets(rows: readonly { id: string; isDefault: boolean; name?: string; broken?: string }[]): void
  /** Drive one watchSessions invalidation. */
  touch(sessionId: string): void
  /** Stop background streams started by the port. */
  dispose(): void
}

/** Last recorded call for one official method. */
function lastCall(harness: ContractHarness, method: InjectKey): RecordedCall | undefined {
  return [...harness.calls].reverse().find(call => call.method === method)
}

/**
 * Register the shared contract; a binding spec supplies only its harness.
 * @param harness - binding-specific fixture factory.
 */
export function runEngineContract(harness: () => ContractHarness): void {
  describe('EnginePort contract', () => {
    it('lists models from the official catalogue unchanged', async () => {
      const runtime = harness()
      try {
        const listed = await runtime.port.models.listModels()
        expect(listed).toEqual({ ok: true, value: FIXTURES.catalog })
      } finally { runtime.dispose() }
    })

    it('surfaces the official listModels failure code', async () => {
      const runtime = harness()
      try {
        runtime.failNext('modelCatalog', 'session/provider-unavailable')
        const listed = await runtime.port.models.listModels()
        expect(listed.ok).toBe(false)
        expect(listed.ok ? '' : listed.error.code).toBe('session/provider-unavailable')
      } finally { runtime.dispose() }
    })

    it('forwards a model selection with its reasoning effort', async () => {
      const runtime = harness()
      try {
        const selected = await runtime.port.models.selectModel({
          sessionId: SESSION, provider: 'p-contract', model: 'm-contract',
          reasoningEffort: ReasoningEffortId('high'),
        })
        expect(selected).toEqual({ ok: true, value: { selected: { provider: 'p-contract', model: 'm-contract' } } })
        expect(lastCall(runtime, 'selectModel')?.args[0]).toMatchObject({
          sessionId: SESSION, provider: 'p-contract', model: 'm-contract', reasoningEffort: 'high',
        })
      } finally { runtime.dispose() }
    })

    it('surfaces the official selectModel failure code', async () => {
      const runtime = harness()
      try {
        runtime.failNext('selectModel', 'session/model-unavailable')
        const selected = await runtime.port.models.selectModel({ sessionId: SESSION, provider: 'p', model: 'm' })
        expect(selected.ok).toBe(false)
        expect(selected.ok ? '' : selected.error.code).toBe('session/model-unavailable')
      } finally { runtime.dispose() }
    })

    it('lists sessions as official summaries', async () => {
      const runtime = harness()
      try {
        runtime.seedSessions([{ sessionId: SESSION, blank: false, running: true }])
        const listed = await runtime.port.sessions.listSessions()
        expect(listed.ok).toBe(true)
        expect(listed.ok ? listed.value.map(row => row.sessionId) : []).toEqual([SESSION])
        expect(listed.ok ? listed.value[0]?.running : undefined).toBe(true)
        expect(lastCall(runtime, 'list')?.args[0]).toEqual({})
      } finally { runtime.dispose() }
    })

    it('treats an empty session list as a successful empty value', async () => {
      const runtime = harness()
      try {
        runtime.seedSessions([])
        const listed = await runtime.port.sessions.listSessions()
        expect(listed).toEqual({ ok: true, value: [] })
      } finally { runtime.dispose() }
    })

    it('forwards create options and returns the created identity', async () => {
      const runtime = harness()
      try {
        const created = await runtime.port.sessions.createSession({ cwd: 'D:/work', agentPreset: 'cadre-dev' })
        expect(created).toEqual({ ok: true, value: { sessionId: CREATED, agentPreset: 'cadre-dev' } })
        expect(lastCall(runtime, 'create')?.args[0]).toMatchObject({ cwd: 'D:/work', agentPreset: 'cadre-dev' })
      } finally { runtime.dispose() }
    })

    it('returns the official rename result', async () => {
      const runtime = harness()
      try {
        const renamed = await runtime.port.sessions.renameSession(SESSION, '新标题')
        expect(renamed).toEqual({ ok: true, value: { title: '新标题', seq: 3 } })
        expect(lastCall(runtime, 'rename')?.args[0]).toMatchObject({ sessionId: SESSION, title: '新标题' })
      } finally { runtime.dispose() }
    })

    it('reads one session row and its projections', async () => {
      const runtime = harness()
      try {
        runtime.seedSessions([{ sessionId: SESSION, blank: true }])
        const state = await runtime.port.sessions.getSessionState(SESSION)
        expect(state.ok).toBe(true)
        if (!state.ok) return
        expect(state.value.summary?.sessionId).toBe(SESSION)
        expect(state.value.projections).toEqual({ kind: 'sequenced', asOfSeq: 5, values: { agentPreset: 'cadre-dev' } })
      } finally { runtime.dispose() }
    })

    it('reports an absent session as an undefined summary and null projections', async () => {
      const runtime = harness()
      try {
        runtime.seedMissingSession()
        const state = await runtime.port.sessions.getSessionState(SessionId('ses-absent'))
        expect(state.ok).toBe(true)
        if (!state.ok) return
        expect(state.value.summary).toBeUndefined()
        expect(state.value.projections).toBeNull()
      } finally { runtime.dispose() }
    })

    it('reports session invalidations and stops after unsubscribe', async () => {
      const runtime = harness()
      try {
        runtime.seedSessions([{ sessionId: SESSION }])
        const listener = vi.fn()
        const unsubscribe = runtime.port.sessions.watchSessions(listener)
        runtime.touch(SESSION)
        await vi.waitFor(() => { expect(listener).toHaveBeenCalledWith({ sessionId: SESSION }) })
        unsubscribe()
        listener.mockClear()
        runtime.touch(SESSION)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(listener).not.toHaveBeenCalled()
      } finally { runtime.dispose() }
    })

    it('lists presets including broken declarations', async () => {
      const runtime = harness()
      try {
        runtime.seedPresets([{ ...FIXTURES.presetRow }, { id: 'cadre-broken', isDefault: false, broken: 'boom' }])
        const listed = await runtime.port.presets.listPresets()
        expect(listed.ok).toBe(true)
        expect(listed.ok ? listed.value : []).toEqual([
          { id: 'cadre-dev', isDefault: false, name: 'Development' },
          { id: 'cadre-broken', isDefault: false, broken: 'boom' },
        ])
      } finally { runtime.dispose() }
    })

    it('reads a preset document and surfaces agent-preset/not-found', async () => {
      const runtime = harness()
      try {
        const document = await runtime.port.presets.readPreset('cadre-dev')
        expect(document).toEqual({ ok: true, value: FIXTURES.presetDocument })
        runtime.failNext('presetsRead', 'agent-preset/not-found')
        const missing = await runtime.port.presets.readPreset('cadre-missing')
        expect(missing.ok).toBe(false)
        expect(missing.ok ? '' : missing.error.code).toBe('agent-preset/not-found')
      } finally { runtime.dispose() }
    })

    it('applies a preset and surfaces agent-preset/locked', async () => {
      const runtime = harness()
      try {
        const applied = await runtime.port.presets.applyPreset(SESSION, 'cadre-dev')
        expect(applied).toEqual({ ok: true, value: { agentPreset: 'cadre-dev' } })
        runtime.failNext('presetsSelect', 'agent-preset/locked')
        const locked = await runtime.port.presets.applyPreset(SESSION, 'cadre-general')
        expect(locked.ok).toBe(false)
        expect(locked.ok ? '' : locked.error.code).toBe('agent-preset/locked')
        expect(lastCall(runtime, 'presetsSelect')?.args[1]).toBe('cadre-general')
      } finally { runtime.dispose() }
    })

    it('admits a prompt with its content and receipt', async () => {
      const runtime = harness()
      try {
        const content = [{ type: 'text' as const, text: '做完了' }]
        const receipt = await runtime.port.turns.runTurn({
          sessionId: SESSION, requestId: REQUEST, mode: 'queue', content,
        })
        expect(receipt).toEqual({ ok: true, value: { accepted: true } })
        expect(lastCall(runtime, 'prompt')?.args[0]).toMatchObject({
          sessionId: SESSION, requestId: REQUEST, mode: 'queue', content,
        })
      } finally { runtime.dispose() }
    })

    it('surfaces the official prompt failure code', async () => {
      const runtime = harness()
      try {
        runtime.failNext('prompt', 'gateway/bad-request')
        const receipt = await runtime.port.turns.runTurn({
          sessionId: SESSION, requestId: REQUEST, mode: 'steer', content: [{ type: 'text', text: 'hi' }],
        })
        expect(receipt.ok).toBe(false)
        expect(receipt.ok ? '' : receipt.error.code).toBe('gateway/bad-request')
      } finally { runtime.dispose() }
    })

    it('returns the official cancellation receipt', async () => {
      const runtime = harness()
      try {
        const cancelled = await runtime.port.turns.cancelTurn(SESSION)
        expect(cancelled).toEqual({ ok: true, value: { accepted: true } })
        expect(lastCall(runtime, 'cancel')?.args[0]).toMatchObject({ sessionId: SESSION })
      } finally { runtime.dispose() }
    })

    it('maps follow frames and disposes the stream when iteration ends', async () => {
      const runtime = harness()
      try {
        const controller = new AbortController()
        const seen: string[] = []
        for await (const frame of runtime.port.turns.followTurn({ sessionId: SESSION, signal: controller.signal })) {
          seen.push(frame.kind)
        }
        expect(seen).toEqual(['opening', 'event', 'assistant'])
      } finally { runtime.dispose() }
    })
  })
}

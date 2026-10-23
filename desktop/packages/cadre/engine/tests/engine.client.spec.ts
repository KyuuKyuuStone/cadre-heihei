/**
 * Contract run for the Client binding, over fake official Client Remote
 * namespaces and a fake Client Session list store. No Cordis context is
 * required, which keeps this package independently testable.
 */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createClientEnginePort,
  type ClientEngineDeps, type ClientOutcome, type ClientPresetRemote, type ClientSessionRemote,
} from '../src/client/index.ts'
import type { SessionSummaryView } from '../src/types.ts'
import {
  CREATED, FIXTURES, runEngineContract,
  type ContractHarness, type ContractSessionRow, type InjectKey, type RecordedCall,
} from './contract.ts'

/** One fake preset row. */
interface FakePresetRow {
  readonly id: string
  readonly isDefault: boolean
  readonly name?: string
  readonly broken?: string
}

function summaryOf(row: ContractSessionRow): SessionSummaryView {
  return {
    sessionId: SessionId(row.sessionId),
    updatedAt: 0,
    running: row.running ?? false,
    blank: row.blank ?? false,
    agentAvailable: true,
  }
}

function clientHarness(): ContractHarness {
  let rows: readonly ContractSessionRow[] = []
  let presets: readonly FakePresetRow[] = [{ ...FIXTURES.presetRow }]
  let missing = false
  const failures = new Map<InjectKey, string>()
  const calls: RecordedCall[] = []
  const listeners = new Set<() => void>()
  let byId: Record<string, { readonly blank: boolean; readonly running: boolean }> = {}

  const record = (
    method: InjectKey,
    args: readonly unknown[],
  ): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } | undefined => {
    calls.push({ method, args })
    const code = failures.get(method)
    if (code === undefined) return undefined
    failures.delete(method)
    return { ok: false, error: { code, message: `${method} failed (injected)` } }
  }
  const ok = <T>(value: T): ClientOutcome<T> => ({ ok: true, value })

  const remotePresets: ClientPresetRemote = {
    list: async () => record('presetsList', []) ?? ok({ presets: [...presets] }),
    read: async agentPreset => record('presetsRead', [agentPreset]) ?? ok(FIXTURES.presetDocument),
    select: async (agentId, agentPreset) => record('presetsSelect', [agentId, agentPreset]) ?? ok(agentPreset),
  }

  const remoteSession: ClientSessionRemote = {
    list: async request => record('list', [request]) ?? ok({ items: missing ? [] : rows.map(summaryOf) }),
    create: async request => record('create', [request]) ?? ok({ sessionId: CREATED, agentPreset: 'cadre-dev' }),
    rename: async request => record('rename', [request]) ?? ok({ title: '新标题', seq: 3 }),
    selectModel: async request => record('selectModel', [request])
      ?? ok({ selected: { provider: 'p-contract', model: 'm-contract' } }),
    modelCatalog: async () => record('modelCatalog', []) ?? ok(FIXTURES.catalog),
    projections: async (request) => {
      const failure = record('projections', [request])
      if (failure !== undefined) return failure
      const present = !missing && rows.some(row => row.sessionId === request.sessionId)
      return ok(present ? { kind: 'sequenced' as const, asOfSeq: 5, values: { agentPreset: 'cadre-dev' } } : null)
    },
    prompt: async request => record('prompt', [request]) ?? ok({ accepted: true as const }),
    cancel: async request => record('cancel', [request]) ?? ok({ accepted: true as const }),
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        for (const frame of FIXTURES.followFrames) yield frame
      },
    }),
  }

  const deps: ClientEngineDeps = {
    remote: { session: remoteSession, agentPresets: remotePresets },
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { ...byId } }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
  }
  return {
    port: createClientEnginePort(deps),
    calls,
    failNext: (method, code) => { failures.set(method, code) },
    seedSessions: (next) => {
      rows = next
      byId = {}
      for (const row of next) byId[row.sessionId] = { blank: row.blank ?? false, running: row.running ?? false }
    },
    seedMissingSession: () => { missing = true; rows = [] },
    seedPresets: (next) => { presets = next },
    touch: (sessionId) => {
      byId[sessionId] = { running: true, blank: false }
      for (const listener of [...listeners]) listener()
    },
    dispose: () => { listeners.clear() },
  }
}

runEngineContract(clientHarness)

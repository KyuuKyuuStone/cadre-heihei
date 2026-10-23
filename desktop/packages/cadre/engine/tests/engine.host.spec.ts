/**
 * Contract run for the Host binding, over fake official Host services
 * (sessionController, agentPresets, agents). No Cordis context is required.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionControlFrame, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHostEnginePort, type HostAgentRegistry, type HostEngineDeps, type HostPresetRegistry, type HostSessionController } from '../src/host/index.ts'
import type { SessionSummaryView } from '../src/types.ts'
import {
  CREATED, FIXTURES, runEngineContract,
  type ContractHarness, type ContractSessionRow, type InjectKey, type RecordedCall,
} from './contract.ts'

/** Official services report failures by throwing; this keeps the code inspectable. */
class InjectedFailure extends Error {
  readonly code: string

  constructor(code: string) {
    super(`${code} (injected)`)
    this.code = code
  }
}

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

function hostHarness(): ContractHarness {
  let rows: readonly ContractSessionRow[] = []
  let presets: readonly FakePresetRow[] = [{ ...FIXTURES.presetRow }]
  let missing = false
  const failures = new Map<InjectKey, string>()
  const calls: RecordedCall[] = []
  const pending: SessionId[] = []
  const wake: (() => void)[] = []

  const record = (method: InjectKey, args: readonly unknown[]): void => {
    calls.push({ method, args })
    const code = failures.get(method)
    if (code === undefined) return
    failures.delete(method)
    throw new InjectedFailure(code)
  }

  const controller: HostSessionController = {
    list: async (request) => {
      record('list', [request])
      return { items: missing ? [] : rows.map(summaryOf) }
    },
    create: async (request) => {
      record('create', [request])
      return { sessionId: CREATED, agentPreset: 'cadre-dev' }
    },
    rename: async (request) => {
      record('rename', [request])
      return { title: '新标题', seq: 3 }
    },
    selectModel: async (request) => {
      record('selectModel', [request])
      return { selected: { provider: 'p-contract', model: 'm-contract' } }
    },
    modelCatalog: async () => {
      record('modelCatalog', [])
      return FIXTURES.catalog
    },
    projections: async (request) => {
      record('projections', [request])
      const present = !missing && rows.some(row => row.sessionId === request.sessionId)
      return present ? { kind: 'sequenced', asOfSeq: 5, values: { agentPreset: 'cadre-dev' } } : null
    },
    prompt: async (request) => {
      record('prompt', [request])
      return { accepted: true }
    },
    cancel: (request) => {
      record('cancel', [request])
      return { accepted: true }
    },
    follow: (): AsyncIterable<SessionFollowFrame> => ({
      async *[Symbol.asyncIterator]() {
        for (const frame of FIXTURES.followFrames) yield frame
      },
    }),
    control: (signal): AsyncIterable<SessionControlFrame> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline', value: { projections: {} } }
        while (!signal.aborted) {
          if (pending.length === 0) {
            await new Promise<void>(resolve => wake.push(resolve))
            continue
          }
          const sessionId = pending.shift()
          if (sessionId === undefined) continue
          yield { type: 'projection', sessionId, key: 'running', value: true, seq: 1 }
        }
      },
    }),
  }

  const presetRegistry: HostPresetRegistry = {
    remoteExportList: async () => {
      record('presetsList', [])
      return { presets: [...presets] }
    },
    readDocument: async (agentPreset) => {
      record('presetsRead', [agentPreset])
      return FIXTURES.presetDocument
    },
    select: async (_agent, agentPreset) => {
      record('presetsSelect', [_agent, agentPreset])
      return agentPreset
    },
  }

  const agents: HostAgentRegistry = {
    get: () => ({} as Agent),
  }

  const deps: HostEngineDeps = { sessionController: controller, agentPresets: presetRegistry, agents }
  return {
    port: createHostEnginePort(deps),
    calls,
    failNext: (method, code) => { failures.set(method, code) },
    seedSessions: (next) => { rows = next },
    seedMissingSession: () => { missing = true; rows = [] },
    seedPresets: (next) => { presets = next },
    touch: (sessionId) => {
      pending.push(SessionId(sessionId))
      for (const resolve of wake.splice(0)) resolve()
    },
    dispose: () => {
      for (const resolve of wake.splice(0)) resolve()
    },
  }
}

runEngineContract(hostHarness)

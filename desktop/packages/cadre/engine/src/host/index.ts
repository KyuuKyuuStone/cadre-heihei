/**
 * Host binding: EnginePort over the official Host services a plugin already
 * holds (`ctx.sessionController`, `ctx.agentPresets`, `ctx.agents`).
 *
 * Host services report failures by throwing; this binding converts them once
 * and otherwise forwards the official result unchanged. It adds no retry,
 * cache, ordering, or filtering.
 *
 * @module @deepseek-ai/dsh-cadre-engine/host
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetDocument, AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {
  ModelCatalog, SessionCancelRequest, SessionCancelValue, SessionControlFrame, SessionCreateRequest,
  SessionCreateValue, SessionFollowFrame, SessionFollowRequest, SessionListRequest, SessionListValue,
  SessionProjectionsRequest, SessionProjectionsValue, SessionPromptRequest, SessionPromptValue,
  SessionRenameRequest, SessionRenameValue, SessionSelectModelRequest, SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { errorOf, failure } from '../errors.ts'
import type { EnginePort, Result, SessionState, TurnFrame } from '../types.ts'

/** SessionController service surface this port uses (official `@Remote` methods). */
export interface HostSessionController {
  list(request: SessionListRequest, signal?: AbortSignal): Promise<SessionListValue>
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
  rename(request: SessionRenameRequest): Promise<SessionRenameValue>
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue>
  modelCatalog(): Promise<ModelCatalog>
  projections(request: SessionProjectionsRequest, signal?: AbortSignal): Promise<SessionProjectionsValue>
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<SessionPromptValue>
  cancel(request: SessionCancelRequest): SessionCancelValue
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame>
}

/** agent-preset registry surface this port uses. */
export interface HostPresetRegistry {
  remoteExportList(): Promise<AgentPresetRoster>
  readDocument(agentPreset: string): Promise<AgentPresetDocument>
  select(agent: Agent, agentPreset: string): Promise<string>
}

/** Agent registry surface this port uses (identity lookup only). */
export interface HostAgentRegistry {
  get(id: SessionId): Agent | undefined
}

/** Host services the host binding consumes. */
export interface HostEngineDeps {
  readonly sessionController: HostSessionController
  readonly agentPresets: HostPresetRegistry
  readonly agents: HostAgentRegistry
}

/** Code reported when the Session has no live Agent to accept a preset. */
export const SESSION_NOT_AVAILABLE = 'OUR_SESSION_NOT_AVAILABLE'

/** Run one throwing official call and convert its failure once. */
async function attempt<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (cause) {
    return failure(errorOf(cause))
  }
}

/** Map one official follow frame to the port's normalized frame. */
function frameOf(frame: SessionFollowFrame): TurnFrame {
  switch (frame.type) {
    case 'snapshot':
      return { kind: 'opening', cursor: frame.cursor, header: frame.header, projections: frame.projections }
    case 'event':
      return { kind: 'event', seq: frame.event.seq, type: frame.event.type, data: frame.event.data }
    case 'assistant-stream':
      return { kind: 'assistant', frame: frame.frame }
    /* v8 ignore next -- closed official frame union. */
    default:
      throw new Error(`unknown follow frame: ${String((frame as { readonly type?: unknown }).type)}`)
  }
}

/** Iterate the official follow stream as normalized frames. */
async function* frames(stream: AsyncIterable<SessionFollowFrame>): AsyncGenerator<TurnFrame> {
  for await (const frame of stream) yield frameOf(frame)
}

/**
 * Create the EnginePort backed by official Host services.
 * @param deps - `ctx.sessionController`, `ctx.agentPresets`, and `ctx.agents`.
 * @returns the four-port engine adapter.
 */
export function createHostEnginePort(deps: HostEngineDeps): EnginePort {
  const { sessionController, agentPresets, agents } = deps
  return {
    models: {
      /** Official: `sessionController.modelCatalog` (Remote `session/modelCatalog`). */
      listModels: () => attempt(() => sessionController.modelCatalog()),
      /** Official: `sessionController.selectModel` (Remote `session/selectModel`). */
      selectModel: request => attempt(() => sessionController.selectModel({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })),
    },
    sessions: {
      /** Official: `sessionController.list` (Remote `session/list`). */
      listSessions: async (query) => {
        const listed = await attempt(() => sessionController.list(query?.cursor === undefined ? {} : { cursor: query.cursor }))
        return listed.ok ? { ok: true, value: listed.value.items } : listed
      },
      /** Official: `sessionController.create` (Remote `session/create`). */
      createSession: request => attempt(() => sessionController.create({
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      })),
      /** Official: `sessionController.rename` (Remote `session/rename`). */
      renameSession: (sessionId, title) => attempt(() => sessionController.rename({ sessionId, title })),
      /** Official: `sessionController.list` + `sessionController.projections`. */
      getSessionState: async (sessionId): Promise<Result<SessionState>> => {
        const listed = await attempt(() => sessionController.list({}))
        if (!listed.ok) return listed
        const projections = await attempt(() => sessionController.projections({ sessionId }))
        if (!projections.ok) return projections
        return {
          ok: true,
          value: {
            summary: listed.value.items.find(item => item.sessionId === sessionId),
            projections: projections.value,
          },
        }
      },
      /** Official: `sessionController.control` projection frames. */
      watchSessions: (listener) => {
        const controller = new AbortController()
        const run = async (): Promise<void> => {
          try {
            for await (const frame of sessionController.control(controller.signal)) {
              if (frame.type === 'baseline') {
                for (const sessionId of Object.keys(frame.value.projections)) listener({ sessionId: SessionId(sessionId) })
              } else {
                listener({ sessionId: frame.sessionId })
              }
            }
          } catch (cause) {
            // Aborting the control stream is the normal way to stop following the list.
            if (!controller.signal.aborted) throw cause
          }
        }
        void run()
        return () => { controller.abort() }
      },
    },
    presets: {
      /** Official: `agentPresets.remoteExportList` (Remote `agentPresets/list`). */
      listPresets: async () => {
        const listed = await attempt(() => agentPresets.remoteExportList())
        return listed.ok ? { ok: true, value: listed.value.presets } : listed
      },
      /** Official: `agentPresets.readDocument` (Remote `agentPresets/read`). */
      readPreset: presetId => attempt(() => agentPresets.readDocument(presetId)),
      /** Official: `agentPresets.select` (Remote `agentPresets/select`), by Session identity. */
      applyPreset: async (sessionId, presetId) => {
        const agent = agents.get(sessionId)
        if (agent === undefined) {
          return failure({
            code: SESSION_NOT_AVAILABLE,
            message: `Session ${sessionId} has no live Agent; a preset needs one to compose`,
          })
        }
        const selected = await attempt(() => agentPresets.select(agent, presetId))
        return selected.ok ? { ok: true, value: { agentPreset: selected.value } } : selected
      },
    },
    turns: {
      /** Official: `sessionController.prompt` (Remote `session/prompt`). */
      runTurn: request => attempt(() => sessionController.prompt({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        content: request.content,
        ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
      })),
      /** Official: `sessionController.cancel` (Remote `session/cancel`). */
      cancelTurn: (sessionId) => {
        try {
          return Promise.resolve<Result<SessionCancelValue>>({
            ok: true,
            value: sessionController.cancel({ sessionId }),
          })
        } catch (cause) {
          return Promise.resolve(failure(errorOf(cause)))
        }
      },
      /** Official: `sessionController.follow` (Remote `session/follow`). */
      followTurn: request => frames(sessionController.follow({
        address: { kind: 'session', sessionId: request.sessionId },
      }, request.signal)),
    },
  }
}

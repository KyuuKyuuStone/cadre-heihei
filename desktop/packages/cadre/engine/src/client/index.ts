/**
 * Client binding: EnginePort over the official Client Remote namespaces and the
 * official Client Session list store.
 *
 * The binding narrows the generated Remote surface to the official methods the
 * product layer uses, checks each Remote outcome once, and maps follow frames.
 * It adds no retry, cache, ordering, or filtering.
 *
 * @module @deepseek-ai/dsh-cadre-engine/client
 */
import type { AgentPresetDocument, AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {
  ModelCatalog, SessionCancelRequest, SessionCancelValue, SessionCreateRequest, SessionCreateValue,
  SessionFollowFrame, SessionFollowRequest, SessionListRequest, SessionListValue, SessionProjectionsRequest,
  SessionProjectionsValue, SessionPromptRequest, SessionPromptValue, SessionRenameRequest, SessionRenameValue,
  SessionSelectModelRequest, SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { errorOf, failure } from '../errors.ts'
import type { EnginePort, Result, SessionState, TurnFrame } from '../types.ts'

/** One Remote result, as the generated Client methods return it. */
export type ClientOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Generated `session` Remote namespace narrowed to the methods this port uses. */
export interface ClientSessionRemote {
  list(request: SessionListRequest, signal?: AbortSignal): Promise<ClientOutcome<SessionListValue>>
  create(request: SessionCreateRequest): Promise<ClientOutcome<SessionCreateValue>>
  rename(request: SessionRenameRequest): Promise<ClientOutcome<SessionRenameValue>>
  selectModel(request: SessionSelectModelRequest): Promise<ClientOutcome<SessionSelectModelValue>>
  modelCatalog(): Promise<ClientOutcome<ModelCatalog>>
  projections(request: SessionProjectionsRequest, signal?: AbortSignal): Promise<ClientOutcome<SessionProjectionsValue>>
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<ClientOutcome<SessionPromptValue>>
  cancel(request: SessionCancelRequest): Promise<ClientOutcome<SessionCancelValue>>
  /** The official generated method returns `RemoteStreamHandle`; only iteration and disposal are used. */
  follow(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<SessionFollowFrame> & { dispose?(): void }
}

/** Generated `agentPresets` Remote namespace narrowed to the methods this port uses. */
export interface ClientPresetRemote {
  list(): Promise<ClientOutcome<AgentPresetRoster>>
  read(agentPreset: string): Promise<ClientOutcome<AgentPresetDocument>>
  select(agentId: SessionId, agentPreset: string): Promise<ClientOutcome<string>>
}

/** One row of the official Client Session list snapshot that this port reads. */
export interface ClientSessionListRow {
  readonly running?: boolean
  readonly blank?: boolean
}

/** Official Client Session list snapshot, narrowed to the identity map. */
export interface ClientSessionListState {
  readonly byId: Readonly<Record<string, ClientSessionListRow | undefined>>
}

/** Services the client binding consumes (official Client Remote and Session store). */
export interface ClientEngineDeps {
  readonly remote: {
    readonly session: ClientSessionRemote
    readonly agentPresets: ClientPresetRemote
  }
  readonly sessions: {
    readonly list: {
      getSnapshot(): ClientSessionListState
      subscribe(listener: () => void): () => void
    }
  }
}

/** Await one Remote call and convert its outcome to a port result. */
async function call<T>(operation: () => Promise<ClientOutcome<T>>): Promise<Result<T>> {
  try {
    const outcome = await operation()
    return outcome.ok ? { ok: true, value: outcome.value } : failure(outcome.error)
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

/** Iterate the official stream and dispose the handle when iteration ends. */
async function* frames(stream: AsyncIterable<SessionFollowFrame> & { dispose?(): void }): AsyncGenerator<TurnFrame> {
  try {
    for await (const frame of stream) yield frameOf(frame)
  } finally {
    stream.dispose?.()
  }
}

/**
 * Create the EnginePort backed by the official Client Remote.
 * @param deps - official Client services (Remote namespaces and the Session list store).
 * @returns the four-port engine adapter.
 */
export function createClientEnginePort(deps: ClientEngineDeps): EnginePort {
  const { remote, sessions } = deps
  return {
    models: {
      /** Official: `session/modelCatalog`. */
      listModels: () => call(() => remote.session.modelCatalog()),
      /** Official: `session/selectModel`. */
      selectModel: request => call(() => remote.session.selectModel({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })),
    },
    sessions: {
      /** Official: `session/list`. */
      listSessions: async (query) => {
        const listed = await call(() => remote.session.list(query?.cursor === undefined ? {} : { cursor: query.cursor }))
        return listed.ok ? { ok: true, value: listed.value.items } : listed
      },
      /** Official: `session/create`. */
      createSession: request => call(() => remote.session.create({
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      })),
      /** Official: `session/rename`. */
      renameSession: (sessionId, title) => call(() => remote.session.rename({ sessionId, title })),
      /** Official: `session/list` + `session/projections`. */
      getSessionState: async (sessionId): Promise<Result<SessionState>> => {
        const listed = await call(() => remote.session.list({}))
        if (!listed.ok) return listed
        const projections = await call(() => remote.session.projections({ sessionId }))
        if (!projections.ok) return projections
        return {
          ok: true,
          value: {
            summary: listed.value.items.find(item => item.sessionId === sessionId),
            projections: projections.value,
          },
        }
      },
      /** Official: Client Session list store `ctx.sessions.list` (identity diff only). */
      watchSessions: (listener) => {
        let previous = sessions.list.getSnapshot()
        return sessions.list.subscribe(() => {
          const next = sessions.list.getSnapshot()
          for (const [sessionId, row] of Object.entries(next.byId)) {
            if (previous.byId[sessionId] !== row) listener({ sessionId: SessionId(sessionId) })
          }
          for (const sessionId of Object.keys(previous.byId)) {
            if (!(sessionId in next.byId)) listener({ sessionId: SessionId(sessionId) })
          }
          previous = next
        })
      },
    },
    presets: {
      /** Official: `agentPresets/list`. */
      listPresets: async () => {
        const listed = await call(() => remote.agentPresets.list())
        return listed.ok ? { ok: true, value: listed.value.presets } : listed
      },
      /** Official: `agentPresets/read`. */
      readPreset: presetId => call(() => remote.agentPresets.read(presetId)),
      /** Official: `agentPresets/select`. */
      applyPreset: async (sessionId, presetId) => {
        const selected = await call(() => remote.agentPresets.select(sessionId, presetId))
        return selected.ok ? { ok: true, value: { agentPreset: selected.value } } : selected
      },
    },
    turns: {
      /** Official: `session/prompt`. */
      runTurn: request => call(() => remote.session.prompt({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        content: request.content,
        ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
      })),
      /** Official: `session/cancel`. */
      cancelTurn: sessionId => call(() => remote.session.cancel({ sessionId })),
      /** Official: `session/follow`. */
      followTurn: request => frames(remote.session.follow({
        address: { kind: 'session', sessionId: request.sessionId },
      }, request.signal)),
    },
  }
}

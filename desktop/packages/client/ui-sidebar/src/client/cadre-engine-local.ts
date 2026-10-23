/**
 * Temporary local EnginePort binding for the sidebar (ADR-0023 §2.3).
 *
 * The shared Client binding (`@deepseek-ai/dsh-cadre-engine/client`) has no
 * client-module registration yet: importing the package leaves the browser
 * module table without an entry and the whole sidebar fails to activate.
 * This file binds only the four methods the sidebar calls, with the same
 * remote calls and failure normalization as the shared binding, so the shell
 * can boot tonight. Swap `index.ts` back to the package import once the
 * registration and module-table row land.
 */
import type { ClientEngineDeps, ClientOutcome } from '@deepseek-ai/dsh-cadre-engine/client'
import type { EngineError, EnginePort, Result } from '@deepseek-ai/dsh-cadre-engine/types'

/** Code reported when the call never reached an official surface. */
const TRANSPORT_ERROR_CODE = 'ENGINE_UNAVAILABLE'

/** @param cause - value thrown by the official service or transport. */
function errorOf(cause: unknown): EngineError {
  const code = typeof (cause as { readonly code?: unknown } | null)?.code === 'string'
    ? (cause as { readonly code: string }).code
    : TRANSPORT_ERROR_CODE
  const message = cause instanceof Error
    ? cause.message
    : typeof (cause as { readonly message?: unknown } | null)?.message === 'string'
      ? (cause as { readonly message: string }).message
      : String(cause)
  const field = typeof (cause as { readonly field?: unknown } | null)?.field === 'string'
    ? (cause as { readonly field: string }).field
    : undefined
  return { code, message, ...(field === undefined ? {} : { field }) }
}

/** Await one Remote call and convert its outcome to a port result. */
async function call<T>(operation: () => Promise<ClientOutcome<T>>): Promise<Result<T>> {
  try {
    const outcome = await operation()
    return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }
  } catch (cause) {
    return { ok: false, error: errorOf(cause) }
  }
}

/** The subset of the EnginePort the sidebar consumes. */
export type SidebarEnginePort = {
  readonly models: Pick<EnginePort['models'], 'listModels' | 'selectModel'>
  readonly presets: Pick<EnginePort['presets'], 'listPresets' | 'applyPreset'>
}

/**
 * Create the sidebar's EnginePort subset over the official Client Remote.
 * @param deps - official Client services (Remote namespaces and the Session list store).
 * @returns the model and preset ports.
 */
export function createClientEnginePort(deps: ClientEngineDeps): SidebarEnginePort {
  const { remote } = deps
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
    presets: {
      /** Official: `agentPresets/list`. */
      listPresets: async () => {
        const listed = await call(() => remote.agentPresets.list())
        return listed.ok ? { ok: true, value: listed.value.presets } : listed
      },
      /** Official: `agentPresets/select`. */
      applyPreset: async (sessionId, presetId) => {
        const selected = await call(() => remote.agentPresets.select(sessionId, presetId))
        return selected.ok ? { ok: true, value: { agentPreset: selected.value } } : selected
      },
    },
  }
}

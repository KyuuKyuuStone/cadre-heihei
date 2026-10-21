/** SessionPort 的 SessionRuntimeRegistry 适配（M4 §8.3）。 */
import type { EngineSession } from '../ports/engine.ts'
import type { SessionId } from '../collab/protocol/index.ts'
import type { IpcIdentity } from '../shared/ipc.ts'
import type { SessionRuntimeRegistry } from '../runtime/session-runtime-registry.ts'
import type { SessionPort } from './ipc-handlers.ts'

export interface RegistrySessionPortOptions {
  readonly registry: SessionRuntimeRegistry
  readonly workingDirectory: string
  readonly databasePath: string
}

export class RegistrySessionPort implements SessionPort {
  private readonly registry: SessionRuntimeRegistry
  private readonly workingDirectory: string
  private readonly databasePath: string

  constructor(options: RegistrySessionPortOptions) {
    this.registry = options.registry
    this.workingDirectory = options.workingDirectory
    this.databasePath = options.databasePath
  }

  /** 有 ready runtime 复用；failed 等状态不自动重建，交给显式 reconnect。 */
  async ensure(identity: IpcIdentity): Promise<EngineSession> {
    const runtime = this.registry.getRuntime(identity.sessionId as SessionId)
    if (runtime !== undefined) {
      if (runtime.state !== 'ready') {
        const error = new Error(`session runtime state=${runtime.state}`)
        ;(error as Error & { code?: string }).code = 'SESSION_STATE_NOT_READY'
        throw error
      }
      const existing = this.registry.getSession(identity.sessionId as SessionId)
      if (existing !== undefined) return existing
    }
    const handle = await this.registry.createSession({
      projectId: identity.projectId as never,
      sessionId: identity.sessionId as never,
      role: identity.role,
      workingDirectory: this.workingDirectory,
      databasePath: this.databasePath,
    })
    return handle.session
  }

  get(sessionId: SessionId): EngineSession | undefined {
    return this.registry.getSession(sessionId)
  }

  rebuild(sessionId: SessionId): Promise<EngineSession> {
    return this.registry.rebuildSession(sessionId, { force: true })
  }

  async reclaim(sessionId: SessionId): Promise<void> {
    await this.registry.reclaimSession(sessionId)
  }
}

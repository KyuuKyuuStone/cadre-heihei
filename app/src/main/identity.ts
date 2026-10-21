/**
 * 主进程窗口身份绑定（frontend/02 §4）。
 *
 * windowId → { projectId, sessionId, role } 在窗口创建时写入；
 * handler 只从这里取身份，renderer 传入的同名字段一律拒绝。
 */
import type { IpcIdentity } from '../shared/ipc.ts'

export interface IdentityBinding {
  bind(windowId: string, identity: IpcIdentity): void
  get(windowId: string): IpcIdentity | undefined
  unbind(windowId: string): boolean
  list(): ReadonlyArray<{ readonly windowId: string; readonly identity: IpcIdentity }>
}

export class InMemoryIdentityBinding implements IdentityBinding {
  private readonly bindings = new Map<string, IpcIdentity>()

  bind(windowId: string, identity: IpcIdentity): void {
    if (windowId.trim() === '') throw new Error('windowId must be non-empty')
    if (String(identity.projectId).trim() === '' || String(identity.sessionId).trim() === '') {
      throw new Error('identity projectId/sessionId must be non-empty')
    }
    if (identity.role !== 'supervisor' && identity.role !== 'worker') {
      throw new Error(`invalid role: ${String(identity.role)}`)
    }
    this.bindings.set(windowId, { ...identity })
  }

  get(windowId: string): IpcIdentity | undefined {
    const identity = this.bindings.get(windowId)
    return identity === undefined ? undefined : { ...identity }
  }

  unbind(windowId: string): boolean {
    return this.bindings.delete(windowId)
  }

  list(): ReadonlyArray<{ readonly windowId: string; readonly identity: IpcIdentity }> {
    return [...this.bindings.entries()].map(([windowId, identity]) => ({
      windowId,
      identity: { ...identity },
    }))
  }
}

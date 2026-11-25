/**
 * Turning a selection into mounted `mcp-client` child fibers: resolve secrets at
 * mount time, mount the delta, dispose what the step no longer wants.
 * @module
 */
import * as McpClientPlugin from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ConfigValue, McpServerManifest, McpServerOverrides, MountTarget, ResolvedServer } from './types.ts'

/** One mounted server: its config identity plus the fiber that owns disposal. */
interface MountRecord {
  readonly hash: string
  readonly fiber: { dispose(): unknown }
}

function resolveEnvReference(value: ConfigValue, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value === 'string') return value
  return env[value.fromEnv]
}

function resolveValues(
  values: Readonly<Record<string, ConfigValue>> | undefined,
  overrides: Readonly<Record<string, ConfigValue>> | undefined,
  env: NodeJS.ProcessEnv,
  serverId: string,
): Record<string, string> {
  const merged: Record<string, ConfigValue> = { ...values, ...overrides }
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(merged)) {
    const literal = resolveEnvReference(value, env)
    // An unset variable is dropped rather than mounted empty: an empty token would
    // authenticate nothing and hide the misconfiguration.
    if (literal === undefined) {
      console.error(`host-mcp-manager: ${serverId} 的 ${name} 引用的环境变量未设置，已跳过`)
      continue
    }
    resolved[name] = literal
  }
  return resolved
}

/**
 * Build the `mcp-client` config for one selected server.
 * @param manifest - catalog entry being mounted.
 * @param overrides - session overrides already restricted to the allowlist.
 * @param env - host environment the references resolve against.
 * @returns the client config plus the identity hash used to skip remounts.
 */
export function resolveServer(
  manifest: McpServerManifest,
  overrides: McpServerOverrides | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedServer {
  const toolCallTimeoutMs = overrides?.toolCallTimeoutMs ?? manifest.toolCallTimeoutMs ?? 60_000
  const reconnect = manifest.reconnect
  const config: McpClientConfig = manifest.transport === 'stdio'
    ? {
      transport: 'stdio',
      serverName: manifest.id,
      command: manifest.command ?? '',
      args: [...(manifest.args ?? [])],
      env: resolveValues(manifest.env, overrides?.env, env, manifest.id),
      cwd: '',
      toolCallTimeoutMs,
      // A broken server must not abort the step that mounts it.
      failOnStartupError: false,
      ...(reconnect === undefined ? {} : { reconnect }),
    }
    : {
      transport: 'streamable-http',
      serverName: manifest.id,
      url: manifest.url ?? '',
      headers: resolveValues(manifest.headers, overrides?.env, env, manifest.id),
      toolCallTimeoutMs,
      failOnStartupError: false,
      ...(reconnect === undefined ? {} : { reconnect }),
    }
  // Resolved references are part of the identity: repointing one remounts, keeping
  // the list and its token prefix stable when nothing changed.
  return { id: manifest.id, hash: JSON.stringify(config), config }
}

/**
 * Owns the child fibers a set of agents currently holds.
 *
 * Mounts are per agent scope, so one session's servers never appear in another's
 * tool list. Disposal runs in a safe order: dispose the removed fiber before
 * mounting its replacement, matching `mcp-client`'s own generation swap.
 */
export class SelectionMounter {
  readonly #byAgent = new Map<string, Map<string, MountRecord>>()

  /**
   * Converge one agent's mounts onto `desired`.
   * @param agentKey - stable agent identity (`agent.id`).
   * @param target - the agent context that receives child fibers.
   * @param desired - servers this step resolved from the selection.
   */
  async reconcile(agentKey: string, target: MountTarget, desired: readonly ResolvedServer[]): Promise<void> {
    const current = this.#byAgent.get(agentKey) ?? new Map<string, MountRecord>()
    const wanted = new Map(desired.map(item => [item.id, item]))
    for (const [id, record] of [...current]) {
      const next = wanted.get(id)
      if (next !== undefined && next.hash === record.hash) continue
      current.delete(id)
      await record.fiber.dispose()
    }
    for (const item of desired) {
      if (current.has(item.id)) continue
      const fiber = target.plugin(McpClientPlugin, item.config)
      if (fiber === undefined) continue
      current.set(item.id, { hash: item.hash, fiber })
    }
    if (current.size === 0) this.#byAgent.delete(agentKey)
    else this.#byAgent.set(agentKey, current)
  }

  /**
   * @param agentKey - agent whose mounts to drop.
   * @returns the ids that were mounted, for tests and diagnostics.
   */
  mountedIds(agentKey: string): readonly string[] {
    return [...(this.#byAgent.get(agentKey)?.keys() ?? [])]
  }

  /**
   * Dispose every child fiber this agent still holds.
   * @param agentKey - agent whose mounts to dispose.
   */
  async release(agentKey: string): Promise<void> {
    const current = this.#byAgent.get(agentKey)
    if (current === undefined) return
    this.#byAgent.delete(agentKey)
    for (const record of current.values()) await record.fiber.dispose()
  }

  /** Dispose every child fiber, on plugin teardown. */
  async disposeAll(): Promise<void> {
    for (const agentKey of [...this.#byAgent.keys()]) await this.release(agentKey)
  }
}

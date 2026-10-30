/**
 * Supervisor write guard: only `.md`/`.txt` under the project workspace and
 * the project report directory. Workers and ordinary sessions are untouched.
 * @module @deepseek-ai/dsh-host-write-guard
 */
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { evaluatePolicy, parsePolicy, type WritePolicy } from './policy.ts'

export interface Config {
  /** Override the bundled policy file. */
  readonly policyPath?: string
  /** Disable the guard without removing the row. */
  readonly enabled?: boolean
}

interface AgentLike { readonly id: string }
interface HostContext {
  on(event: string, handler: (payload: never, next: () => Promise<unknown>) => unknown, options?: { prepend?: boolean }): () => void
  effect(setup: () => () => void): void
}

interface MemberRow { readonly projectId: string; readonly role: string; readonly state: string }
interface ProjectRow { readonly rootPath: string }

interface CachedPolicy { readonly stamp: string; readonly policy?: WritePolicy; readonly error?: string }

/** Validate/load the policy and cache it by mtime+size for hot reload. */
function readPolicy(path: string, previous?: CachedPolicy): CachedPolicy {
  try {
    const stat = statSync(path)
    const stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`
    if (previous?.stamp === stamp) return previous
    const policy = parsePolicy(JSON.parse(readFileSync(path, 'utf8')))
    return { stamp, policy }
  } catch (error) {
    return { stamp: `error:${Date.now()}`, error: error instanceof Error ? error.message : String(error) }
  }
}

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return resolve(realpathSync.native(dirname(path)), basename(path))
    } catch {
      return resolve(path)
    }
  }
}

/**
 * Register the supervisor-only write guard on `tools/pre-execute`.
 * @param ctx - Host context exposing the tool pipeline.
 * @param config - optional policy path or disable switch.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const ledgerPath = process.env.CADRE_LEDGER_PATH?.trim()
  if (ledgerPath === undefined || ledgerPath === '') {
    console.error('host-write-guard: CADRE_LEDGER_PATH is unset; write guard is not registered')
    return
  }
  const policyPath = config.policyPath
    ?? process.env.CADRE_WRITE_POLICY?.trim()
    ?? fileURLToPath(new URL('../policies/write-policy.json', import.meta.url))
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  let cached: CachedPolicy | undefined
  const auditLog = `${ledgerPath}.write-guard.log`

  const member = (sessionId: string): MemberRow | undefined => {
    try {
      const row = db.prepare(`SELECT project_id, role, state FROM members WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as { project_id?: unknown; role?: unknown; state?: unknown } | undefined
      if (row === undefined) return undefined
      return { projectId: String(row.project_id), role: String(row.role), state: String(row.state) }
    } catch {
      return undefined
    }
  }
  const project = (projectId: string): ProjectRow | undefined => {
    try {
      const row = db.prepare(`SELECT root_path FROM projects WHERE project_id = ?`)
        .get(projectId) as { root_path?: unknown } | undefined
      if (typeof row?.root_path !== 'string' || row.root_path === '') return undefined
      return { rootPath: row.root_path }
    } catch {
      return undefined
    }
  }
  const audit = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(auditLog, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`)
    } catch (error) {
      console.error(`host-write-guard: audit write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const listener = async (payload: {
    readonly name: string
    readonly arguments: unknown
    readonly agent?: AgentLike
  }, next: () => Promise<unknown>): Promise<unknown> => {
    const sessionId = payload.agent?.id
    if (sessionId === undefined) return next()
    const who = member(sessionId)
    // The guard owns supervisor writes only; workers/ordinary sessions delegate
    // to their existing tool masks and sandbox policy.
    if (who === undefined || who.role !== 'supervisor' || who.state === 'departed') return next()

    cached = readPolicy(policyPath, cached)
    if (cached.policy === undefined) {
      audit({ actor: sessionId, project: who.projectId, role: who.role, tool: payload.name, decision: 'deny', code: 'WRITE_POLICY_UNAVAILABLE', error: cached.error })
      return {
        kind: 'deny',
        reason: `WRITE_POLICY_UNAVAILABLE: 写策略不可用（${cached.error ?? 'unknown'}）`,
        info: { name: 'cadre-write-guard', code: 'WRITE_POLICY_UNAVAILABLE', reason: cached.error },
      }
    }
    const projectRow = project(who.projectId)
    if (projectRow === undefined) {
      audit({ actor: sessionId, project: who.projectId, role: who.role, tool: payload.name, decision: 'deny', code: 'WRITE_POLICY_UNAVAILABLE', error: 'project root missing' })
      return {
        kind: 'deny',
        reason: 'WRITE_POLICY_UNAVAILABLE: 项目根目录未登记',
        info: { name: 'cadre-write-guard', code: 'WRITE_POLICY_UNAVAILABLE' },
      }
    }
    const args = typeof payload.arguments === 'object' && payload.arguments !== null
      ? payload.arguments as Record<string, unknown>
      : {}
    const decision = evaluatePolicy(cached.policy, {
      tool: payload.name,
      args,
      projectRoot: projectRow.rootPath,
    }, real)
    audit({
      actor: sessionId, project: who.projectId, role: who.role, tool: payload.name,
      path: typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined,
      normalizedPath: decision.path, rule: decision.rule,
      decision: decision.allow ? 'allow' : 'deny',
      ...(decision.allow ? {} : { code: decision.code }),
    })
    if (decision.allow) return next()
    return {
      kind: 'deny',
      reason: `${decision.code}: ${decision.message}`,
      info: { name: 'cadre-write-guard', code: decision.code, reason: decision.message },
    }
  }

  ctx.on('tools/pre-execute', listener as never, { prepend: true })
  ctx.effect(() => () => { db.close() })
}

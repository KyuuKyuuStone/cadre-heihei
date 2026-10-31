/**
 * Supervisor write guard: only `.md`/`.txt` under the project workspace and
 * the project report directory. Workers and ordinary sessions are untouched.
 * @module @deepseek-ai/dsh-host-write-guard
 */
import { appendFileSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { evaluatePolicy, parsePolicy, type WritePolicy } from './policy.ts'

export interface Config {
  /** Override the bundled policy file. */
  readonly policyPath?: string
  /** Disable the guard without removing the row. */
  readonly enabled?: boolean
  /** Workspace fallback when the project has no ledger row. */
  readonly workspaceRoot?: string
  /** Additional report directory, absolute or relative to the resolved root. */
  readonly reportsDir?: string
}

interface AgentLike { readonly id: string }
interface HostContext {
  on(event: string, handler: (payload: never, next: () => Promise<unknown>) => unknown, options?: { prepend?: boolean }): () => void
  effect(setup: () => () => void): void
  readonly sessions?: { get(id: string): { readonly header: { readonly cwd?: string } } | undefined }
}

interface MemberRow { readonly projectId: string; readonly role: string; readonly state: string }
interface ProjectRow { readonly rootPath: string }

interface CachedPolicy { readonly stamp: string; readonly policy?: WritePolicy; readonly error?: string }

const BUILTIN_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const OFFICE_PREFIXES = ['office_', 'docx_', 'xlsx_', 'pptx_'] as const
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Classify a tool before any project/policy lookup so non-write tools never fail closed. */
function builtinClass(tool: string): 'write' | 'office' | 'shell' | 'other' {
  if (SHELL_TOOLS.has(tool)) return 'shell'
  if (BUILTIN_WRITE_TOOLS.has(tool) || OFFICE_PREFIXES.some(prefix => tool.startsWith(prefix))) {
    return OFFICE_PREFIXES.some(prefix => tool.startsWith(prefix)) ? 'office' : 'write'
  }
  return 'other'
}

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

  const sessionRoot = (sessionId: string): string | undefined => {
    try {
      return ctx.sessions?.get(sessionId)?.header.cwd
    } catch {
      return undefined
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

    const deny = (code: string, message: string, rule: string): unknown => {
      audit({
        actor: sessionId, project: who.projectId, role: who.role, tool: payload.name,
        decision: 'deny', code, rule,
      })
      return {
        kind: 'deny',
        reason: `${code}: ${message}`,
        info: { name: 'cadre-write-guard', code, reason: message },
      }
    }

    // Classify before any project/policy lookup: read, dispatch_task, list_tasks,
    // and every other non-write tool must pass even when no root is registered.
    const builtin = builtinClass(payload.name)
    cached = readPolicy(policyPath, cached)
    const policy = cached.policy
    const policyDeny = policy === undefined
      ? undefined
      : policy.denyTools[payload.name]
        ?? policy.denyToolPrefixes.find(prefix => payload.name.startsWith(prefix))
    if (builtin === 'office' || policyDeny === 'office') {
      return deny('WRITE_OFFICE_DENIED', '主管不能写 Office 文件；请派员工产出后验收', 'deny:office')
    }
    if (builtin === 'shell' || policyDeny === 'shell') {
      return deny('WRITE_SHELL_DENIED', '主管不能执行 shell；请用 read/grep 只读诊断或派员工', 'deny:shell')
    }
    const policyWrite = policy?.writeTools[payload.name] !== undefined
    if (builtin !== 'write' && !policyWrite) return next()

    if (policy === undefined) {
      audit({ actor: sessionId, project: who.projectId, role: who.role, tool: payload.name, decision: 'deny', code: 'WRITE_POLICY_UNAVAILABLE', error: cached.error })
      return {
        kind: 'deny',
        reason: `WRITE_POLICY_UNAVAILABLE: 写策略不可用（${cached.error ?? 'unknown'}）`,
        info: { name: 'cadre-write-guard', code: 'WRITE_POLICY_UNAVAILABLE', reason: cached.error },
      }
    }
    const root = project(who.projectId)?.rootPath
      ?? sessionRoot(sessionId)
      ?? config.workspaceRoot
      ?? (config.reportsDir !== undefined && isAbsolute(config.reportsDir) ? dirname(config.reportsDir) : undefined)
    if (root === undefined || root === '') {
      return deny('WRITE_POLICY_UNAVAILABLE', '项目根目录/工作区未登记', 'root-missing')
    }
    const reportsRoot = config.reportsDir === undefined
      ? undefined
      : isAbsolute(config.reportsDir) ? config.reportsDir : resolve(root, config.reportsDir)
    const args = typeof payload.arguments === 'object' && payload.arguments !== null
      ? payload.arguments as Record<string, unknown>
      : {}
    const decision = evaluatePolicy(policy, {
      tool: payload.name,
      args,
      projectRoot: root,
      ...(reportsRoot === undefined ? {} : { extraRoots: [reportsRoot] }),
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

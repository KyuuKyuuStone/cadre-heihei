/**
 * Data-driven write policy for the supervisor guard.
 *
 * The policy decides tool classes (allow-listed extensions, Office/shell deny)
 * and path containment. IO, roster lookup, and auditing stay in the plugin.
 * @module
 */
import { isAbsolute, join, relative } from 'node:path'

/** One write tool's argument mapping. */
export interface WriteToolAdapter {
  /** Primary argument holding the output path. */
  readonly path: string
  /** Additional argument names accepted when the primary is absent. */
  readonly altPaths?: readonly string[]
}

/** Persisted policy document. */
export interface WritePolicy {
  readonly version: number
  readonly roles: readonly string[]
  /** Root aliases: `project` is the project workspace, `reports` its report directory. */
  readonly roots: readonly string[]
  readonly reportDirName: string
  readonly allowExtensions: readonly string[]
  readonly writeTools: Readonly<Record<string, WriteToolAdapter>>
  readonly denyTools: Readonly<Record<string, string>>
  readonly denyToolPrefixes: readonly string[]
  readonly extraRoots?: readonly string[]
}

/** Input one tool call presents to the policy. */
export interface GuardInput {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly projectRoot: string
  readonly extraRoots?: readonly string[]
}

/** Result of one policy decision. */
export type GuardDecision =
  | { readonly allow: true; readonly path?: string; readonly rule: string }
  | { readonly allow: false; readonly code: string; readonly message: string; readonly path?: string; readonly rule: string }

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`write-policy: ${name} must be an array of strings`)
  }
  return value
}

/**
 * Validate a parsed policy document.
 * @param value - untrusted JSON.
 * @returns the validated policy.
 */
export function parsePolicy(value: unknown): WritePolicy {
  if (typeof value !== 'object' || value === null) throw new Error('write-policy: root must be an object')
  const source = value as Record<string, unknown>
  if (source.version !== 1) throw new Error('write-policy: unsupported version')
  if (typeof source.reportDirName !== 'string' || source.reportDirName.trim() === '') {
    throw new Error('write-policy: reportDirName must be a non-empty string')
  }
  if (typeof source.writeTools !== 'object' || source.writeTools === null) {
    throw new Error('write-policy: writeTools must be an object')
  }
  if (typeof source.denyTools !== 'object' || source.denyTools === null) {
    throw new Error('write-policy: denyTools must be an object')
  }
  const writeTools: Record<string, WriteToolAdapter> = {}
  for (const [tool, adapter] of Object.entries(source.writeTools)) {
    if (typeof adapter !== 'object' || adapter === null) throw new Error(`write-policy: writeTools.${tool} must be an object`)
    const entry = adapter as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path === '') throw new Error(`write-policy: writeTools.${tool}.path must be a non-empty string`)
    const alt = entry.altPaths === undefined ? [] : stringArray(entry.altPaths, `writeTools.${tool}.altPaths`)
    writeTools[tool] = { path: entry.path, ...(alt.length === 0 ? {} : { altPaths: alt }) }
  }
  const denyTools: Record<string, string> = {}
  for (const [tool, kind] of Object.entries(source.denyTools)) {
    if (typeof kind !== 'string') throw new Error(`write-policy: denyTools.${tool} must be a string`)
    denyTools[tool] = kind
  }
  const roots = stringArray(source.roots, 'roots')
  if (roots.length === 0 || roots.some(root => root !== 'project' && root !== 'reports')) {
    throw new Error('write-policy: roots may only contain "project" and "reports"')
  }
  const allowExtensions = stringArray(source.allowExtensions, 'allowExtensions').map(extension => extension.toLowerCase())
  if (allowExtensions.length === 0 || allowExtensions.some(extension => !extension.startsWith('.'))) {
    throw new Error('write-policy: allowExtensions must be dot-prefixed')
  }
  return {
    version: 1,
    roles: stringArray(source.roles, 'roles'),
    roots,
    reportDirName: source.reportDirName,
    allowExtensions,
    writeTools,
    denyTools,
    denyToolPrefixes: stringArray(source.denyToolPrefixes ?? [], 'denyToolPrefixes'),
    ...(source.extraRoots === undefined ? {} : { extraRoots: stringArray(source.extraRoots, 'extraRoots') }),
  }
}

function pathArgument(adapter: WriteToolAdapter, args: Record<string, unknown>): string | undefined {
  const direct = args[adapter.path]
  if (typeof direct === 'string' && direct.trim() !== '') return direct
  for (const alt of adapter.altPaths ?? []) {
    const value = args[alt]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Evaluate one supervisor tool call.
 * @param policy - validated policy.
 * @param input - tool name, arguments, and the project root.
 * @param resolve - real-path resolver (symlinks and `..` already normalized).
 * @returns allow (with rule) or a stable denial code.
 */
export function evaluatePolicy(
  policy: WritePolicy,
  input: GuardInput,
  resolve: (path: string) => string,
): GuardDecision {
  const prefixDenied = policy.denyToolPrefixes.some(prefix => input.tool.startsWith(prefix))
  const denyKind = policy.denyTools[input.tool] ?? (prefixDenied ? 'office' : undefined)
  if (denyKind !== undefined) {
    const office = denyKind === 'office'
    return {
      allow: false,
      code: office ? 'WRITE_OFFICE_DENIED' : 'WRITE_SHELL_DENIED',
      message: office
        ? '主管不能写 Office 文件；请派员工产出后验收'
        : '主管不能执行 shell；请用 read/grep 只读诊断或派员工',
      rule: `deny:${denyKind}`,
    }
  }
  const adapter = policy.writeTools[input.tool]
  if (adapter === undefined) return { allow: true, rule: 'not-a-write-tool' }
  const raw = pathArgument(adapter, input.args)
  if (raw === undefined) {
    return { allow: false, code: 'WRITE_POLICY_TOOL_UNSUPPORTED', message: `工具 ${input.tool} 缺少路径参数`, rule: 'path-missing' }
  }
  const candidate = resolve(raw)
  const roots = [
    ...policy.roots.map(root => root === 'project' ? input.projectRoot : joinRoot(input.projectRoot, policy.reportDirName)),
    ...(policy.extraRoots ?? []),
    ...(input.extraRoots ?? []),
  ].map(resolve)
  if (!roots.some(root => inside(root, candidate))) {
    return { allow: false, code: 'WRITE_PATH_DENIED', message: `路径不在允许范围：${candidate}`, path: candidate, rule: 'path-outside-roots' }
  }
  const lower = candidate.toLowerCase()
  if (!policy.allowExtensions.some(extension => lower.endsWith(extension))) {
    return {
      allow: false,
      code: 'WRITE_EXTENSION_DENIED',
      message: `主管只允许写 ${policy.allowExtensions.join('/')}：${candidate}`,
      path: candidate,
      rule: 'extension',
    }
  }
  return { allow: true, path: candidate, rule: 'allowed' }
}

/** Join a project-relative directory without platform-specific imports. */
function joinRoot(root: string, child: string): string {
  return join(root, child)
}

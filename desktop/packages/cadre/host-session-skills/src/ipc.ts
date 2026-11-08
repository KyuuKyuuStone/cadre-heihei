/**
 * Supervisor-only data operations behind the future skill settings UI.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { loadSkillCatalog, localizedDescription, type SkillOrigin, type SkillPack } from './catalog.ts'

/** IPC failure with an HTTP status and stable code. */
export class SkillIpcError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
  }
}

interface MemberRow {
  readonly role: string
  readonly state: string
  readonly skills: readonly string[]
}

/** Catalog entry safe for the UI; SKILL.md body stays out of the list. */
export interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly author?: string
  readonly homepage?: string
  readonly origin: SkillOrigin
  readonly roles: readonly string[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly selected: boolean
}

/** Non-blocking provenance warnings returned with a successful install. */
export type InstallWarning = 'missing-license' | 'missing-hash' | 'unknown-source'

/** Collect provenance gaps; these require supervisor confirmation, never a silent install. */
export function installWarnings(pack: {
  readonly license?: string
  readonly author?: string
  readonly source?: string
}, options: { readonly hasHash?: boolean } = {}): InstallWarning[] {
  const warnings: InstallWarning[] = []
  if (pack.license === undefined || pack.license.trim() === '' || pack.license === 'unknown') {
    warnings.push('missing-license')
  }
  if (options.hasHash !== true) warnings.push('missing-hash')
  if (pack.author === undefined || pack.author.trim() === ''
    || pack.source === undefined || pack.source.trim() === '' || pack.source === 'unknown') {
    warnings.push('unknown-source')
  }
  return warnings
}

/** Preview shown with a confirmation request. */
export interface InstallPreview {
  readonly name: string
  readonly source: string
  readonly license: string
  readonly author?: string
  readonly hasHash: boolean
}

/** Pending install result that installs nothing until a supervisor confirms. */
export interface InstallConfirmation {
  readonly requiresConfirmation: true
  readonly installed: false
  readonly warnings: readonly InstallWarning[]
  readonly preview: InstallPreview
}

export interface SkillApi {
  catalog(input: { projectId: string; actorSessionId: string; targetSessionId?: string; locale?: string }): CatalogEntry[]
  get(input: { projectId: string; actorSessionId: string; targetSessionId: string }): { skills: string[] }
  set(input: { projectId: string; actorSessionId: string; targetSessionId: string; skills: unknown }): { skills: string[] }
  /** Supervisor-only guard used by the admin conversation and diagnostics. */
  assertSupervisor(input: { projectId: string; actorSessionId: string }): void
  /** Require an existing project the calling session does not belong to another project of. */
  assertMember(input: { projectId: string; actorSessionId: string }): void
  preview(input: { projectId: string; actorSessionId: string; packId: string }): {
    id: string; content: string; tokenEstimate: number; license: string
    author?: string; homepage?: string
  }
  add(input: AddSkillInput): CatalogEntry
  inspectUrl(input: {
    projectId: string; actorSessionId: string; url: unknown
  }): Promise<RemotePack>
  remove(input: { projectId: string; actorSessionId: string; packId: string; confirm: unknown }): { removed: true }
  installUrl(input: {
    projectId: string; actorSessionId: string; url: unknown; confirm?: unknown
  }): Promise<CatalogEntry | InstallConfirmation>
  installPackage(input: {
    projectId: string; actorSessionId: string; name: unknown; confirm?: unknown
  }): Promise<{
    name: string; visible: boolean; durationMs: number; installed: true; warnings: InstallWarning[]
  } | InstallConfirmation>
  installAny(input: {
    projectId: string; actorSessionId: string; text: unknown; confirm?: unknown
  }): Promise<
    | {
      kind: 'package'; target: string; installed: true; warnings: InstallWarning[]
      result: { name: string; visible: boolean; durationMs: number; installed: true; warnings: InstallWarning[] }
    }
    | { kind: 'url'; target: string; installed: true; warnings: InstallWarning[]; result: CatalogEntry }
    | (InstallConfirmation & { kind: 'package' | 'url'; target: string })
  >
}

export interface AddSkillInput {
  readonly projectId: string
  readonly actorSessionId: string
  readonly id: unknown
  readonly name: unknown
  readonly description: unknown
  readonly author?: unknown
  readonly homepage?: unknown
  readonly roles: unknown
  readonly tokenEstimate: unknown
  readonly tools: unknown
  readonly source: unknown
  readonly license: unknown
  readonly descriptionI18n?: unknown
  readonly content: unknown
  readonly overwrite?: unknown
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9](?:[a-z0-9._-]{0,63})\/)?[a-z0-9](?:[a-z0-9._-]{0,63})$/u
const SCOPED_PACKAGE = /(^|[^A-Za-z0-9._\/@-])(@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63})(?![A-Za-z0-9._\/@-])/gi
const KEBAB_PACKAGE = /(^|[^A-Za-z0-9._\/@-])([a-z0-9]+(?:-[a-z0-9]+)+)(?![A-Za-z0-9._\/@-])/gi
const URL_TOKEN = /https?:\/\/[^\s，。；、）)】"'<>]+/giu
const ROLES = new Set(['supervisor', 'worker'])

/** Trim sentence punctuation that commonly follows a pasted URL. */
function trimUrl(value: string): string {
  return value.replace(/[.,;:!?、，。；：！？]+$/u, '')
}

/** Whether a URL is SkillHub's install instruction page. */
function isInstructionUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.hostname === 'skillhub.cn' || url.hostname.endsWith('.skillhub.cn'))
      && url.pathname === '/install/skillhub.md'
  } catch {
    return false
  }
}

/** Extract one unambiguous package or URL target from free text. */
function parseInstallInstruction(text: string): { kind: 'package'; target: string } | { kind: 'url'; target: string } {
  const urls = [...new Set([...text.matchAll(URL_TOKEN)].map(match => trimUrl(match[0])))]
  const withoutUrls = text.replace(URL_TOKEN, ' ')
  const packages = new Set<string>()
  for (const match of withoutUrls.matchAll(SCOPED_PACKAGE)) packages.add(match[2]!)
  for (const match of withoutUrls.matchAll(KEBAB_PACKAGE)) packages.add(match[2]!)
  const validPackages = [...packages].filter(name => name.length <= 128 && PACKAGE_NAME.test(name))
  if (validPackages.length > 1 || urls.length > 1) {
    throw new SkillIpcError('SKILL_INSTRUCTION_UNSUPPORTED', 400,
      '输入里有多个安装候选，无法安全判断；请把具体包名或 URL 交给技能管理员')
  }
  if (validPackages.length === 1) {
    if (urls.length === 0 || (urls.length === 1 && isInstructionUrl(urls[0]!))) {
      return { kind: 'package', target: validPackages[0]! }
    }
    throw new SkillIpcError('SKILL_INSTRUCTION_UNSUPPORTED', 400,
      '输入同时包含包名和未知 URL，无法安全判断；请把具体包名或 URL 交给技能管理员')
  }
  if (urls.length === 1) return { kind: 'url', target: urls[0]! }
  throw new SkillIpcError('SKILL_INSTRUCTION_UNSUPPORTED', 400,
    '无法从输入判断安装目标；请把具体包名或 URL 交给技能管理员')
}

/** Result of one WSL SkillHub CLI invocation. */
export interface PackageCommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  readonly error?: string
}

export interface ValidPack {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly author?: string
  readonly homepage?: string
  readonly roles: readonly ('supervisor' | 'worker')[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly descriptionI18n?: { readonly zh?: string; readonly en?: string }
  readonly content: string
}

/** Validated remote pack returned by URL inspection without writing. */
export interface RemotePack {
  readonly pack: ValidPack
  readonly contentHash: string
  readonly manifestHash: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new SkillIpcError('SKILL_INVALID', 400, `${field} 必填`)
  return value
}

function validI18n(value: unknown): { zh?: string; en?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const result: { zh?: string; en?: string } = {}
  if (typeof record.zh === 'string' && record.zh.trim() !== '') result.zh = record.zh
  if (typeof record.en === 'string' && record.en.trim() !== '') result.en = record.en
  return result.zh === undefined && result.en === undefined ? undefined : result
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new SkillIpcError('SKILL_INVALID', 400, `${field} 必须是非空字符串`)
  return value.trim()
}

function optionalHttps(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field)
  if (text === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new SkillIpcError('SKILL_INVALID', 400, `${field} 必须是 https URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new SkillIpcError('SKILL_INVALID', 400, `${field} 必须是无凭据的 https URL`)
  }
  return text
}

function validatePack(input: AddSkillInput): ValidPack {
  const id = requiredString(input.id, 'id')
  if (!KEBAB_ID.test(id) || id.length > 64) {
    throw new SkillIpcError('SKILL_INVALID', 400, 'id 必须是 1-64 位 kebab-case（a-z0-9-）')
  }
  const roles = Array.isArray(input.roles) ? input.roles : []
  if (roles.length === 0 || roles.some(role => typeof role !== 'string' || !ROLES.has(role))) {
    throw new SkillIpcError('SKILL_INVALID', 400, 'roles 必须包含 supervisor/worker')
  }
  if (!Array.isArray(input.tools) || input.tools.some(tool => typeof tool !== 'string')) {
    throw new SkillIpcError('SKILL_INVALID', 400, 'tools 必须是字符串数组')
  }
  const tokenEstimate = input.tokenEstimate
  if (typeof tokenEstimate !== 'number' || !Number.isFinite(tokenEstimate) || tokenEstimate < 0) {
    throw new SkillIpcError('SKILL_INVALID', 400, 'tokenEstimate 必须是非负数')
  }
  const content = requiredString(input.content, 'content')
  const i18n = validI18n(input.descriptionI18n)
  const author = optionalText(input.author, 'author')
  const homepage = optionalHttps(input.homepage, 'homepage')
  return {
    id,
    name: requiredString(input.name, 'name'),
    description: requiredString(input.description, 'description'),
    ...(i18n === undefined ? {} : { descriptionI18n: i18n }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    roles: [...new Set(roles)] as ('supervisor' | 'worker')[],
    tokenEstimate,
    tools: [...new Set(input.tools as string[])],
    source: requiredString(input.source, 'source'),
    license: requiredString(input.license, 'license'),
    content,
  }
}

function entryOf(pack: SkillPack, selected = false, locale?: string): CatalogEntry {
  return {
    id: pack.id, name: pack.name, description: localizedDescription(pack, locale), origin: pack.origin, roles: pack.roles,
    tokenEstimate: pack.tokenEstimate, tools: pack.tools, source: pack.source, license: pack.license, selected,
    ...(pack.author === undefined ? {} : { author: pack.author }),
    ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
  }
}

function parseSkills(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function isMissingSkillsColumn(error: unknown): boolean {
  return error instanceof Error && /no such column:\s*skills_json/iu.test(error.message)
}

function readMember(db: DatabaseSync, projectId: string, sessionId: string): MemberRow | undefined {
  try {
    const row = db.prepare('SELECT role, state, skills_json FROM members WHERE project_id = ? AND session_id = ? LIMIT 1')
      .get(projectId, sessionId) as { role?: unknown; state?: unknown; skills_json?: unknown } | undefined
    if (row === undefined) return undefined
    return { role: String(row.role), state: String(row.state), skills: parseSkills(row.skills_json) }
  } catch (error) {
    if (!isMissingSkillsColumn(error)) throw error
    // A pre-v3 ledger under a stale bundled reader: keep roster/read paths
    // usable and treat the selection as empty instead of returning HTTP 500.
    const row = db.prepare('SELECT role, state FROM members WHERE project_id = ? AND session_id = ? LIMIT 1')
      .get(projectId, sessionId) as { role?: unknown; state?: unknown } | undefined
    return row === undefined ? undefined : { role: String(row.role), state: String(row.state), skills: [] }
  }
}

function requireSupervisor(db: DatabaseSync, projectId: string, actorSessionId: string): MemberRow {
  const actor = readMember(db, projectId, actorSessionId)
  if (actor === undefined || actor.role !== 'supervisor' || actor.state === 'departed') {
    throw new SkillIpcError('SKILL_FORBIDDEN', 403, '只有本项目在册 supervisor 可以管理技能')
  }
  return actor
}

function requireMember(db: DatabaseSync, projectId: string, sessionId: string): MemberRow {
  const member = readMember(db, projectId, sessionId)
  if (member === undefined || member.state === 'departed') {
    throw new SkillIpcError('SKILL_MEMBER_NOT_FOUND', 404, '目标成员不在本项目')
  }
  return member
}

/** Whether the ledger carries the `projects` table; older fixtures and pre-migration ledgers do not. */
function detectProjectsTable(db: DatabaseSync): boolean {
  try {
    return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'projects' LIMIT 1").get() !== undefined
  } catch {
    return false
  }
}

/**
 * Authorize one project-scoped call. Any session may use the skill API while its
 * project exists, so an off-roster session is admitted with `undefined`; a
 * missing project, a session rostered by another project, and a departed member
 * stay rejected.
 * @param db - readonly ledger connection.
 * @param projectId - project the call is scoped to.
 * @param sessionId - calling session.
 * @param hasProjects - whether the ledger has the `projects` table.
 * @returns the roster row of a member actor, or undefined for an off-roster session.
 */
function requireActor(
  db: DatabaseSync,
  projectId: string,
  sessionId: string,
  hasProjects: boolean,
): MemberRow | undefined {
  const project = hasProjects
    ? db.prepare('SELECT 1 AS ok FROM projects WHERE project_id = ? LIMIT 1').get(projectId)
    : db.prepare('SELECT 1 AS ok FROM members WHERE project_id = ? LIMIT 1').get(projectId)
  if (project === undefined) throw new SkillIpcError('SKILL_FORBIDDEN', 403, `项目不存在：${projectId}`)
  const actor = readMember(db, projectId, sessionId)
  if (actor !== undefined) {
    if (actor.state === 'departed') {
      throw new SkillIpcError('SKILL_FORBIDDEN', 403, '会话已退出本项目，不能查看或修改技能')
    }
    return actor
  }
  const elsewhere = db.prepare('SELECT 1 AS ok FROM members WHERE session_id = ? LIMIT 1').get(sessionId)
  if (elsewhere !== undefined) {
    throw new SkillIpcError('SKILL_FORBIDDEN', 403, '该会话属于其他项目，不能操作本项目技能')
  }
  return undefined
}

/**
 * A warning-bearing install needs a supervisor confirmation. Non-supervisors
 * cannot proceed even with `confirm:true`.
 * @returns pending confirmation for a supervisor without `confirm`, else undefined.
 */
function requireSupervisorConfirmation(
  actor: MemberRow | undefined,
  confirm: unknown,
  warnings: readonly InstallWarning[],
  preview: InstallPreview,
): InstallConfirmation | undefined {
  if (warnings.length === 0) return undefined
  if (actor?.role !== 'supervisor') {
    throw new SkillIpcError('SKILL_CONFIRM_REQUIRED', 403, '该技能缺少安全信息，需主管确认后才能安装')
  }
  if (confirm === true) return undefined
  return { requiresConfirmation: true, installed: false, warnings, preview }
}

/**
 * Run `wsl` with an argument array; no shell interpretation, bounded output and
 * a hard timeout. The SkillHub path itself is a fixed argument.
 * @param args - arguments after the `wsl` executable.
 * @param timeoutMs - hard timeout in milliseconds.
 * @returns process result; spawn errors are reported in `error`.
 */
function runWslCommand(args: readonly string[], timeoutMs: number): Promise<PackageCommandResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('wsl', [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: PackageCommandResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout: stdout.slice(0, 64 * 1024), stderr: stderr.slice(0, 64 * 1024), timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', error => finish({ code: null, stdout, stderr, error: error.message }))
    child.on('close', code => finish({ code, stdout, stderr }))
  })
}

/**
 * Bind the read/write DB and catalog directory once; every call revalidates the
 * actor and target so a stale UI cannot write across projects.
 * @param options - read-only DB, ledger path for writes, catalog root.
 * @returns the four UI operations.
 */
export function createSkillApi(options: {
  readonly db: DatabaseSync
  readonly ledgerPath: string
  readonly skillsDir: string
  readonly builtinDir?: string
  /** Injection seam for URL installs. */
  readonly fetch?: typeof globalThis.fetch
  /** Injection seam for the WSL SkillHub CLI. */
  readonly runPackageCommand?: (args: readonly string[], timeoutMs: number) => Promise<PackageCommandResult>
  /** Audit directory; defaults to `~/.dsh/cadre-skill-admin`. */
  readonly auditDir?: string
}): SkillApi {
  const { db, ledgerPath, skillsDir, builtinDir } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const runPackageCommand = options.runPackageCommand ?? runWslCommand
  const hasProjects = detectProjectsTable(db)
  const actorOf = (projectId: string, sessionId: string): MemberRow | undefined =>
    requireActor(db, projectId, sessionId, hasProjects)
  const auditFile = join(options.auditDir ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'cadre-skill-admin'), 'audit.jsonl')
  const auditPackage = (record: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(auditFile), { recursive: true })
      appendFileSync(auditFile, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch {
      // Audit failure must not turn a successful install into a failure.
    }
  }
  const catalog = (): ReadonlyMap<string, SkillPack> => {
    const merged = new Map<string, SkillPack>()
    if (builtinDir !== undefined) {
      for (const [id, pack] of loadSkillCatalog(builtinDir, 'builtin')) merged.set(id, pack)
    }
    for (const [id, pack] of loadSkillCatalog(skillsDir, 'installed')) {
      if (!merged.has(id)) merged.set(id, pack)
    }
    return merged
  }
  const packOf = (id: string): SkillPack => {
    const pack = catalog().get(id)
    if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 400, `未知技能包：${id}`)
    return pack
  }

  return {
    catalog(input) {
      const actor = actorOf(input.projectId, input.actorSessionId)
      const target = input.targetSessionId ?? input.actorSessionId
      if (target !== input.actorSessionId && actor?.role !== 'supervisor') {
        throw new SkillIpcError('SKILL_FORBIDDEN', 403, '只有 supervisor 可以查看其他成员的技能')
      }
      // An off-roster session has no roster row holding a selection, so it reads as "nothing enabled".
      const selected = new Set(
        target === input.actorSessionId && actor === undefined
          ? []
          : requireMember(db, input.projectId, target).skills,
      )
      return [...catalog().values()].map(pack => entryOf(pack, selected.has(pack.id), input.locale))
    },
    get(input) {
      const actor = actorOf(input.projectId, input.actorSessionId)
      if (input.targetSessionId !== input.actorSessionId && actor?.role !== 'supervisor') {
        throw new SkillIpcError('SKILL_FORBIDDEN', 403, '只有 supervisor 可以查看其他成员的技能')
      }
      return {
        skills: [...(input.targetSessionId === input.actorSessionId && actor === undefined
          ? []
          : requireMember(db, input.projectId, input.targetSessionId).skills)],
      }
    },
    set(input) {
      const actor = actorOf(input.projectId, input.actorSessionId)
      if (input.targetSessionId !== input.actorSessionId && actor?.role !== 'supervisor') {
        throw new SkillIpcError('SKILL_FORBIDDEN', 403, '只有 supervisor 可以修改其他成员的技能')
      }
      if (input.targetSessionId !== input.actorSessionId) requireMember(db, input.projectId, input.targetSessionId)
      if (!Array.isArray(input.skills) || input.skills.some(item => typeof item !== 'string')) {
        throw new SkillIpcError('SKILL_INVALID', 400, 'skills 必须是字符串数组')
      }
      const selected = [...new Set(input.skills as string[])]
      for (const id of selected) {
        packOf(id)
      }
      // Off-roster sessions have no members row to hold a selection: validate and echo it unchanged.
      if (actor === undefined) return { skills: selected }
      const writer = new DatabaseSync(ledgerPath)
      try {
        writer.prepare('UPDATE members SET skills_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ?')
          .run(JSON.stringify(selected), new Date().toISOString(), input.projectId, input.targetSessionId)
      } catch (error) {
        if (isMissingSkillsColumn(error)) {
          throw new SkillIpcError('SKILL_SCHEMA_OUTDATED', 409, '台账 schema 缺少 skills_json；请重启应用完成 schema 3 迁移')
        }
        throw error
      } finally {
        writer.close()
      }
      return { skills: selected }
    },
    assertSupervisor(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
    },
    assertMember(input) {
      actorOf(input.projectId, input.actorSessionId)
    },
    preview(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const pack = packOf(input.packId)
      return {
        id: pack.id, content: pack.content, tokenEstimate: pack.tokenEstimate, license: pack.license,
        ...(pack.author === undefined ? {} : { author: pack.author }),
        ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
      }
    },
    add(input) {
      actorOf(input.projectId, input.actorSessionId)
      const pack = validatePack(input)
      const target = join(skillsDir, pack.id)
      if (builtinDir !== undefined && existsSync(join(builtinDir, pack.id))) {
        throw new SkillIpcError('SKILL_BUILTIN_READONLY', 403, `内置技能包 ${pack.id} 不可覆盖`)
      }
      const overwrite = input.overwrite === true
      if (existsSync(target) && !overwrite) {
        throw new SkillIpcError('SKILL_EXISTS', 409, `技能包 ${pack.id} 已存在；如需覆盖请传 overwrite:true`)
      }
      const manifest = {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        roles: pack.roles,
        tokenEstimate: pack.tokenEstimate,
        tools: pack.tools,
        source: pack.source,
        license: pack.license,
        ...(pack.descriptionI18n === undefined ? {} : { descriptionI18n: pack.descriptionI18n }),
        ...(pack.author === undefined ? {} : { author: pack.author }),
        ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
      }
      const temporary = join(skillsDir, `.${pack.id}.tmp-${randomUUID()}`)
      const backup = `${target}.old-${randomUUID()}`
      try {
        mkdirSync(temporary, { recursive: true })
        writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
        writeFileSync(join(temporary, 'SKILL.md'), pack.content)
        if (existsSync(target)) renameSync(target, backup)
        renameSync(temporary, target)
        if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      } catch {
        try { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
        try {
          if (existsSync(backup) && !existsSync(target)) renameSync(backup, target)
        } catch { /* best-effort rollback */ }
        throw new SkillIpcError('SKILL_WRITE_FAILED', 500, '写入技能包失败；请检查目录权限')
      }
      const saved = catalog().get(pack.id)
      if (saved === undefined) {
        throw new SkillIpcError('SKILL_WRITE_FAILED', 500, '技能包写入后无法读取；请检查 manifest')
      }
      return entryOf(saved)
    },
    remove(input) {
      actorOf(input.projectId, input.actorSessionId)
      const id = requiredString(input.packId, 'packId')
      if (!KEBAB_ID.test(id) || id.length > 64) throw new SkillIpcError('SKILL_INVALID', 400, 'packId 格式非法')
      if (input.confirm !== true) throw new SkillIpcError('SKILL_INVALID', 400, '删除技能包需要 confirm:true')
      if (builtinDir !== undefined && existsSync(join(builtinDir, id))) {
        throw new SkillIpcError('SKILL_BUILTIN_READONLY', 403, `内置技能包 ${id} 不可删除`)
      }
      const target = join(skillsDir, id)
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw new SkillIpcError('SKILL_NOT_FOUND', 404, `未知技能包：${id}`)
      }
      try {
        rmSync(target, { recursive: true, force: false })
      } catch {
        throw new SkillIpcError('SKILL_WRITE_FAILED', 500, '删除技能包失败；请检查目录权限')
      }
      return { removed: true }
    },
    async inspectUrl(input) {
      actorOf(input.projectId, input.actorSessionId)
      const targets = rawTargets(input.url)
      let total = 0
      const manifestText = await fetchText(doFetch, targets.manifest, 64 * 1024, () => total, value => { total = value })
      const content = await fetchText(doFetch, targets.skill, 256 * 1024, () => total, value => { total = value })
      let manifest: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(manifestText)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        manifest = parsed as Record<string, unknown>
      } catch {
        throw new SkillIpcError('SKILL_INVALID', 400, '远程 manifest.json 不是对象 JSON')
      }
      const pack = validatePack({
        projectId: input.projectId,
        actorSessionId: input.actorSessionId,
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        descriptionI18n: manifest.descriptionI18n,
        author: manifest.author,
        homepage: manifest.homepage,
        roles: manifest.roles,
        tokenEstimate: manifest.tokenEstimate,
        tools: manifest.tools,
        source: manifest.source,
        license: manifest.license,
        content,
      })
      return {
        pack,
        contentHash: createHash('sha256').update(content).digest('hex'),
        manifestHash: createHash('sha256').update(manifestText).digest('hex'),
      }
    },
    async installUrl(input) {
      const actor = actorOf(input.projectId, input.actorSessionId)
      const inspected = await this.inspectUrl(input)
      const pack = inspected.pack
      const warnings = installWarnings(pack, { hasHash: true })
      const preview: InstallPreview = {
        name: pack.name, source: pack.source, license: pack.license,
        ...(pack.author === undefined ? {} : { author: pack.author }), hasHash: true,
      }
      const pending = requireSupervisorConfirmation(actor, input.confirm, warnings, preview)
      if (pending !== undefined) {
        auditPackage({ kind: 'install-url', url: String(input.url).slice(0, 300), result: 'confirmation-required',
          warnings, preview })
        return pending
      }
      const entry = this.add({
        projectId: input.projectId,
        actorSessionId: input.actorSessionId,
        id: pack.id,
        name: pack.name,
        description: pack.description,
        descriptionI18n: pack.descriptionI18n,
        author: pack.author,
        homepage: pack.homepage,
        roles: pack.roles,
        tokenEstimate: pack.tokenEstimate,
        tools: pack.tools,
        source: pack.source,
        license: pack.license,
        content: pack.content,
        overwrite: input.confirm === true,
      })
      auditPackage({
        kind: 'install-url', url: String(input.url).slice(0, 300), packId: pack.id, result: 'installed', warnings,
        ...(warnings.length === 0 ? {} : { confirmedBy: input.actorSessionId }),
      })
      return entry
    },
    async installPackage(input) {
      const actor = actorOf(input.projectId, input.actorSessionId)
      const name = requiredString(input.name, 'name')
      if (name.length > 128 || !PACKAGE_NAME.test(name)) {
        throw new SkillIpcError('SKILL_INVALID', 400, '包名必须是合法的 npm 包名（可带 @scope/）')
      }
      // A package has no catalog metadata before installation and the CLI returns
      // no content hash, so provenance is always incomplete until a supervisor
      // explicitly confirms.
      const warnings = installWarnings({ license: 'unknown', source: `skillhub:${name}` })
      const preview: InstallPreview = {
        name, source: `skillhub:${name}`, license: 'unknown', hasHash: false,
      }
      const pending = requireSupervisorConfirmation(actor, input.confirm, warnings, preview)
      if (pending !== undefined) {
        auditPackage({ kind: 'install-package', name, result: 'confirmation-required', warnings, preview })
        return pending
      }
      const started = Date.now()
      const args = [
        '-d', 'Ubuntu-24.04', '--', '/root/.local/bin/skillhub', 'install', name, '--dir', skillsDir,
      ]
      let result: PackageCommandResult
      try {
        result = await runPackageCommand(args, 180_000)
      } catch (error) {
        const durationMs = Date.now() - started
        auditPackage({ kind: 'install-package', name, result: 'failed', durationMs })
        throw new SkillIpcError('SKILL_INSTALL_PACKAGE_FAILED', 502,
          `SkillHub 安装失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const durationMs = Date.now() - started
      const detail = (result.stderr || result.stdout).trim().slice(0, 500)
      const unavailable = result.error !== undefined
        || result.code === null
        || result.code === 127
        || /WSL_E_DISTRO_NOT_FOUND|No such file or directory|wsl: .*not found/i.test(`${result.error ?? ''} ${result.stderr}`)
      if (unavailable) {
        auditPackage({ kind: 'install-package', name, result: 'unsupported', durationMs })
        throw new SkillIpcError('SKILL_INSTALL_PACKAGE_UNSUPPORTED', 501,
          `SkillHub CLI 或 WSL 发行版不可用${detail === '' ? '' : `：${detail}`}`)
      }
      if (result.timedOut === true) {
        auditPackage({ kind: 'install-package', name, result: 'timeout', durationMs })
        throw new SkillIpcError('SKILL_INSTALL_PACKAGE_FAILED', 502, 'SkillHub 安装超时（180s）')
      }
      if (result.code !== 0) {
        auditPackage({ kind: 'install-package', name, result: 'failed', durationMs })
        throw new SkillIpcError('SKILL_INSTALL_PACKAGE_FAILED', 502,
          `SkillHub 安装失败（exit ${String(result.code)}）${detail === '' ? '' : `：${detail}`}`)
      }
      const expectedId = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
      const pack = catalog().get(expectedId)
      const visible = pack !== undefined
      auditPackage({
        kind: 'install-package', name, result: visible ? 'installed' : 'not-visible', durationMs, warnings,
        ...(warnings.length === 0 ? {} : { confirmedBy: input.actorSessionId }),
      })
      if (!visible) {
        throw new SkillIpcError('SKILL_INSTALL_PACKAGE_FAILED', 502,
          `SkillHub 安装完成但 catalog 未发现 ${expectedId}`)
      }
      return { name, visible, durationMs, installed: true, warnings }
    },
    async installAny(input) {
      actorOf(input.projectId, input.actorSessionId)
      const text = requiredString(input.text, 'text')
      if (text.length > 4000) {
        throw new SkillIpcError('SKILL_INVALID', 400, '安装说明不能超过 4000 字')
      }
      const target = parseInstallInstruction(text)
      if (target.kind === 'package') {
        const result = await this.installPackage({
          projectId: input.projectId, actorSessionId: input.actorSessionId, name: target.target,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        })
        if ('requiresConfirmation' in result) {
          return { kind: 'package', target: target.target, ...result }
        }
        return { kind: 'package', target: target.target, installed: true, warnings: result.warnings, result }
      }
      const result = await this.installUrl({
        projectId: input.projectId, actorSessionId: input.actorSessionId, url: target.target,
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      })
      if ('requiresConfirmation' in result) {
        return { kind: 'url', target: target.target, ...result }
      }
      return { kind: 'url', target: target.target, installed: true, warnings: installWarnings(result, { hasHash: true }), result }
    },
  }
}

const MAX_TOTAL_BYTES = 320 * 1024

/** Resolve manifest/SKILL URLs from a raw or github.com tree URL. */
function rawTargets(value: unknown): { manifest: URL; skill: URL } {
  if (typeof value !== 'string') throw new SkillIpcError('SKILL_URL_INVALID', 400, 'url 必填')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SkillIpcError('SKILL_URL_INVALID', 400, 'url 不是合法地址')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new SkillIpcError('SKILL_URL_INVALID', 400, '只支持无凭据的 https URL')
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.some(part => part === '..' || part === '.')) {
    throw new SkillIpcError('SKILL_URL_INVALID', 400, 'URL 路径不能包含 . 或 ..')
  }
  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) throw new SkillIpcError('SKILL_URL_INVALID', 400, 'raw URL 缺少仓库路径')
    if (url.pathname.endsWith('/SKILL.md') || url.pathname.endsWith('.md')) {
      const base = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
      return {
        manifest: new URL(`https://raw.githubusercontent.com${base}/manifest.json`),
        skill: new URL(`https://raw.githubusercontent.com${base}/SKILL.md`),
      }
    }
    if (url.pathname.endsWith('/')) {
      return {
        manifest: new URL(`${url.href}manifest.json`),
        skill: new URL(`${url.href}SKILL.md`),
      }
    }
    throw new SkillIpcError('SKILL_URL_INVALID', 400, 'raw URL 必须指向 SKILL.md 或目录')
  }
  if (url.hostname === 'github.com') {
    if (parts.length === 2) {
      const base = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main`
      return { manifest: new URL(`${base}/manifest.json`), skill: new URL(`${base}/SKILL.md`) }
    }
    if (parts[2] !== 'tree' && parts[2] !== 'blob') {
      throw new SkillIpcError('SKILL_URL_INVALID', 400, 'GitHub URL 必须是仓库根、tree/ 或 blob/')
    }
    if (parts.length < 5) throw new SkillIpcError('SKILL_URL_INVALID', 400, 'GitHub URL 缺少分支/目录')
    const rest = parts.slice(3)
    const rawBase = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${rest.join('/')}`
    if (parts[2] === 'blob') {
      const base = rawBase.slice(0, rawBase.lastIndexOf('/'))
      return { manifest: new URL(`${base}/manifest.json`), skill: new URL(`${base}/SKILL.md`) }
    }
    return { manifest: new URL(`${rawBase}/manifest.json`), skill: new URL(`${rawBase}/SKILL.md`) }
  }
  throw new SkillIpcError('SKILL_URL_INVALID', 400, '只支持 github.com / raw.githubusercontent.com')
}

async function fetchText(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  maxBytes: number,
  total: () => number,
  setTotal: (value: number) => void,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json,text/plain,*/*' } })
  } catch {
    throw new SkillIpcError('SKILL_URL_FETCH_FAILED', 502, '拉取技能包失败；请检查网络或 URL')
  }
  if (!response.ok) {
    throw new SkillIpcError('SKILL_URL_FETCH_FAILED', 502, `拉取技能包失败：HTTP ${String(response.status)}`)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes || total() + buffer.byteLength > MAX_TOTAL_BYTES) {
    throw new SkillIpcError('SKILL_TOO_LARGE', 413, '远程技能包超过大小限制')
  }
  setTotal(total() + buffer.byteLength)
  return new TextDecoder().decode(buffer)
}

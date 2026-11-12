/** Conversational skill operations shared by every agent preset. @module */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CatalogEntry, SkillApi } from './ipc.ts'
import { SkillIpcError, installWarnings } from './ipc.ts'
import type { SkillPlan } from './admin.ts'
import type { SkillPack } from './catalog.ts'
import { loadSkillCatalog, searchLocalPacks } from './catalog.ts'
import type { PackCheck } from './diagnostics.ts'
import { checkSkillCatalog } from './diagnostics.ts'

/** One catalog row as the conversational tools expose it. */
export interface SkillSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly origin: string
  readonly license: string
  readonly roles: readonly string[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly selected: boolean
  readonly author?: string
  readonly homepage?: string
}

/** One candidate returned by search. */
export interface SearchResult {
  readonly packId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string
  readonly license: string
  readonly author?: string
  readonly homepage?: string
}

/** One skill operation audit row. */
export interface AuditItem {
  readonly id: string
  readonly time: string
  readonly kind: string
  readonly actorSessionId: string
  readonly projectId: string
  readonly result: string
  readonly warnings: readonly string[]
  readonly packId?: string
  readonly target?: string
  readonly message?: string
}

/** A skill detail row returned by `skill_preview`. */
export interface PreviewView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
  readonly tokenEstimate: number
  readonly license: string
  readonly author?: string
  readonly homepage?: string
}

/** Non-failing result of `skill_search`, including its degradation state. */
export interface SearchView {
  readonly items: readonly SearchResult[]
  readonly source: 'remote' | 'local'
  readonly degraded: boolean
  readonly message?: string
}

/** Health-check result of `skill_check`. */
export interface CheckView {
  readonly status: 'ok' | 'warning' | 'error'
  readonly items: readonly PackCheck[]
  readonly summary: {
    readonly total: number
    readonly ok: number
    readonly warning: number
    readonly error: number
  }
}

/** Non-executed plan returned by `skill_plan`. */
export interface PlanView extends SkillPlan {
  readonly confirmToken?: string
}

/** Successful tool payload; failures use {@link SkillToolFailure}. */
export type SkillToolResult<T> = (T & { readonly ok: true }) | SkillToolFailure

/** The uniform failure envelope for every conversational skill tool. */
export interface SkillToolFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly remediation: string
}

/** Corrective action per stable failure code, stated in user terms. */
const REMEDIATION: Readonly<Record<string, string>> = {
  SKILL_PROJECT_REQUIRED: '提供当前会话对应的 projectId 后重试；不要选择其他项目',
  SKILL_FORBIDDEN: '回到有效项目会话；需要主管的操作请转交主管，或改用只读工具',
  SKILL_CONFIRM_REQUIRED: '请主管核对 preview/warnings，确认后以 confirm:true 重试',
  SKILL_NOT_FOUND: '先调用 skill_catalog 或 skill_search 获取有效 packId，再重试',
  SKILL_EXISTS: '更换 id；确需覆盖时由主管使用 overwrite:true、confirm:true',
  SKILL_BUILTIN_READONLY: '复制内容并以新 id 调用 skill_create，不改内置目录',
  SKILL_INVALID: '按 message 的 field 修正 JSON 后重试',
  SKILL_SEARCH_UNAVAILABLE: '检查技能目录权限后重试；恢复远程连接前可使用 skill_catalog',
  SKILL_URL_FETCH_FAILED: '检查 HTTPS URL 与网络后重试；也可改用本地 skill_create',
  SKILL_WRITE_FAILED: '检查目录权限和磁盘空间，运行 skill_check 确认状态后重试',
  SKILL_ADMIN_PLAN_EXPIRED: '重新调用 skill_plan，使用最新 planId/confirmToken，不复用旧值',
  SKILL_ADMIN_TOKEN_INVALID: '重新调用 skill_plan，使用最新 planId/confirmToken，不复用旧值',
}

/** The remediation sentence for a failure code. */
export function remediationOf(code: string): string {
  return REMEDIATION[code] ?? '按 message 修正后重试；仍失败时用 skill_check 查看技能包状态'
}

/**
 * Convert any thrown value into the tool failure envelope.
 * @param error - the thrown value.
 * @returns the stable code, Chinese message, and corrective action.
 */
export function failureOf(error: unknown): SkillToolFailure {
  if (error instanceof SkillIpcError) {
    return { ok: false, code: error.code, message: error.message, remediation: remediationOf(error.code) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'SKILL_WRITE_FAILED', message: `技能操作失败：${message}`, remediation: remediationOf('SKILL_WRITE_FAILED') }
}

/**
 * Build a successful tool payload.
 * @param value - the model-visible fields.
 * @returns the payload with `ok: true`.
 */
export function succeed<T extends object>(value: T): T & { readonly ok: true } {
  return { ok: true, ...value }
}

/** Who the caller is inside the resolved project. */
export interface ProjectBinding {
  readonly projectId: string
  readonly role: 'supervisor' | 'worker' | 'none'
}

/** Resolves the one project a session may operate on. */
export interface ProjectResolver {
  /**
   * @param sessionId - the calling agent session id.
   * @param projectId - optional caller-supplied project.
   * @returns the single project and the caller's roster role there.
   */
  resolve(sessionId: string, projectId?: string): ProjectBinding
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

function memberOf(db: DatabaseSync, sessionId: string): { readonly projectId: string; readonly role: string; readonly state: string } | undefined {
  const row = db.prepare(
    'SELECT project_id, role, state FROM members WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(sessionId)
  if (row === undefined) return undefined
  return {
    projectId: String(row.project_id),
    role: String(row.role),
    state: typeof row.state === 'string' ? row.state : 'active',
  }
}

function projectKnown(db: DatabaseSync, projectId: string, hasProjects: boolean): boolean {
  const member = db.prepare('SELECT 1 AS present FROM members WHERE project_id = ? LIMIT 1').get(projectId)
  if (member !== undefined) return true
  if (!hasProjects) return false
  const project = db.prepare('SELECT 1 AS present FROM projects WHERE project_id = ? LIMIT 1').get(projectId)
  return project !== undefined
}

/**
 * Resolve a session's project from the roster first, then the caller's explicit `projectId`.
 * A roster row wins because it is the durable binding; a conflicting explicit value is a
 * cross-project attempt and is refused instead of guessed.
 * @param db - read-only ledger connection.
 * @returns the resolver used by the conversational tools.
 */
export function createLedgerResolver(db: DatabaseSync): ProjectResolver {
  const hasProjects = tableExists(db, 'projects')
  return {
    resolve(sessionId, projectId) {
      const member = memberOf(db, sessionId)
      if (member !== undefined && member.state === 'departed') {
        throw new SkillIpcError('SKILL_FORBIDDEN', 403, `会话 ${sessionId} 已退出项目，不能继续操作技能`)
      }
      if (projectId !== undefined) {
        if (member !== undefined && member.projectId !== projectId) {
          throw new SkillIpcError('SKILL_FORBIDDEN', 403, `会话 ${sessionId} 属于项目 ${member.projectId}，不能操作项目 ${projectId}`)
        }
        if (!projectKnown(db, projectId, hasProjects)) {
          throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, `项目 ${projectId} 不存在`)
        }
        const role = member?.role === 'supervisor' ? 'supervisor' : member === undefined ? 'none' : 'worker'
        return { projectId, role }
      }
      if (member === undefined) {
        throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '当前会话不在任何项目名册中，无法确定项目')
      }
      const role = member.role === 'supervisor' ? 'supervisor' : 'worker'
      return { projectId: member.projectId, role }
    },
  }
}

/** One remote search hit as the provider reports it. */
export interface SearchHit extends SearchResult {}

/** Remote catalog search; injected so no unit test reaches the network. */
export interface SkillSearchProvider {
  /**
   * @param input - free-text query, result cap, and the caller's abort signal.
   * @returns candidate skills in provider order.
   */
  search(input: { readonly query: string; readonly limit: number; readonly signal: AbortSignal }): Promise<readonly SearchResult[]>
  /**
   * @param input - a local pack id or a remote source URL.
   * @returns the remote detail for a URL, or undefined when the provider cannot read it.
   */
  preview?(input: { readonly packId?: string; readonly sourceUrl?: string }): Promise<PreviewView | undefined>
}

/** Creation fields accepted from the model; the port fills project, actor and source. */
export interface CreateInput {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
  readonly roles: readonly string[]
  readonly tools: readonly string[]
  readonly tokenEstimate: number
  readonly license: string
  readonly author?: string
  readonly homepage?: string
  readonly overwrite?: boolean
}

/** The dependency surface behind the eight conversational tools. */
export interface SkillConversationPort {
  /** @param sessionId - caller session; @param projectId - optional explicit project. */
  resolve(sessionId: string, projectId?: string): Promise<ProjectBinding>
  /** @param sessionId - caller session; @param projectId - resolved project. */
  catalog(sessionId: string, projectId: string | undefined, query: string): Promise<SkillSummary[]>
  /** @param sessionId - caller session; @param projectId - resolved project. */
  searchable(sessionId: string, projectId: string | undefined, query: string, limit: number): Promise<SearchResult[]>
  /** @param packId - local pack id; @param sourceUrl - remote pack URL. */
  preview(sessionId: string, projectId: string | undefined, packId: string, sourceUrl?: string): Promise<PreviewView>
  /** @param input - validated creation payload. */
  create(sessionId: string, projectId: string | undefined, input: CreateInput): Promise<SkillSummary>
  /** @param input - exactly one of name/url/text plus optional confirm. */
  install(sessionId: string, projectId: string | undefined, input: {
    readonly name?: string
    readonly url?: string
    readonly text?: string
    readonly confirm?: boolean
  }): Promise<InstallView>
  /** @param projectId - resolved project; @param packId - optional single pack. */
  check(sessionId: string, projectId: string | undefined, packId?: string): Promise<CheckView>
  /** @param limit - rows to return, newest last. */
  audit(sessionId: string, projectId: string | undefined, limit: number): Promise<AuditItem[]>
  /** @param input - kind plus the url or packId the plan targets. */
  plan(sessionId: string, projectId: string | undefined, input: {
    readonly kind: 'install' | 'update' | 'remove'
    readonly url?: string
    readonly packId?: string
  }): Promise<PlanView>
  /** Record one operation in the audit log. */
  record(item: AuditItem): void
}

/** Model-visible install result, including the confirmation request. */
export interface InstallView {
  readonly kind: 'package' | 'url'
  readonly target: string
  readonly installed: boolean
  readonly warnings: readonly string[]
  readonly requiresConfirmation?: boolean
  readonly preview?: {
    readonly name: string
    readonly source: string
    readonly license: string
    readonly author?: string
    readonly hasHash: boolean
  }
  readonly result?: SkillSummary
}

/** Fields every conversational skill executor needs. */
export interface ConversationOptions {
  readonly port: SkillConversationPort
  readonly search?: SkillSearchProvider | undefined
  /** Configuration for the remote search cap and timeout. */
  readonly searchTimeoutMs?: number
}

/** Token estimate for new content when the caller omits one. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

function sessionActor(sessionId: string): string {
  return sessionId
}

/**
 * Execute the eight conversational skill tools against one port.
 */
export class SkillConversationExecutor {
  private readonly port: SkillConversationPort
  private readonly search: SkillSearchProvider | undefined
  private readonly searchTimeoutMs: number

  /**
   * @param options - the port plus the optional remote search provider.
   */
  constructor(options: ConversationOptions) {
    this.port = options.port
    this.search = options.search
    this.searchTimeoutMs = options.searchTimeoutMs ?? 5_000
  }

  /**
   * @param sessionId - calling agent session id.
   * @param query - optional substring filter.
   * @param projectId - optional explicit project.
   * @returns catalog rows visible to the caller.
   */
  async catalog(sessionId: string, query: string | undefined, projectId?: string): Promise<SkillToolResult<{ readonly skills: SkillSummary[] }>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      const skills = await this.port.catalog(sessionId, binding.projectId, query ?? '')
      return succeed({ skills })
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param query - required free-text query.
   * @param limit - result cap, 1-20.
   * @param projectId - optional explicit project.
   * @returns remote hits, or local matches with the degradation reason.
   */
  async searchQuery(sessionId: string, query: string, limit = 5, projectId?: string): Promise<SkillToolResult<SearchView>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      if (query.trim() === '') {
        throw new SkillIpcError('SKILL_INVALID', 400, 'query 必填')
      }
      const local = await this.localSearch(sessionId, binding.projectId, query, limit)
      if (this.search === undefined) {
        return succeed({ items: local, source: 'local', degraded: true, message: '远程搜索不可用，已返回本地结果；可稍后重试远程搜索' })
      }
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, this.searchTimeoutMs)
      try {
        const items = await this.search.search({ query, limit, signal: controller.signal })
        return succeed({ items: [...items], source: 'remote', degraded: false })
      } catch {
        return succeed({ items: local, source: 'local', degraded: true, message: '远程搜索不可用，已返回本地结果；可稍后重试远程搜索' })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * Read local candidates, reporting an unreadable catalog instead of a generic failure.
   * @param sessionId - calling agent session id.
   * @param projectId - resolved project.
   * @param query - free-text query.
   * @param limit - result cap.
   * @returns local candidates in rank order.
   */
  private async localSearch(
    sessionId: string,
    projectId: string | undefined,
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    try {
      return await this.port.searchable(sessionId, projectId, query, limit)
    } catch (error) {
      if (error instanceof SkillIpcError) throw error
      throw new SkillIpcError('SKILL_SEARCH_UNAVAILABLE', 503, '本地技能目录不可读，暂时无法搜索')
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param packId - local pack id.
   * @param sourceUrl - remote pack URL, when the candidate came from search.
   * @param projectId - optional explicit project.
   * @returns the pack detail without writing anything.
   */
  async preview(sessionId: string, packId: string, sourceUrl?: string, projectId?: string): Promise<SkillToolResult<PreviewView>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      return succeed(await this.port.preview(sessionId, binding.projectId, packId, sourceUrl))
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param input - exactly one of name/url/text.
   * @param projectId - optional explicit project.
   * @returns the install result or the confirmation request.
   */
  async install(sessionId: string, input: {
    readonly name?: string
    readonly url?: string
    readonly text?: string
    readonly confirm?: boolean
  }, projectId?: string): Promise<SkillToolResult<InstallView>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      const provided = [input.name, input.url, input.text].filter(value => value !== undefined)
      if (provided.length !== 1) {
        throw new SkillIpcError('SKILL_INVALID', 400, 'name、url、text 必须且只能提供一个')
      }
      const installed = await this.port.install(sessionId, binding.projectId, input)
      if (installed.requiresConfirmation === true) {
        // A non-supervisor cannot pass confirm for a warning-bearing pack: the executing
        // port already refused it, so naming the supervisor action keeps it actionable.
        return succeed({
          kind: installed.kind,
          target: installed.target,
          installed: false,
          warnings: [...installed.warnings],
          requiresConfirmation: true,
          ...(installed.preview === undefined ? {} : { preview: installed.preview }),
        })
      }
      return succeed({
        kind: installed.kind,
        target: installed.target,
        installed: true,
        warnings: [...installed.warnings],
        ...(installed.result === undefined ? {} : { result: installed.result }),
      })
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param input - creation fields; roles/tools/tokenEstimate default here.
   * @param projectId - optional explicit project.
   * @returns the created skill summary.
   */
  async create(sessionId: string, input: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly content: string
    readonly roles?: readonly string[]
    readonly tools?: readonly string[]
    readonly tokenEstimate?: number
    readonly author?: string
    readonly homepage?: string
    readonly license?: string
    readonly overwrite?: boolean
    readonly confirm?: boolean
  }, projectId?: string): Promise<SkillToolResult<{ readonly created: true; readonly skill: SkillSummary }>> {
    try {
      if (input.overwrite === true && input.confirm !== true) {
        throw new SkillIpcError('SKILL_INVALID', 400, '覆盖已有技能包需要 overwrite:true 与 confirm:true 同时提供')
      }
      const binding = await this.port.resolve(sessionId, projectId)
      const skill = await this.port.create(sessionId, binding.projectId, {
        id: input.id,
        name: input.name,
        description: input.description,
        roles: input.roles ?? ['supervisor', 'worker'],
        tokenEstimate: input.tokenEstimate ?? estimateTokens(input.content),
        tools: input.tools ?? [],
        license: input.license ?? 'unknown',
        content: input.content,
        overwrite: input.overwrite === true && input.confirm === true,
        ...(input.author === undefined ? {} : { author: input.author }),
        ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
      })
      return succeed({ created: true as const, skill })
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param packId - optional single pack; omitted checks every pack.
   * @param projectId - optional explicit project.
   * @returns per-pack health with its summary.
   */
  async check(sessionId: string, packId?: string, projectId?: string): Promise<SkillToolResult<CheckView>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      return succeed(await this.port.check(sessionId, binding.projectId, packId))
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param limit - rows to return, 1-50.
   * @param projectId - optional explicit project.
   * @returns the caller-visible audit rows.
   */
  async audit(sessionId: string, limit = 20, projectId?: string): Promise<SkillToolResult<{ readonly items: AuditItem[] }>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      return succeed({ items: await this.port.audit(sessionId, binding.projectId, limit) })
    } catch (error) {
      return failureOf(error)
    }
  }

  /**
   * @param sessionId - calling agent session id.
   * @param input - plan kind plus the required target field.
   * @param projectId - optional explicit project.
   * @returns the non-executed plan.
   */
  async plan(sessionId: string, input: {
    readonly kind: 'install' | 'update' | 'remove'
    readonly url?: string
    readonly packId?: string
  }, projectId?: string): Promise<SkillToolResult<PlanView>> {
    try {
      const binding = await this.port.resolve(sessionId, projectId)
      if (input.kind === 'install' && input.url === undefined) {
        throw new SkillIpcError('SKILL_INVALID', 400, 'kind:install 需要提供 url')
      }
      if (input.kind !== 'install' && input.packId === undefined) {
        throw new SkillIpcError('SKILL_INVALID', 400, `kind:${input.kind} 需要提供 packId`)
      }
      return succeed(await this.port.plan(sessionId, binding.projectId, input))
    } catch (error) {
      return failureOf(error)
    }
  }
}

/** Read the local pack catalog merged exactly like the Host registration order. */
export function loadPacks(options: {
  readonly builtinDir?: string | undefined
  readonly skillsDir: string
}): ReadonlyMap<string, SkillPack> {
  const merged = new Map<string, SkillPack>()
  if (options.builtinDir !== undefined) {
    for (const [id, pack] of loadSkillCatalog(options.builtinDir, 'builtin')) merged.set(id, pack)
  }
  for (const [id, pack] of loadSkillCatalog(options.skillsDir, 'installed')) {
    if (!merged.has(id)) merged.set(id, pack)
  }
  return merged
}

function summaryOf(entry: CatalogEntry): SkillSummary {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    origin: entry.origin,
    license: entry.license,
    roles: entry.roles,
    tokenEstimate: entry.tokenEstimate,
    tools: entry.tools,
    source: entry.source,
    selected: entry.selected,
    ...(entry.author === undefined ? {} : { author: entry.author }),
    ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
  }
}

/**
 * Project a catalog entry onto the model-visible skill summary.
 * @param entry - the API catalog entry.
 * @returns the summary with the fixed field set.
 */
export function summaryOfEntry(entry: CatalogEntry): SkillSummary {
  return summaryOf(entry)
}

/**
 * Project an on-disk pack onto the model-visible skill summary.
 * @param pack - the on-disk pack.
 * @param selected - whether the pack is currently enabled for the caller.
 * @returns the summary with the fixed field set.
 */
export function summaryOfPack(pack: SkillPack, selected = false): SkillSummary {
  return summaryOfPackInner(pack, selected)
}

/**
 * Create one pack through the shared validators and atomic writer.
 * @param api - the skill API.
 * @param input - project, actor, and the model-supplied creation fields.
 * @returns the created pack summary.
 */
export function createViaApi(api: SkillApi, input: {
  readonly projectId: string
  readonly actorSessionId: string
  readonly pack: CreateInput
}): SkillSummary {
  const entry = api.add({
    projectId: input.projectId,
    actorSessionId: input.actorSessionId,
    id: input.pack.id,
    name: input.pack.name,
    description: input.pack.description,
    roles: input.pack.roles,
    tokenEstimate: input.pack.tokenEstimate,
    tools: input.pack.tools,
    source: 'created',
    license: input.pack.license,
    content: input.pack.content,
    ...(input.pack.overwrite === undefined ? {} : { overwrite: input.pack.overwrite }),
    ...(input.pack.author === undefined ? {} : { author: input.pack.author }),
    ...(input.pack.homepage === undefined ? {} : { homepage: input.pack.homepage }),
  })
  return summaryOf(entry)
}

/**
 * Install one pack or return the supervisor confirmation request unchanged.
 * @param api - the skill API.
 * @param input - project, actor, exactly one target, and optional confirm.
 * @returns the model-visible install result.
 */
export async function installViaApi(api: SkillApi, input: {
  readonly projectId: string
  readonly actorSessionId: string
  readonly name?: string
  readonly url?: string
  readonly text?: string
  readonly confirm?: boolean
}): Promise<InstallView> {
  let outcome: Awaited<ReturnType<SkillApi['installAny']>>
  if (input.name !== undefined) {
    const result = await api.installPackage({
      projectId: input.projectId, actorSessionId: input.actorSessionId, name: input.name,
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
    })
    outcome = 'requiresConfirmation' in result
      ? { kind: 'package', target: input.name, ...result }
      : { kind: 'package', target: input.name, installed: true, warnings: result.warnings, result }
  } else if (input.url !== undefined) {
    const result = await api.installUrl({
      projectId: input.projectId, actorSessionId: input.actorSessionId, url: input.url,
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
    })
    outcome = 'requiresConfirmation' in result
      ? { kind: 'url', target: input.url, ...result }
      : { kind: 'url', target: input.url, installed: true, warnings: installWarnings(result, { hasHash: true }), result }
  } else {
    outcome = await api.installAny({
      projectId: input.projectId, actorSessionId: input.actorSessionId, text: input.text as string,
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
    })
  }
  if (outcome.installed !== true) {
    return {
      kind: outcome.kind,
      target: outcome.target,
      installed: false,
      warnings: outcome.warnings,
      requiresConfirmation: true,
      preview: {
        name: outcome.preview.name,
        source: outcome.preview.source,
        license: outcome.preview.license,
        hasHash: outcome.preview.hasHash,
        ...(outcome.preview.author === undefined ? {} : { author: outcome.preview.author }),
      },
    }
  }
  return {
    kind: outcome.kind,
    target: outcome.target,
    installed: true,
    warnings: outcome.warnings,
    ...(outcome.kind === 'url' ? { result: summaryOf(outcome.result) } : {}),
  }
}

function summaryOfPackInner(pack: SkillPack, selected = false): SkillSummary {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    origin: pack.origin,
    license: pack.license,
    roles: pack.roles,
    tokenEstimate: pack.tokenEstimate,
    tools: pack.tools,
    source: pack.source,
    selected,
    ...(pack.author === undefined ? {} : { author: pack.author }),
    ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
  }
}

/** Append-only audit log adapter shared by both ports. */
export interface AuditLog {
  /** @param item - the record to append; a failure never fails the operation. */
  append(item: AuditItem): void
  /** @param limit - newest rows first. */
  read(limit: number): AuditItem[]
}

/**
 * Open the JSONL audit log.
 * @param file - absolute audit file path.
 * @returns the append/read adapter.
 */
export function createAuditLog(file: string): AuditLog {
  const append = (item: AuditItem): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(item)}\n`, 'utf8')
    } catch {
      // Audit failure must not turn a successful operation into a failure.
    }
  }
  const read = (limit: number): AuditItem[] => {
    if (!existsSync(file)) return []
    const rows = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
    const parsed: AuditItem[] = []
    for (const line of rows) {
      try {
        const value = JSON.parse(line) as Partial<AuditItem>
        if (typeof value.id !== 'string' || typeof value.kind !== 'string') continue
        parsed.push({
          id: value.id,
          time: typeof value.time === 'string' ? value.time : '',
          kind: value.kind,
          actorSessionId: typeof value.actorSessionId === 'string' ? value.actorSessionId : '',
          projectId: typeof value.projectId === 'string' ? value.projectId : '',
          result: typeof value.result === 'string' ? value.result : '',
          warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string') : [],
          ...(typeof value.packId === 'string' ? { packId: value.packId } : {}),
          ...(typeof value.target === 'string' ? { target: value.target } : {}),
          ...(typeof value.message === 'string' ? { message: value.message } : {}),
        })
      } catch {
        // A malformed line is never a reason to hide the remaining audit rows.
      }
    }
    return parsed.slice(-limit)
  }
  return { append, read }
}

/**
 * Build the audit row for one operation.
 * @param input - operation identity and outcome.
 * @returns the row to append.
 */
export function auditItem(input: {
  readonly kind: string
  readonly actorSessionId: string
  readonly projectId: string
  readonly result: string
  readonly warnings?: readonly string[]
  readonly packId?: string
  readonly target?: string
  readonly message?: string
}): AuditItem {
  return {
    id: randomUUID(),
    time: new Date().toISOString(),
    kind: input.kind,
    actorSessionId: input.actorSessionId,
    projectId: input.projectId,
    result: input.result,
    warnings: [...input.warnings ?? []],
    ...(input.packId === undefined ? {} : { packId: input.packId }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.message === undefined ? {} : { message: input.message }),
  }
}

/** Dependencies for the ordinary-session port, which uses the caller as the actor. */
export interface SessionPortOptions {
  readonly api: SkillApi
  readonly resolver: ProjectResolver
  readonly skillsDir: string
  readonly builtinDir?: string | undefined
  readonly audit: AuditLog
}

/**
 * Build the port used by ordinary, employee, and supervisor sessions.
 * Every call authorizes with the caller's own session id, exactly as DESIGN §1 requires:
 * the port never substitutes another session's authority.
 * @param options - skill API, project resolver, catalog roots, and audit log.
 * @returns the conversational port.
 */
export function createSessionPort(options: SessionPortOptions): SkillConversationPort {
  const { api, resolver, skillsDir, builtinDir, audit } = options
  const packs = (): ReadonlyMap<string, SkillPack> => loadPacks({
    skillsDir,
    ...(builtinDir === undefined ? {} : { builtinDir }),
  })
  const actorOf = (sessionId: string): string => sessionActor(sessionId)
  return {
    async resolve(sessionId, projectId) {
      return resolver.resolve(sessionId, projectId)
    },
    async catalog(sessionId, projectId, query) {      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      const rows = api.catalog({ projectId, actorSessionId: sessionId }).map(summaryOf)
      const needle = query.trim().toLowerCase()
      return needle === ''
        ? rows
        : rows.filter(row => `${row.id} ${row.name} ${row.description}`.toLowerCase().includes(needle))
    },
    async searchable(_sessionId, projectId, query, limit) {
      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      return searchLocalPacks(packs(), query, limit)
    },
    async preview(sessionId, projectId, packId, sourceUrl) {
      if (sourceUrl !== undefined) {
        if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
        const remote = await api.inspectUrl({ projectId, actorSessionId: sessionId, url: sourceUrl })
        return {
          id: remote.pack.id,
          name: remote.pack.name,
          description: remote.pack.description,
          content: remote.pack.content,
          tokenEstimate: remote.pack.tokenEstimate,
          license: remote.pack.license,
          ...(remote.pack.author === undefined ? {} : { author: remote.pack.author }),
          ...(remote.pack.homepage === undefined ? {} : { homepage: remote.pack.homepage }),
        }
      }
      const pack = packs().get(packId)
      if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 400, `未知技能包：${packId}`)
      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        content: pack.content,
        tokenEstimate: pack.tokenEstimate,
        license: pack.license,
        ...(pack.author === undefined ? {} : { author: pack.author }),
        ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
      }
    },
    async create(sessionId, projectId, input) {
      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      if (input.overwrite === true && resolver.resolve(sessionId, projectId).role !== 'supervisor') {
        throw new SkillIpcError('SKILL_FORBIDDEN', 403, `会话 ${sessionId} 不是本项目主管，不能覆盖技能包 ${input.id}；请主管执行覆盖或更换技能 id`)
      }
      const created = createViaApi(api, { projectId, actorSessionId: actorOf(sessionId), pack: input })
      audit.append(auditItem({
        kind: 'create', actorSessionId: sessionId, projectId, result: 'created', packId: created.id,
      }))
      return created
    },
    async install(sessionId, projectId, input) {
      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      const installed = await installViaApi(api, {
        projectId,
        actorSessionId: actorOf(sessionId),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      })
      audit.append(auditItem({
        kind: `install-${installed.kind}`,
        actorSessionId: sessionId,
        projectId,
        result: installed.installed ? 'installed' : 'confirmation-required',
        warnings: installed.warnings,
        target: installed.target,
      }))
      return installed
    },
    async check(_sessionId, _projectId, packId) {
      return checkSkillCatalog({
        skillsDir,
        ...(builtinDir === undefined ? {} : { builtinDir }),
        ...(packId === undefined ? {} : { packId }),
      })
    },
    async audit(sessionId, projectId, limit) {
      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      const binding = resolver.resolve(sessionId, projectId)
      return audit.read(50).filter(item => {
        if (item.projectId !== projectId) return false
        return binding.role === 'supervisor' ? true : item.actorSessionId === sessionId
      }).slice(-limit)
    },
    async plan(_sessionId, projectId, input) {
      if (projectId === undefined) throw new SkillIpcError('SKILL_PROJECT_REQUIRED', 400, '无法确定项目')
      return composeSessionPlan(packs(), input, projectId)
    },
    record(item) {
      audit.append(item)
    },
  }
}

/**
 * Compose a non-executed plan for the ordinary-session port.
 * @param packs - the local catalog.
 * @param input - plan kind and target.
 * @param projectId - resolved project.
 * @returns the plan plus its creator-only confirmation token.
 */
export function composeSessionPlan(packs: ReadonlyMap<string, SkillPack>, input: {
  readonly kind: 'install' | 'update' | 'remove'
  readonly url?: string
  readonly packId?: string
}, projectId: string): PlanView {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  const planId = randomUUID()
  const confirmToken = randomUUID()
  if (input.kind === 'install') {
    let sourceUrl: string
    try {
      const parsed = new URL(input.url ?? '')
      if (parsed.protocol !== 'https:') throw new Error('not https')
      sourceUrl = parsed.href
    } catch {
      throw new SkillIpcError('SKILL_INVALID', 400, 'kind:install 需要提供合法的无凭据 https URL')
    }
    const riskFlags = ['missing-hash', 'unknown-source']
    return {
      planId, kind: 'install', packId: '', sourceUrl, actions: ['fetch-manifest', 'validate-content', 'write-pack'],
      riskFlags, summary: `安装远程技能包 ${sourceUrl}；执行前请核对来源与许可证`, expiresAt, confirmToken,
      targetDir: '',
    }
  }
  const pack = packs.get(input.packId ?? '')
  if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 400, `未知技能包：${input.packId ?? ''}`)
  if (pack.origin === 'builtin') throw new SkillIpcError('SKILL_BUILTIN_READONLY', 403, `内置技能包 ${pack.id} 不可修改`)
  const riskFlags: string[] = []
  if (pack.license === 'unknown') riskFlags.push('missing-license')
  if (pack.author === undefined) riskFlags.push('unknown-source')
  return {
    planId,
    kind: input.kind,
    packId: pack.id,
    actions: input.kind === 'update' ? ['fetch-manifest', 'replace-pack'] : ['remove-pack'],
    riskFlags,
    summary: `${input.kind === 'update' ? '更新' : '删除'}本地技能包 ${pack.id}`,
    expiresAt,
    confirmToken,
    targetDir: pack.path,
    reason: `${projectId} 上生成，计划不执行写操作`,
  }
}

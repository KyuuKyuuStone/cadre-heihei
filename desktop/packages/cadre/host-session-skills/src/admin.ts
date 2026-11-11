/**
 * Skill-admin conversation backend: ordinary sessions, read-only planning, and
 * confirmed execution through the existing skill IPC validators.
 * @module
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { loadSkillCatalog, type SkillPack } from './catalog.ts'
import { createSkillApi, installWarnings, SkillIpcError, type InstallWarning, type PackageCommandResult, type SkillApi, type ValidPack } from './ipc.ts'

/** The agent preset reserved for the skill administrator conversation. */
export const SKILL_ADMIN_PRESET = 'cadre-skill-admin'

/** One ordinary session created for the skill administrator. */
export interface AdminSession {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  /** Workspace directory ensured by createSession. */
  readonly cwd?: string
  /** Dedicated workspace id when the Host registry is available. */
  readonly workspaceId?: string
}

/** One user/assistant message read from an admin session. */
export interface AdminMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}

/** Incremental message page for an admin session. */
export interface AdminMessages {
  readonly messages: readonly AdminMessage[]
  readonly nextSeq: number
}

/** Session operations the skill admin needs; the Host supplies the real controller. */
export interface AdminSessionPort {
  create(input: { readonly preset: string; readonly cwd: string; readonly title: string }): Promise<{ readonly sessionId: string }>
  list(input: { readonly preset: string }): Promise<readonly AdminSession[]>
  delete?(input: { readonly sessionId: string }): Promise<void>
  prompt?(input: { readonly sessionId: string; readonly text: string }): Promise<void>
  messages?(input: { readonly sessionId: string; readonly afterSeq: number }): Promise<AdminMessages>
}

/** The dedicated workspace registry surface used by the admin conversation. */
export interface AdminWorkspacePort {
  create(path: string, title?: string): Promise<{
    readonly id: string
    readonly path: string
    attachSession(sessionId: string): Promise<void>
  }>
}

/** A previewable, non-executed install/update/remove plan. */
export interface SkillPlan {
  readonly planId: string
  readonly kind: 'install' | 'update' | 'remove' | 'unsupported'
  readonly packId: string
  readonly sourceUrl?: string
  readonly author?: string
  readonly license?: string
  readonly contentHash?: string
  readonly targetDir?: string
  readonly actions: readonly string[]
  readonly riskFlags: readonly string[]
  readonly summary: string
  readonly reason?: string
  readonly expiresAt: string
}

/** Result of confirming a plan. */
export interface ApplyResult {
  readonly status: 'applied' | 'unsupported' | 'failed'
  readonly packId?: string
  readonly auditId?: string
  readonly error?: string
}

interface PendingPlan {
  readonly plan: SkillPlan
  readonly projectId: string
  readonly operatorSessionId: string
  readonly token: string
  readonly pack?: ValidPack
}

/** Input for {@link SkillAdminApi.plan}. */
export interface PlanInput {
  readonly projectId: string
  readonly operatorSessionId: string
  readonly kind?: 'install' | 'update' | 'remove'
  readonly url?: unknown
  readonly packId?: unknown
}

/** Input for {@link SkillAdminApi.apply}. */
export interface ApplyInput {
  readonly projectId: string
  readonly operatorSessionId: string
  readonly planId: string
  readonly token: string
  readonly action?: 'apply' | 'cancel'
}

/**
 * A skill-admin failure the caller can recover from: a stable `code` plus the single
 * corrective action in `remediation`. The message repeats the remediation so surfaces
 * that forward only `code` and `message` stay actionable.
 */
export class SkillAdminRecoveryError extends SkillIpcError {
  /**
   * @param code - stable failure code.
   * @param status - HTTP status the Host route replies with.
   * @param message - what failed, in user terms.
   * @param remediation - the action that recovers.
   */
  constructor(code: string, status: number, message: string, readonly remediation: string) {
    super(code, status, `${message}。处理方式：${remediation}`)
  }
}

/** Auditor and executor behind the skill-admin conversation. */
export class SkillAdminApi {
  private readonly api: SkillApi
  private readonly sessions: AdminSessionPort
  private readonly workspace: AdminWorkspacePort | undefined
  private readonly auditFile: string
  private readonly now: () => number
  private readonly skillsDir: string
  private readonly builtinDir: string | undefined
  private readonly pending = new Map<string, PendingPlan>()
  private readonly projects = new Map<string, string>()
  private readonly bindingsFile: string
  private bindingsLoaded = false
  private readonly db: DatabaseSync

  constructor(options: {
    readonly db: DatabaseSync
    readonly ledgerPath: string
    readonly skillsDir: string
    readonly builtinDir?: string
    readonly fetch?: typeof globalThis.fetch
    readonly sessions: AdminSessionPort
    readonly workspace?: AdminWorkspacePort
    readonly auditDir?: string
    readonly now?: () => number
    readonly runPackageCommand?: (args: readonly string[], timeoutMs: number) => Promise<PackageCommandResult>
  }) {
    this.db = options.db
    this.api = createSkillApi({
      db: options.db,
      ledgerPath: options.ledgerPath,
      skillsDir: options.skillsDir,
      ...(options.builtinDir === undefined ? {} : { builtinDir: options.builtinDir }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.runPackageCommand === undefined ? {} : { runPackageCommand: options.runPackageCommand }),
    })
    this.sessions = options.sessions
    this.workspace = options.workspace
    this.now = options.now ?? Date.now
    this.skillsDir = options.skillsDir
    this.builtinDir = options.builtinDir
    const auditDir = options.auditDir ?? join(homedir(), '.dsh', 'cadre-skill-admin')
    mkdirSync(auditDir, { recursive: true })
    this.auditFile = join(auditDir, 'audit.jsonl')
    this.bindingsFile = join(auditDir, 'sessions.json')
  }

  /** Catalog for an admin session's project. */
  async catalogFor(sessionId: string): Promise<ReturnType<SkillApi['catalog']>> {
    const projectId = await this.projectFor(sessionId)
    return this.api.catalog({ projectId, actorSessionId: this.operatorFor(projectId, sessionId) })
  }

  /**
   * Detail for an admin session's project, including the body the model may inspect.
   * Read from the pack directories so the admin preset does not borrow a roster role.
   */
  async previewFor(sessionId: string, packId: string): Promise<ReturnType<SkillApi['preview']>> {
    await this.projectFor(sessionId)
    const pack = this.packFor(packId)
    return {
      id: pack.id, content: pack.content, tokenEstimate: pack.tokenEstimate, license: pack.license,
      ...(pack.author === undefined ? {} : { author: pack.author }),
      ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
    }
  }

  /** Audit rows for an admin session's project. */
  async auditForSession(sessionId: string, limit?: number): Promise<readonly Record<string, unknown>[]> {
    await this.projectFor(sessionId)
    return this.readAudit(limit)
  }

  /** Plan for an admin session's project; the admin session acts as the operator. */
  async planForSession(sessionId: string, input: Omit<PlanInput, 'projectId' | 'operatorSessionId'>): Promise<SkillPlan> {
    const projectId = await this.projectFor(sessionId)
    return this.composePlan(projectId, this.operatorFor(projectId, sessionId), input)
  }

  /** Send one user message to an admin session; any project member may call. */
  async sendMessage(input: {
    readonly projectId: string; readonly actorSessionId: string; readonly sessionId: string; readonly text: string
  }): Promise<{ readonly accepted: true }> {
    this.api.assertMember({ projectId: input.projectId, actorSessionId: input.actorSessionId })
    await this.requireSession(input.projectId, input.sessionId)
    if (this.sessions.prompt === undefined) {
      throw new SkillIpcError('SKILL_ADMIN_MESSAGE_UNSUPPORTED', 501, '当前 Host 不支持发送技能管理员消息')
    }
    const text = input.text.trim()
    if (text === '') throw new SkillIpcError('SKILL_INVALID', 400, '消息不能为空')
    if (text.length > 20_000) throw new SkillIpcError('SKILL_INVALID', 400, '消息不能超过 20000 字')
    await this.sessions.prompt({ sessionId: input.sessionId, text })
    return { accepted: true }
  }

  /** Read messages after a sequence number; any project member may call. */
  async messages(input: {
    readonly projectId: string; readonly actorSessionId: string; readonly sessionId: string; readonly afterSeq: number
  }): Promise<AdminMessages> {
    this.api.assertMember({ projectId: input.projectId, actorSessionId: input.actorSessionId })
    await this.requireSession(input.projectId, input.sessionId)
    if (this.sessions.messages === undefined) {
      throw new SkillIpcError('SKILL_ADMIN_MESSAGE_UNSUPPORTED', 501, '当前 Host 不支持读取技能管理员消息')
    }
    return this.sessions.messages({ sessionId: input.sessionId, afterSeq: input.afterSeq })
  }

  /** Install by name/url/text from the preset tool, reusing the shared validators and audit. */
  async installForSession(sessionId: string, input: {
    readonly name?: unknown; readonly url?: unknown; readonly text?: unknown; readonly confirm?: unknown
  }): Promise<
    | { kind: 'package' | 'url'; target: string; installed: true; warnings: readonly InstallWarning[]; result: unknown }
    | {
      kind: 'package' | 'url'; target: string; installed: false; requiresConfirmation: true
      warnings: readonly InstallWarning[]; preview: unknown
    }
  > {
    const projectId = await this.projectFor(sessionId)
    const actorSessionId = this.operatorFor(projectId, sessionId)
    const provided = [input.name, input.url, input.text].filter(value => value !== undefined)
    if (provided.length !== 1) {
      throw new SkillIpcError('SKILL_INVALID', 400, 'name/url/text 必须且只能提供一个')
    }
    try {
      let result: Awaited<ReturnType<SkillAdminApi['installForSession']>>
      if (input.name !== undefined) {
        const installed = await this.api.installPackage({
          projectId, actorSessionId, name: input.name,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        })
        result = 'requiresConfirmation' in installed
          ? { kind: 'package', target: String(input.name), ...installed }
          : { kind: 'package', target: String(input.name), installed: true, warnings: installed.warnings, result: installed }
      } else if (input.url !== undefined) {
        const entry = await this.api.installUrl({
          projectId, actorSessionId, url: input.url,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        })
        result = 'requiresConfirmation' in entry
          ? { kind: 'url', target: String(input.url), ...entry }
          : {
            kind: 'url', target: String(input.url), installed: true,
            warnings: installWarnings(entry, { hasHash: true }), result: entry,
          }
      } else {
        const installed = await this.api.installAny({
          projectId, actorSessionId, text: input.text,
          ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
        })
        result = installed
      }
      if (result.installed) {
        this.audit({
          kind: 'tool-install', sessionId,
          target: result.kind === 'package' ? result.target : result.target.slice(0, 300),
          targetKind: result.kind, result: 'installed', warnings: result.warnings,
          ...(result.warnings.length === 0 ? {} : { confirmedBy: actorSessionId }),
        })
      } else {
        this.audit({
          kind: 'tool-install', sessionId,
          target: result.kind === 'package' ? result.target : result.target.slice(0, 300),
          targetKind: result.kind, result: 'confirmation-required', warnings: result.warnings,
        })
      }
      return result
    } catch (error) {
      this.audit({
        kind: 'tool-install', sessionId,
        result: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      })
      throw error
    }
  }

  /** Confirmation token for a plan created by an admin session. */
  async tokenForSession(sessionId: string, planId: string): Promise<string | undefined> {
    await this.projectFor(sessionId)
    return this.tokenFor(planId)
  }

  /** Create or list ordinary admin sessions; never writes a roster row. */
  async createSession(input: {
    readonly projectId: string; readonly cwd: string
  }): Promise<AdminSession> {
    this.requireProject(input.projectId)
    try {
      mkdirSync(input.cwd, { recursive: true })
    } catch (error) {
      throw new SkillIpcError('SKILL_ADMIN_CWD_FAILED', 500,
        `无法创建技能管理员工作目录：${error instanceof Error ? error.message : String(error)}`)
    }
    if (this.workspace === undefined) {
      throw new SkillIpcError('SKILL_ADMIN_WORKSPACE_UNAVAILABLE', 503, '当前 Host 没有 workspaceRegistry，无法注册技能管理员工作区')
    }
    let workspace
    try {
      workspace = await this.workspace.create(input.cwd, '技能管理员工作区（内部）')
    } catch (error) {
      throw new SkillIpcError('SKILL_ADMIN_WORKSPACE_FAILED', 500,
        `无法注册技能管理员工作区：${error instanceof Error ? error.message : String(error)}`)
    }
    const created = await this.sessions.create({ preset: SKILL_ADMIN_PRESET, cwd: workspace.path, title: '技能管理员' })
    try {
      await workspace.attachSession(created.sessionId)
    } catch (error) {
      throw new SkillIpcError('SKILL_ADMIN_WORKSPACE_ATTACH_FAILED', 500,
        `无法绑定技能管理员工作区：${error instanceof Error ? error.message : String(error)}`)
    }
    this.bind(created.sessionId, input.projectId)
    return {
      sessionId: created.sessionId, title: '技能管理员', updatedAt: this.now(),
      cwd: workspace.path, workspaceId: workspace.id,
    }
  }

  /** List admin sessions created for one project, including those of earlier Host runs. */
  async listSessions(input: { readonly projectId: string }): Promise<readonly AdminSession[]> {
    const sessions = await this.sessions.list({ preset: SKILL_ADMIN_PRESET })
    return sessions.filter(session => this.bindingOf(session.sessionId) === input.projectId)
  }

  async deleteSession(input: {
    readonly projectId: string; readonly sessionId: string
  }): Promise<{ deleted: true }> {
    if (this.sessions.delete === undefined) {
      throw new SkillIpcError('SKILL_ADMIN_DELETE_UNSUPPORTED', 501, '当前 Host 不支持删除会话')
    }
    if (this.bindingOf(input.sessionId) !== input.projectId) {
      throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
    }
    await this.sessions.delete({ sessionId: input.sessionId })
    this.unbind(input.sessionId)
    return { deleted: true }
  }

  /** Build a preview; this never writes the skill directory. */
  async plan(input: PlanInput): Promise<SkillPlan> {
    this.requireOperator(input.projectId, input.operatorSessionId)
    return this.composePlan(input.projectId, input.operatorSessionId, input)
  }

  /**
   * Build a preview for one project and operator without re-checking the roster role.
   * @param projectId - project the plan is scoped to.
   * @param operatorSessionId - session that will confirm the plan in `apply`.
   * @param input - requested action; `projectId` and `operatorSessionId` are ignored.
   * @returns the plan, already stashed with its confirmation token.
   */
  private async composePlan(
    projectId: string,
    operatorSessionId: string,
    input: Omit<PlanInput, 'projectId' | 'operatorSessionId'>,
  ): Promise<SkillPlan> {
    const kind = input.kind ?? 'install'
    if (kind === 'remove' || (kind === 'update' && input.url === undefined)) {
      return this.planLocal({ ...input, projectId, operatorSessionId }, kind)
    }
    if (input.url === undefined) throw new SkillIpcError('SKILL_URL_INVALID', 400, 'url 必填')
    let inspected
    try {
      inspected = await this.api.inspectUrl({
        projectId, actorSessionId: operatorSessionId, url: input.url,
      })
    } catch (error) {
      if (error instanceof SkillIpcError && ['SKILL_URL_INVALID', 'SKILL_URL_FETCH_FAILED', 'SKILL_INVALID', 'SKILL_TOO_LARGE'].includes(error.code)) {
        const planId = randomUUID()
        return {
          planId, kind: 'unsupported', packId: '', actions: [], riskFlags: [],
          summary: '该 URL 不是可确定性安装的技能包',
          reason: error.message, expiresAt: new Date(this.now() + 10 * 60_000).toISOString(),
        }
      }
      throw error
    }
    const pack = inspected.pack
    const planId = randomUUID()
    const plan: SkillPlan = {
      planId,
      kind,
      packId: pack.id,
      ...(input.url === undefined ? {} : { sourceUrl: String(input.url) }),
      ...(pack.author === undefined ? {} : { author: pack.author }),
      license: pack.license,
      contentHash: inspected.contentHash,
      targetDir: join(this.skillsDir, pack.id),
      actions: kind === 'update'
        ? ['download', 'verify-hash', 'backup', 'atomic-replace']
        : ['download', 'verify-hash', 'backup', 'atomic-rename'],
      riskFlags: [
        'untrusted-content',
        ...(kind === 'update' ? ['overwrite'] : []),
        ...(pack.author === undefined ? ['unknown-author'] : []),
        ...(pack.license === 'unknown' ? ['unknown-license'] : []),
      ],
      summary: `${kind === 'update' ? '更新' : '安装'} ${pack.id}（${pack.name}）到 ${join(this.skillsDir, pack.id)}`,
      expiresAt: new Date(this.now() + 10 * 60_000).toISOString(),
    }
    this.pending.set(planId, { plan, projectId, operatorSessionId, token: randomUUID(), pack })
    return plan
  }

  /** Execute a plan after the user confirms; validates operator again. */
  async apply(input: ApplyInput): Promise<ApplyResult> {
    this.requireOperator(input.projectId, input.operatorSessionId)
    const pending = this.pending.get(input.planId)
    if (pending === undefined) throw new SkillIpcError('SKILL_ADMIN_PLAN_NOT_FOUND', 404, '计划不存在或已使用')
    if (pending.projectId !== input.projectId || pending.operatorSessionId !== input.operatorSessionId) {
      throw new SkillIpcError('SKILL_ADMIN_FORBIDDEN', 403, '计划不属于当前操作者')
    }
    if (pending.token !== input.token) throw new SkillIpcError('SKILL_ADMIN_TOKEN_INVALID', 403, '确认令牌无效')
    if (Date.parse(pending.plan.expiresAt) <= this.now()) {
      this.pending.delete(input.planId)
      throw new SkillIpcError('SKILL_ADMIN_PLAN_EXPIRED', 409, '计划已过期')
    }
    this.pending.delete(input.planId)
    if (input.action === 'cancel') return { status: 'unsupported', packId: pending.plan.packId, error: 'cancelled' }
    try {
      if (pending.plan.kind === 'remove') {
        this.removeWithBackup(input.projectId, input.operatorSessionId, pending.plan)
      } else {
        const pack = pending.pack
        if (pack === undefined) throw new SkillIpcError('SKILL_ADMIN_PLAN_INVALID', 500, '计划缺少包内容')
        this.api.add({
          projectId: input.projectId,
          actorSessionId: input.operatorSessionId,
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
          overwrite: pending.plan.kind === 'update',
        })
      }
      this.audit({ ...pending.plan, operatorSessionId: input.operatorSessionId, result: 'applied' })
      return { status: 'applied', packId: pending.plan.packId, auditId: pending.plan.planId }
    } catch (error) {
      this.audit({
        ...pending.plan, operatorSessionId: input.operatorSessionId, result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return {
        status: 'failed', packId: pending.plan.packId, auditId: pending.plan.planId,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Read the append-only audit for this operator. */
  auditFor(input: { readonly projectId: string; readonly operatorSessionId: string; readonly limit?: number }): readonly Record<string, unknown>[] {
    this.requireOperator(input.projectId, input.operatorSessionId)
    return this.readAudit(input.limit)
  }

  /** Token for a freshly created plan, exposed only to the creating operator. */
  tokenFor(planId: string): string | undefined {
    return this.pending.get(planId)?.token
  }

  private planLocal(input: PlanInput, kind: 'remove' | 'update'): SkillPlan {
    const packId = typeof input.packId === 'string' ? input.packId : ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(packId)) throw new SkillIpcError('SKILL_INVALID', 400, 'packId 格式非法')
    const catalog = this.api.catalog({ projectId: input.projectId, actorSessionId: input.operatorSessionId })
    const pack = catalog.find(entry => entry.id === packId)
    if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 404, `未知技能包：${packId}`)
    if (kind === 'remove' && pack.origin === 'builtin') {
      throw new SkillIpcError('SKILL_BUILTIN_READONLY', 403, `内置技能包 ${packId} 不可删除`)
    }
    const planId = randomUUID()
    const plan: SkillPlan = {
      planId, kind, packId, targetDir: join(this.skillsDir, packId),
      ...(pack.author === undefined ? {} : { author: pack.author }),
      license: pack.license,
      actions: kind === 'remove' ? ['backup', 'atomic-remove'] : ['backup', 'atomic-replace'],
      riskFlags: kind === 'remove' ? ['destructive', 'overwrite'] : ['overwrite'],
      summary: `${kind === 'remove' ? '删除' : '更新'} ${packId}`,
      expiresAt: new Date(this.now() + 10 * 60_000).toISOString(),
    }
    this.pending.set(planId, {
      plan, projectId: input.projectId, operatorSessionId: input.operatorSessionId, token: randomUUID(),
    })
    return plan
  }

  private removeWithBackup(projectId: string, operatorSessionId: string, plan: SkillPlan): void {
    const target = join(this.skillsDir, plan.packId)
    if (!existsSync(target)) throw new SkillIpcError('SKILL_NOT_FOUND', 404, `未知技能包：${plan.packId}`)
    const backup = `${target}.backup-${plan.planId}`
    cpSync(target, backup, { recursive: true })
    try {
      this.api.remove({ projectId, actorSessionId: operatorSessionId, packId: plan.packId, confirm: true })
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      renameSync(backup, target)
      throw error
    }
  }

  private requireOperator(projectId: string, operatorSessionId: string): void {
    this.api.assertSupervisor({ projectId, actorSessionId: operatorSessionId })
  }

  private requireProject(projectId: string): void {
    if (this.ledgerProjects().includes(projectId)) return
    throw new SkillIpcError('SKILL_FORBIDDEN', 403, `未知项目：${projectId}`)
  }

  /**
   * Session id to attribute project-scoped skill calls to. A roster supervisor is preferred
   * because warning-bearing installs keep their confirmation authority; without one the
   * calling admin session acts, which the project-scoped skill API admits off-roster.
   * @param projectId - project the call is scoped to.
   * @param sessionId - calling admin session.
   * @returns a non-departed supervisor's session id, else the calling session id.
   */
  private operatorFor(projectId: string, sessionId: string): string {
    const row = this.db.prepare(
      "SELECT session_id FROM members WHERE project_id = ? AND state != 'departed' AND role = 'supervisor' ORDER BY session_id LIMIT 1",
    ).get(projectId) as { session_id?: unknown } | undefined
    return typeof row?.session_id === 'string' ? row.session_id : sessionId
  }

  /**
   * Resolve the project an admin tool call acts on, binding the session on first use when the
   * ledger makes that unambiguous. Bindings written by an earlier Host run win over recovery.
   * @param sessionId - calling session, which the admin preset scopes to skill administration.
   * @returns the project bound to the session.
   */
  private async projectFor(sessionId: string): Promise<string> {
    const bound = this.bindingOf(sessionId)
    if (bound !== undefined) return bound
    const recovered = await this.recoverBinding(sessionId)
    if (recovered !== undefined) return recovered
    throw new SkillAdminRecoveryError('SKILL_ADMIN_SESSION_NOT_FOUND', 404,
      '未知的技能管理员会话',
      this.ledgerProjects().length > 1
        ? '本项目存在多个项目，重新打开技能页并新建技能管理员会话，让会话重新绑定到项目'
        : '打开技能页新建技能管理员会话，让会话重新绑定到项目')
  }

  /**
   * Bind a still-unknown session to the ledger's only project, proving first that the Host
   * lists it as an admin-preset session so an arbitrary id cannot claim administration.
   * @param sessionId - session reported by the calling tool.
   * @returns the recovered project id, or undefined when recovery is not possible.
   */
  private async recoverBinding(sessionId: string): Promise<string | undefined> {
    const projects = this.ledgerProjects()
    const only = projects[0]
    if (projects.length !== 1 || only === undefined) return undefined
    let listed: boolean
    try {
      listed = (await this.sessions.list({ preset: SKILL_ADMIN_PRESET }))
        .some(session => session.sessionId === sessionId)
    } catch (error) {
      // Without a session store the preset scope cannot be checked, so recovery stays unavailable.
      console.error(`host-session-skills: cannot verify admin session for recovery: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    if (!listed) return undefined
    this.bind(sessionId, only)
    return only
  }

  /**
   * Projects the ledger still tracks, read from the schema the ledger provides. The `projects`
   * table is optional metadata that the shipped schema creates without rows, so the roster
   * contributes projects as well.
   * @returns non-archived project ids; empty when the ledger cannot be read.
   */
  private ledgerProjects(): string[] {
    const read = (sql: string): string[] => this.db.prepare(sql).all().flatMap(row => {
      const value = (row as { project_id?: unknown }).project_id
      return typeof value === 'string' && value !== '' ? [value] : []
    })
    const hasTable = (name: string): boolean => this.db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(name) !== undefined
    try {
      const roster = read('SELECT DISTINCT project_id FROM members')
      if (!hasTable('projects')) return roster
      let metadata: string[]
      try {
        metadata = read('SELECT project_id FROM projects WHERE archived_at IS NULL')
      } catch {
        // Older project tables carry no archive column, so every row still counts.
        metadata = read('SELECT project_id FROM projects')
      }
      return [...new Set([...metadata, ...roster])]
    } catch {
      // An unreadable ledger cannot prove which project a session belongs to.
      return []
    }
  }

  /**
   * Read one pack from the same builtin-over-installed catalog the skill IPC serves.
   * @param packId - catalog pack id.
   * @returns the pack, including its SKILL.md body.
   */
  private packFor(packId: string): SkillPack {
    const packs = new Map<string, SkillPack>()
    if (this.builtinDir !== undefined) {
      for (const [id, pack] of loadSkillCatalog(this.builtinDir, 'builtin')) packs.set(id, pack)
    }
    for (const [id, pack] of loadSkillCatalog(this.skillsDir, 'installed')) {
      if (!packs.has(id)) packs.set(id, pack)
    }
    const pack = packs.get(packId)
    if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 400, `未知技能包：${packId}`)
    return pack
  }

  private async requireSession(projectId: string, sessionId: string): Promise<void> {
    if (this.bindingOf(sessionId) !== projectId) {
      throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
    }
    const owned = (await this.sessions.list({ preset: SKILL_ADMIN_PRESET }))
      .some(session => session.sessionId === sessionId)
    if (!owned) throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
  }

  /**
   * Resolve a session's project, lazily reading the bindings file written by earlier Host runs.
   * Recovery is lazy so a Host that never touches skill administration performs no extra file IO.
   * @param sessionId - Ordinary session id reported by the Host.
   * @returns The bound project id, or undefined when this Host never bound the session.
   */
  private bindingOf(sessionId: string): string | undefined {
    const known = this.projects.get(sessionId)
    if (known !== undefined) return known
    this.loadBindings()
    return this.projects.get(sessionId)
  }

  /**
   * Read the persisted bindings once per instance, keeping bindings created or deleted in this
   * process authoritative over the file.
   */
  private loadBindings(): void {
    if (this.bindingsLoaded) return
    this.bindingsLoaded = true
    if (!existsSync(this.bindingsFile)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.bindingsFile, 'utf8'))
    } catch {
      // A truncated or hand-edited file only costs session recovery; the Host recreates bindings on demand.
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    for (const [sessionId, projectId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof projectId !== 'string' || projectId === '') continue
      if (!this.projects.has(sessionId)) this.projects.set(sessionId, projectId)
    }
  }

  /** Persist the whole binding map so a later Host run can resolve these sessions. */
  private saveBindings(): void {
    this.loadBindings()
    const sorted = [...this.projects.entries()].sort(([first], [second]) => first.localeCompare(second))
    const temporaryPath = `${this.bindingsFile}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, 'utf8')
      renameSync(temporaryPath, this.bindingsFile)
    } catch (error) {
      // Losing durability must not fail the user-visible operation that already succeeded.
      rmSync(temporaryPath, { force: true })
      console.error(`host-session-skills: cannot persist admin session bindings to ${this.bindingsFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Bind one admin session to its project and persist the binding. */
  private bind(sessionId: string, projectId: string): void {
    this.loadBindings()
    this.projects.set(sessionId, projectId)
    this.saveBindings()
  }

  /** Drop one admin session binding and persist the removal. */
  private unbind(sessionId: string): void {
    if (!this.projects.delete(sessionId)) return
    this.saveBindings()
  }

  private readAudit(limit?: number): readonly Record<string, unknown>[] {
    if (!existsSync(this.auditFile)) return []
    const lines = readFileSync(this.auditFile, 'utf8').split(/\r?\n/u).filter(line => line.trim() !== '')
    return lines.slice(-Math.min(limit ?? 50, 200)).flatMap(line => {
      try {
        const parsed: unknown = JSON.parse(line)
        return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
  }

  private audit(record: Record<string, unknown>): void {
    const line = JSON.stringify({
      time: new Date(this.now()).toISOString(),
      ...record,
    })
    appendFileSync(this.auditFile, `${line}\n`, 'utf8')
  }
}

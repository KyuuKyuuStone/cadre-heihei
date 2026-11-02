/**
 * Skill-admin conversation backend: ordinary sessions, read-only planning, and
 * confirmed execution through the existing skill IPC validators.
 * @module
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createSkillApi, SkillIpcError, type PackageCommandResult, type SkillApi, type ValidPack } from './ipc.ts'

/** The agent preset reserved for the skill administrator conversation. */
export const SKILL_ADMIN_PRESET = 'cadre-skill-admin'

/** One ordinary session created for the skill administrator. */
export interface AdminSession {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  /** Workspace directory ensured by createSession. */
  readonly cwd?: string
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

/** Auditor and executor behind the skill-admin conversation. */
export class SkillAdminApi {
  private readonly api: SkillApi
  private readonly sessions: AdminSessionPort
  private readonly auditFile: string
  private readonly now: () => number
  private readonly skillsDir: string
  private readonly pending = new Map<string, PendingPlan>()
  private readonly projects = new Map<string, string>()
  private readonly db: DatabaseSync

  constructor(options: {
    readonly db: DatabaseSync
    readonly ledgerPath: string
    readonly skillsDir: string
    readonly builtinDir?: string
    readonly fetch?: typeof globalThis.fetch
    readonly sessions: AdminSessionPort
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
    this.now = options.now ?? Date.now
    this.skillsDir = options.skillsDir
    const auditDir = options.auditDir ?? join(homedir(), '.dsh', 'cadre-skill-admin')
    mkdirSync(auditDir, { recursive: true })
    this.auditFile = join(auditDir, 'audit.jsonl')
  }

  /** Catalog for an admin session's project. */
  catalogFor(sessionId: string): ReturnType<SkillApi['catalog']> {
    const projectId = this.projectOf(sessionId)
    return this.api.catalog({ projectId, actorSessionId: this.actorFor(projectId) })
  }

  /** Detail for an admin session's project; includes the body the model may inspect. */
  previewFor(sessionId: string, packId: string): ReturnType<SkillApi['preview']> {
    const projectId = this.projectOf(sessionId)
    return this.api.preview({ projectId, actorSessionId: this.actorFor(projectId), packId })
  }

  /** Audit rows for an admin session's project. */
  auditForSession(sessionId: string, limit?: number): readonly Record<string, unknown>[] {
    this.projectOf(sessionId)
    return this.readAudit(limit)
  }

  /** Plan for an admin session's project. */
  async planForSession(sessionId: string, input: Omit<PlanInput, 'projectId' | 'operatorSessionId'>): Promise<SkillPlan> {
    const projectId = this.projectOf(sessionId)
    return this.plan({ projectId, operatorSessionId: this.actorFor(projectId), ...input })
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
    readonly name?: unknown; readonly url?: unknown; readonly text?: unknown
  }): Promise<{ kind: 'package' | 'url'; target: string; result: unknown }> {
    const projectId = this.projectOf(sessionId)
    const actorSessionId = this.actorFor(projectId)
    const provided = [input.name, input.url, input.text].filter(value => value !== undefined)
    if (provided.length !== 1) {
      throw new SkillIpcError('SKILL_INVALID', 400, 'name/url/text 必须且只能提供一个')
    }
    try {
      const result = input.name !== undefined
        ? { kind: 'package' as const, target: String(input.name), result: await this.api.installPackage({ projectId, actorSessionId, name: input.name }) }
        : input.url !== undefined
          ? { kind: 'url' as const, target: String(input.url), result: await this.api.installUrl({ projectId, actorSessionId, url: input.url }) }
          : await this.api.installAny({ projectId, actorSessionId, text: input.text })
      this.audit({
        kind: 'tool-install', sessionId,
        target: result.kind === 'package' ? result.target : result.target.slice(0, 300),
        targetKind: result.kind, result: 'installed',
      })
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
  tokenForSession(sessionId: string, planId: string): string | undefined {
    this.projectOf(sessionId)
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
    const created = await this.sessions.create({ preset: SKILL_ADMIN_PRESET, cwd: input.cwd, title: '技能管理员' })
    this.projects.set(created.sessionId, input.projectId)
    return { sessionId: created.sessionId, title: '技能管理员', updatedAt: this.now(), cwd: input.cwd }
  }

  /** List admin sessions created for one project in this Host process. */
  async listSessions(input: { readonly projectId: string }): Promise<readonly AdminSession[]> {
    const sessions = await this.sessions.list({ preset: SKILL_ADMIN_PRESET })
    return sessions.filter(session => this.projects.get(session.sessionId) === input.projectId)
  }

  async deleteSession(input: {
    readonly projectId: string; readonly sessionId: string
  }): Promise<{ deleted: true }> {
    if (this.sessions.delete === undefined) {
      throw new SkillIpcError('SKILL_ADMIN_DELETE_UNSUPPORTED', 501, '当前 Host 不支持删除会话')
    }
    if (this.projects.get(input.sessionId) !== input.projectId) {
      throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
    }
    await this.sessions.delete({ sessionId: input.sessionId })
    this.projects.delete(input.sessionId)
    return { deleted: true }
  }

  /** Build a preview; this never writes the skill directory. */
  async plan(input: PlanInput): Promise<SkillPlan> {
    this.requireOperator(input.projectId, input.operatorSessionId)
    const kind = input.kind ?? 'install'
    if (kind === 'remove' || (kind === 'update' && input.url === undefined)) {
      return this.planLocal(input, kind)
    }
    if (input.url === undefined) throw new SkillIpcError('SKILL_URL_INVALID', 400, 'url 必填')
    let inspected
    try {
      inspected = await this.api.inspectUrl({
        projectId: input.projectId, actorSessionId: input.operatorSessionId, url: input.url,
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
    this.pending.set(planId, {
      plan, projectId: input.projectId, operatorSessionId: input.operatorSessionId, token: randomUUID(), pack,
    })
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
    const row = this.db.prepare(
      "SELECT session_id FROM members WHERE project_id = ? AND state != 'departed' LIMIT 1",
    ).get(projectId) as { session_id?: unknown } | undefined
    if (row?.session_id === undefined) throw new SkillIpcError('SKILL_FORBIDDEN', 403, '本项目没有在册成员')
  }

  /** Pick a real roster member for project-scoped API calls; no supervisor requirement. */
  private actorFor(projectId: string): string {
    const row = this.db.prepare(
      "SELECT session_id FROM members WHERE project_id = ? AND state != 'departed' ORDER BY CASE role WHEN 'supervisor' THEN 0 ELSE 1 END, session_id LIMIT 1",
    ).get(projectId) as { session_id?: unknown } | undefined
    if (typeof row?.session_id !== 'string') throw new SkillIpcError('SKILL_FORBIDDEN', 403, '本项目没有在册成员')
    return row.session_id
  }

  private projectOf(sessionId: string): string {
    const projectId = this.projects.get(sessionId)
    if (projectId === undefined) throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
    return projectId
  }

  private async requireSession(projectId: string, sessionId: string): Promise<void> {
    if (this.projects.get(sessionId) !== projectId) {
      throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
    }
    const owned = (await this.sessions.list({ preset: SKILL_ADMIN_PRESET }))
      .some(session => session.sessionId === sessionId)
    if (!owned) throw new SkillIpcError('SKILL_ADMIN_SESSION_NOT_FOUND', 404, '未知的技能管理员会话')
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

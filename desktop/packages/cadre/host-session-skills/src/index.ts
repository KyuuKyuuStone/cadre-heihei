/**
 * Per-session Cadre skill packs. The roster row selects `skills[]`; only those
 * packs are registered into the agent's skill scope, and a change disposes the
 * previous registration. Unselected sessions register nothing.
 * @module @deepseek-ai/dsh-host-session-skills
 */
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadSkillCatalog, type SkillPack } from './catalog.ts'
import { createSkillApi, SkillIpcError } from './ipc.ts'
import { SkillAdminApi, type AdminSession, type AdminSessionPort } from './admin.ts'

export interface Config {
  /** Disable the plugin while keeping the row mounted. */
  readonly enabled?: boolean
  /** Installed catalog root; defaults to `CADRE_SKILLS_DIR` or `~/.dsh/cadre-skills`. */
  readonly skillsDir?: string
  /** Read-only builtin root; defaults to `CADRE_BUILTIN_SKILLS_DIR` or the repo directory. */
  readonly builtinDir?: string
  /** Ledger path; defaults to `CADRE_LEDGER_PATH`. */
  readonly ledgerPath?: string
  /** Audit directory; defaults to `~/.dsh/cadre-skill-admin`. */
  readonly skillAdminAuditDir?: string
}

interface AgentLike {
  readonly id: string
  readonly ctx: { readonly skills: { register(skill: RegisteredSkill): () => void } }
}
interface RegisteredSkill {
  readonly name: string
  readonly description: string
  readonly source: 'runtime'
  readonly path: string
  readonly content: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}
interface HostContext {
  on(event: string, handler: (payload: { readonly agent?: AgentLike }, next: () => Promise<unknown>) => unknown): () => void
  effect(setup: () => () => void): void
  inject?(dependencies: readonly string[], callback: (scope: unknown) => void): void
  get?(name: string): unknown
}
interface Membership {
  readonly role: string
  readonly state: string
  readonly skills: readonly string[]
}

function membership(db: DatabaseSync, sessionId: string): Membership | undefined {
  const row = db.prepare('SELECT role, state, skills_json FROM members WHERE session_id = ? LIMIT 1')
    .get(sessionId) as { role?: unknown; state?: unknown; skills_json?: unknown } | undefined
  if (row === undefined) return undefined
  let skills: string[] = []
  try {
    const parsed: unknown = JSON.parse(String(row.skills_json ?? '[]'))
    if (Array.isArray(parsed)) skills = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // A corrupt selection is treated as empty; the plugin never blocks the step.
  }
  return { role: String(row.role), state: String(row.state), skills }
}

/**
 * Bind the Host session controller to the narrow port the admin API needs.
 * Sessions remain ordinary; this adapter only filters by the admin preset.
 * @param ctx - Host context that may expose `sessionController`.
 * @returns the port, or undefined when no controller is mounted.
 */
function adminSessionPort(ctx: HostContext): AdminSessionPort | undefined {
  const controller = ctx.get?.('sessionController') as {
    create(request: { readonly cwd: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: string }>
    list(request: Record<string, never>): Promise<{
      readonly items: readonly {
        readonly sessionId: string
        readonly updatedAt: number
        readonly projections?: { readonly values?: Readonly<Record<string, unknown>> }
      }[]
    }>
  } | undefined
  if (controller === undefined) return undefined
  return {
    create: async input => {
      const created = await controller.create({ cwd: input.cwd, agentPreset: input.preset })
      return { sessionId: created.sessionId }
    },
    list: async input => {
      const listed = await controller.list({})
      return listed.items.flatMap((item): AdminSession[] => {
        if (item.projections?.values?.agentPreset !== input.preset) return []
        return [{ sessionId: item.sessionId, title: '技能管理员', updatedAt: item.updatedAt }]
      })
    },
  }
}

/**
 * Register exactly the roster-selected skill packs for each agent.
 * @param ctx - Host context with `agent/pre-step`.
 * @param config - optional disable/catalog/ledger overrides.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const ledgerPath = config.ledgerPath ?? process.env.CADRE_LEDGER_PATH?.trim()
  if (ledgerPath === undefined || ledgerPath === '') {
    console.error('host-session-skills: CADRE_LEDGER_PATH is unset; no skill packs registered')
    return
  }
  const skillsDir = config.skillsDir
    ?? process.env.CADRE_SKILLS_DIR?.trim()
    ?? join(homedir(), '.dsh', 'cadre-skills')
  if (skillsDir === '') {
    console.error('host-session-skills: CADRE_SKILLS_DIR is empty; no skill packs registered')
    return
  }
  const builtinDir = config.builtinDir
    ?? process.env.CADRE_BUILTIN_SKILLS_DIR?.trim()
    ?? fileURLToPath(new URL('../builtin-skills/', import.meta.url))
  const mergedCatalog = (): ReadonlyMap<string, SkillPack> => {
    const merged = new Map<string, SkillPack>()
    for (const [id, pack] of loadSkillCatalog(builtinDir, 'builtin')) merged.set(id, pack)
    for (const [id, pack] of loadSkillCatalog(skillsDir, 'installed')) {
      if (!merged.has(id)) merged.set(id, pack)
    }
    return merged
  }
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  const registered = new Map<string, Map<string, { dispose: () => void; content: string }>>()

  const clear = (agentId: string): void => {
    const entries = registered.get(agentId)
    if (entries === undefined) return
    for (const entry of entries.values()) entry.dispose()
    registered.delete(agentId)
  }

  const listener = async (
    payload: { readonly agent?: AgentLike },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const agent = payload.agent
    if (agent === undefined) return next()
    let member: Membership | undefined
    try {
      member = membership(db, agent.id)
    } catch (error) {
      console.error(`host-session-skills: member read failed agent=${agent.id}: ${String(error)}`)
      return next()
    }
    if (member === undefined || member.state === 'departed' || member.skills.length === 0) {
      clear(agent.id)
      return next()
    }
    let catalog: ReadonlyMap<string, SkillPack>
    try {
      catalog = mergedCatalog()
    } catch (error) {
      console.error(`host-session-skills: catalog load failed: ${String(error)}`)
      return next()
    }
    const selected = [...new Set(member.skills)]
    const current = registered.get(agent.id) ?? new Map<string, { dispose: () => void; content: string }>()
    for (const [id, entry] of current) {
      const pack = catalog.get(id)
      if (pack === undefined || !selected.includes(id) || !pack.roles.includes(member.role as 'supervisor' | 'worker')) {
        entry.dispose()
        current.delete(id)
      }
    }
    for (const id of selected) {
      const pack = catalog.get(id)
      if (pack === undefined) {
        console.error(`host-session-skills: unknown skill pack ${id} for agent=${agent.id}`)
        continue
      }
      if (!pack.roles.includes(member.role as 'supervisor' | 'worker')) {
        console.error(`host-session-skills: role ${member.role} cannot load skill pack ${id}`)
        continue
      }
      const existing = current.get(id)
      if (existing !== undefined && existing.content === pack.content) continue
      existing?.dispose()
      try {
        const dispose = agent.ctx.skills.register({
          name: pack.name,
          description: pack.description,
          source: 'runtime',
          path: pack.path,
          content: pack.content,
          metadata: {
            id: pack.id,
            roles: pack.roles,
            tokenEstimate: pack.tokenEstimate,
            tools: pack.tools,
            source: pack.source,
            license: pack.license,
            origin: pack.origin,
            plugin: 'host-session-skills',
          },
          invocation: { modelInvocable: true, userInvocable: true },
        })
        current.set(id, { dispose, content: pack.content })
      } catch (error) {
        console.error(`host-session-skills: register failed agent=${agent.id} pack=${id}: ${String(error)}`)
      }
    }
    if (current.size === 0) registered.delete(agent.id)
    else registered.set(agent.id, current)
    return next()
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scope) => {
      const web = scope as {
        webServer: { register(route: {
          kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
        }): () => void }
        connection: { admit(req: IncomingMessage): { readonly rejection: number } | unknown }
        effect(setup: () => () => void, label: string): () => void
      }
      const api = createSkillApi({ db, ledgerPath, skillsDir, builtinDir })
      const sessionPort = adminSessionPort(ctx)
      const admin = sessionPort === undefined ? undefined : new SkillAdminApi({
        db, ledgerPath, skillsDir, builtinDir,
        ...(config.skillAdminAuditDir === undefined ? {} : { auditDir: config.skillAdminAuditDir }),
        sessions: sessionPort,
      })
      const requireAdmin = (): SkillAdminApi => {
        if (admin === undefined) {
          throw new SkillIpcError('SKILL_ADMIN_UNAVAILABLE', 503, '当前 Host 没有 sessionController，技能管理员不可用')
        }
        return admin
      }
      const reply = (res: ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
          size += buffer.length
          if (size > 16_384) throw new Error('请求体过大')
          chunks.push(buffer)
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体必须是对象')
        return parsed as Record<string, unknown>
      }
      const required = (body: Record<string, unknown>, name: string): string => {
        if (typeof body[name] !== 'string' || body[name] === '') throw new SkillIpcError('SKILL_INVALID', 400, `${name} 必填`)
        return body[name] as string
      }
      const route = (path: string, operation: (body: Record<string, unknown>) => unknown): void => {
        web.effect(() => web.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' })
            const admission = web.connection.admit(req)
            if (typeof admission === 'object' && admission !== null && 'rejection' in admission) {
              return reply(res, (admission as { rejection: number }).rejection, { ok: false, code: 'FORBIDDEN', message: '未授权' })
            }
            try {
              reply(res, 200, { ok: true, result: await operation(await readBody(req)) })
            } catch (error) {
              if (error instanceof SkillIpcError) return reply(res, error.status, { ok: false, code: error.code, message: error.message })
              reply(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) })
            }
          },
        }), `host-session-skills: ${path}`)
      }
      route('/cadre/skills/catalog', body => api.catalog({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        ...(typeof body.targetSessionId === 'string' ? { targetSessionId: body.targetSessionId } : {}),
        ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
      }))
      route('/cadre/skills/get', body => api.get({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        targetSessionId: required(body, 'targetSessionId'),
      }))
      route('/cadre/skills/set', body => api.set({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        targetSessionId: required(body, 'targetSessionId'),
        skills: body.skills,
      }))
      route('/cadre/skills/preview', body => api.preview({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        packId: required(body, 'packId'),
      }))
      route('/cadre/skills/add', body => api.add({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        id: body.id,
        name: body.name,
        description: body.description,
        descriptionI18n: body.descriptionI18n,
        author: body.author,
        homepage: body.homepage,
        roles: body.roles,
        tokenEstimate: body.tokenEstimate,
        tools: body.tools,
        source: body.source,
        license: body.license,
        content: body.content,
        ...(body.overwrite === undefined ? {} : { overwrite: body.overwrite }),
      }))
      route('/cadre/skills/remove', body => api.remove({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        packId: required(body, 'packId'),
        confirm: body.confirm,
      }))
      route('/cadre/skills/install-url', body => api.installUrl({
        projectId: required(body, 'projectId'),
        actorSessionId: required(body, 'actorSessionId'),
        url: body.url,
        ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
      }))
      route('/cadre/skills/admin/session', async body => {
        const cwd = typeof body.cwd === 'string' && body.cwd !== ''
          ? body.cwd : join(homedir(), '.dsh', 'cadre-skill-admin', 'workspace')
        mkdirSync(cwd, { recursive: true })
        return requireAdmin().createSession({
          projectId: required(body, 'projectId'),
          operatorSessionId: required(body, 'operatorSessionId'),
          cwd,
        })
      })
      route('/cadre/skills/admin/sessions', body => requireAdmin().listSessions({
        projectId: required(body, 'projectId'),
        operatorSessionId: required(body, 'operatorSessionId'),
      }))
      route('/cadre/skills/admin/delete-session', body => requireAdmin().deleteSession({
        projectId: required(body, 'projectId'),
        operatorSessionId: required(body, 'operatorSessionId'),
        sessionId: required(body, 'sessionId'),
      }))
      route('/cadre/skills/admin/plan', async body => {
        const plan = await requireAdmin().plan({
          projectId: required(body, 'projectId'),
          operatorSessionId: required(body, 'operatorSessionId'),
          ...(body.kind === 'install' || body.kind === 'update' || body.kind === 'remove' ? { kind: body.kind } : {}),
          ...(body.url === undefined ? {} : { url: body.url }),
          ...(body.packId === undefined ? {} : { packId: body.packId }),
        })
        const token = requireAdmin().tokenFor(plan.planId)
        return { ...plan, ...(token === undefined ? {} : { confirmToken: token }) }
      })
      route('/cadre/skills/admin/apply', body => requireAdmin().apply({
        projectId: required(body, 'projectId'),
        operatorSessionId: required(body, 'operatorSessionId'),
        planId: required(body, 'planId'),
        token: required(body, 'token'),
        ...(body.action === 'cancel' ? { action: 'cancel' as const } : {}),
      }))
      route('/cadre/skills/admin/audit', body => requireAdmin().auditFor({
        projectId: required(body, 'projectId'),
        operatorSessionId: required(body, 'operatorSessionId'),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      }))
    })
  }

  ctx.on('agent/pre-step', listener)
  ctx.effect(() => () => {
    for (const agentId of [...registered.keys()]) clear(agentId)
    db.close()
  })
}

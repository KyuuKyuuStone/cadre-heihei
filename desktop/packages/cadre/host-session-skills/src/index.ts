/**
 * Per-session Cadre skill packs. The roster row selects `skills[]`; only those
 * packs are registered into the agent's skill scope, and a change disposes the
 * previous registration. Unselected sessions register nothing.
 * @module @deepseek-ai/dsh-host-session-skills
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadSkillCatalog, type SkillPack } from './catalog.ts'

export interface Config {
  /** Disable the plugin while keeping the row mounted. */
  readonly enabled?: boolean
  /** Catalog root; defaults to `CADRE_SKILLS_DIR` or `~/.dsh/cadre-skills`. */
  readonly skillsDir?: string
  /** Ledger path; defaults to `CADRE_LEDGER_PATH`. */
  readonly ledgerPath?: string
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
      catalog = loadSkillCatalog(skillsDir)
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

  ctx.on('agent/pre-step', listener)
  ctx.effect(() => () => {
    for (const agentId of [...registered.keys()]) clear(agentId)
    db.close()
  })
}

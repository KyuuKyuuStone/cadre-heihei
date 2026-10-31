/**
 * Supervisor-only Cadre Skill registration.
 *
 * The Skill body lives in `skills/cadre-supervisor/SKILL.md`; this plugin only
 * resolves the roster role and registers it in that agent's skill scope.
 * @module @deepseek-ai/dsh-host-supervisor-skill
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export interface Config {
  /** Disable registration while keeping the row mounted. */
  readonly enabled?: boolean
  /** Override the bundled SKILL.md path. */
  readonly skillPath?: string
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

interface SkillFile {
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly content: string
}

function parseSkill(text: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text)
  if (match === null) throw new Error('SKILL.md frontmatter is missing')
  const front = match[1] ?? ''
  const body = match[2] ?? ''
  const field = (name: string): string | undefined => {
    const line = new RegExp(`^${name}:\\s*(.+)$`, 'mu').exec(front)
    return line?.[1]?.trim()
  }
  const name = field('name')
  const description = field('description')
  const version = field('version')
  if (name === undefined || description === undefined) throw new Error('SKILL.md needs name and description')
  return { name, description, ...(version === undefined ? {} : { version }), content: body }
}

/**
 * Register the supervisor Skill for exactly the supervisor agents.
 * @param ctx - Host context with the agent pre-step event.
 * @param config - optional disable/path overrides.
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  if (config.enabled === false) return
  const ledgerPath = process.env.CADRE_LEDGER_PATH?.trim()
  if (ledgerPath === undefined || ledgerPath === '') {
    console.error('host-supervisor-skill: CADRE_LEDGER_PATH is unset; Skill is not registered')
    return
  }
  const skillPath = config.skillPath ?? fileURLToPath(new URL('../skills/cadre-supervisor/SKILL.md', import.meta.url))
  let skill: SkillFile
  try {
    skill = parseSkill(readFileSync(skillPath, 'utf8'))
  } catch (error) {
    console.error(`host-supervisor-skill: cannot load ${skillPath}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const db = new DatabaseSync(ledgerPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  const registered = new Map<string, { readonly dispose: () => void; readonly role: string }>()

  const roleOf = (sessionId: string): { role: string; state: string } | undefined => {
    try {
      const row = db.prepare('SELECT role, state FROM members WHERE session_id = ? LIMIT 1')
        .get(sessionId) as { role?: unknown; state?: unknown } | undefined
      return row === undefined ? undefined : { role: String(row.role), state: String(row.state) }
    } catch {
      return undefined
    }
  }

  const listener = async (
    payload: { readonly agent?: AgentLike },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const agent = payload.agent
    if (agent === undefined) return next()
    const member = roleOf(agent.id)
    const supervisor = member?.role === 'supervisor' && member.state !== 'departed'
    const existing = registered.get(agent.id)
    if (!supervisor) {
      if (existing !== undefined) {
        existing.dispose()
        registered.delete(agent.id)
      }
      return next()
    }
    if (existing !== undefined) return next()
    try {
      const dispose = agent.ctx.skills.register({
        name: skill.name,
        description: skill.description,
        source: 'runtime',
        path: skillPath,
        content: skill.content,
        metadata: {
          ...(skill.version === undefined ? {} : { version: skill.version }),
          roles: ['supervisor'],
          plugin: 'host-supervisor-skill',
        },
        invocation: { modelInvocable: true, userInvocable: true },
      })
      registered.set(agent.id, { dispose, role: member.role })
    } catch (error) {
      console.error(`host-supervisor-skill: register failed agent=${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }

  ctx.on('agent/pre-step', listener)
  ctx.effect(() => () => {
    for (const entry of registered.values()) entry.dispose()
    registered.clear()
    db.close()
  })
}

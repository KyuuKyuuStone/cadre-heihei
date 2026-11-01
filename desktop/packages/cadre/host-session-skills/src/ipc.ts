/**
 * Supervisor-only data operations behind the future skill settings UI.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { loadSkillCatalog, type SkillPack } from './catalog.ts'

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
  readonly roles: readonly string[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly selected: boolean
}

export interface SkillApi {
  catalog(input: { projectId: string; actorSessionId: string; targetSessionId?: string }): CatalogEntry[]
  get(input: { projectId: string; actorSessionId: string; targetSessionId: string }): { skills: string[] }
  set(input: { projectId: string; actorSessionId: string; targetSessionId: string; skills: unknown }): { skills: string[] }
  preview(input: { projectId: string; actorSessionId: string; packId: string }): {
    id: string; content: string; tokenEstimate: number; license: string
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

function readMember(db: DatabaseSync, projectId: string, sessionId: string): MemberRow | undefined {
  const row = db.prepare('SELECT role, state, skills_json FROM members WHERE project_id = ? AND session_id = ? LIMIT 1')
    .get(projectId, sessionId) as { role?: unknown; state?: unknown; skills_json?: unknown } | undefined
  if (row === undefined) return undefined
  return { role: String(row.role), state: String(row.state), skills: parseSkills(row.skills_json) }
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
  if (member === undefined) throw new SkillIpcError('SKILL_MEMBER_NOT_FOUND', 404, '目标成员不在本项目')
  return member
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
}): SkillApi {
  const { db, ledgerPath, skillsDir } = options
  const catalog = (): ReadonlyMap<string, SkillPack> => loadSkillCatalog(skillsDir)
  const packOf = (id: string): SkillPack => {
    const pack = catalog().get(id)
    if (pack === undefined) throw new SkillIpcError('SKILL_NOT_FOUND', 400, `未知技能包：${id}`)
    return pack
  }

  return {
    catalog(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const target = input.targetSessionId ?? input.actorSessionId
      const selected = new Set(requireMember(db, input.projectId, target).skills)
      return [...catalog().values()].map(pack => ({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        roles: pack.roles,
        tokenEstimate: pack.tokenEstimate,
        tools: pack.tools,
        source: pack.source,
        license: pack.license,
        selected: selected.has(pack.id),
      }))
    },
    get(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      return { skills: [...requireMember(db, input.projectId, input.targetSessionId).skills] }
    },
    set(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const target = requireMember(db, input.projectId, input.targetSessionId)
      if (!Array.isArray(input.skills) || input.skills.some(item => typeof item !== 'string')) {
        throw new SkillIpcError('SKILL_INVALID', 400, 'skills 必须是字符串数组')
      }
      const selected = [...new Set(input.skills as string[])]
      for (const id of selected) {
        const pack = packOf(id)
        if (!pack.roles.includes(target.role as 'supervisor' | 'worker')) {
          throw new SkillIpcError('SKILL_ROLE_MISMATCH', 403, `角色 ${target.role} 不能加载技能包 ${id}`)
        }
      }
      const writer = new DatabaseSync(ledgerPath)
      try {
        writer.prepare('UPDATE members SET skills_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ?')
          .run(JSON.stringify(selected), new Date().toISOString(), input.projectId, input.targetSessionId)
      } finally {
        writer.close()
      }
      return { skills: selected }
    },
    preview(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const pack = packOf(input.packId)
      return { id: pack.id, content: pack.content, tokenEstimate: pack.tokenEstimate, license: pack.license }
    },
  }
}

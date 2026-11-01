/**
 * Supervisor-only data operations behind the future skill settings UI.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
  add(input: AddSkillInput): CatalogEntry
  remove(input: { projectId: string; actorSessionId: string; packId: string; confirm: unknown }): { removed: true }
}

/** Manifest + body supplied by the manual-add dialog. */
export interface AddSkillInput {
  readonly projectId: string
  readonly actorSessionId: string
  readonly id: unknown
  readonly name: unknown
  readonly description: unknown
  readonly roles: unknown
  readonly tokenEstimate: unknown
  readonly tools: unknown
  readonly source: unknown
  readonly license: unknown
  readonly content: unknown
  readonly overwrite?: unknown
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const ROLES = new Set(['supervisor', 'worker'])

interface ValidPack {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly roles: readonly ('supervisor' | 'worker')[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly content: string
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new SkillIpcError('SKILL_INVALID', 400, `${field} 必填`)
  return value
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
  return {
    id,
    name: requiredString(input.name, 'name'),
    description: requiredString(input.description, 'description'),
    roles: [...new Set(roles)] as ('supervisor' | 'worker')[],
    tokenEstimate,
    tools: [...new Set(input.tools as string[])],
    source: requiredString(input.source, 'source'),
    license: requiredString(input.license, 'license'),
    content,
  }
}

function entryOf(pack: SkillPack, selected = false): CatalogEntry {
  return {
    id: pack.id, name: pack.name, description: pack.description, roles: pack.roles,
    tokenEstimate: pack.tokenEstimate, tools: pack.tools, source: pack.source, license: pack.license, selected,
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
      return [...catalog().values()].map(pack => entryOf(pack, selected.has(pack.id)))
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
    preview(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const pack = packOf(input.packId)
      return { id: pack.id, content: pack.content, tokenEstimate: pack.tokenEstimate, license: pack.license }
    },
    add(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const pack = validatePack(input)
      const target = join(skillsDir, pack.id)
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
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const id = requiredString(input.packId, 'packId')
      if (!KEBAB_ID.test(id) || id.length > 64) throw new SkillIpcError('SKILL_INVALID', 400, 'packId 格式非法')
      if (input.confirm !== true) throw new SkillIpcError('SKILL_INVALID', 400, '删除技能包需要 confirm:true')
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
  }
}

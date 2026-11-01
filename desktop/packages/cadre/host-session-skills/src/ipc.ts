/**
 * Supervisor-only data operations behind the future skill settings UI.
 * @module
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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

export interface SkillApi {
  catalog(input: { projectId: string; actorSessionId: string; targetSessionId?: string; locale?: string }): CatalogEntry[]
  get(input: { projectId: string; actorSessionId: string; targetSessionId: string }): { skills: string[] }
  set(input: { projectId: string; actorSessionId: string; targetSessionId: string; skills: unknown }): { skills: string[] }
  preview(input: { projectId: string; actorSessionId: string; packId: string }): {
    id: string; content: string; tokenEstimate: number; license: string
    author?: string; homepage?: string
  }
  add(input: AddSkillInput): CatalogEntry
  remove(input: { projectId: string; actorSessionId: string; packId: string; confirm: unknown }): { removed: true }
  installUrl(input: {
    projectId: string; actorSessionId: string; url: unknown; confirm?: unknown
  }): Promise<CatalogEntry>
}

/** Manifest + body supplied by the manual-add dialog. */
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
const ROLES = new Set(['supervisor', 'worker'])

interface ValidPack {
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
  readonly builtinDir?: string
  /** Injection seam for URL installs. */
  readonly fetch?: typeof globalThis.fetch
}): SkillApi {
  const { db, ledgerPath, skillsDir, builtinDir } = options
  const doFetch = options.fetch ?? globalThis.fetch
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
      requireSupervisor(db, input.projectId, input.actorSessionId)
      const target = input.targetSessionId ?? input.actorSessionId
      const selected = new Set(requireMember(db, input.projectId, target).skills)
      return [...catalog().values()].map(pack => entryOf(pack, selected.has(pack.id), input.locale))
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
      return {
        id: pack.id, content: pack.content, tokenEstimate: pack.tokenEstimate, license: pack.license,
        ...(pack.author === undefined ? {} : { author: pack.author }),
        ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
      }
    },
    add(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
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
      requireSupervisor(db, input.projectId, input.actorSessionId)
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
    async installUrl(input) {
      requireSupervisor(db, input.projectId, input.actorSessionId)
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
      return this.add({
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
        overwrite: input.confirm === true,
      })
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

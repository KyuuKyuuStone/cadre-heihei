/** Skill pack catalog shared by the Host plugin and its tests. @module */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Where a pack came from; builtin packs are read-only. */
export type SkillOrigin = 'builtin' | 'installed'

/** One on-disk skill pack. */
export interface SkillPack {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly descriptionI18n?: { readonly zh?: string; readonly en?: string }
  /** Optional upstream author attribution. */
  readonly author?: string
  /** Optional credential-free https upstream/home page. */
  readonly homepage?: string
  readonly origin: SkillOrigin
  readonly roles: readonly ('supervisor' | 'worker')[]
  readonly tokenEstimate: number
  readonly tools: readonly string[]
  readonly source: string
  readonly license: string
  readonly path: string
  readonly content: string
}

/** Manifest fields; `SKILL.md` carries the model-visible body. */
interface Manifest {
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly descriptionI18n?: unknown
  readonly author?: unknown
  readonly homepage?: unknown
  readonly roles?: unknown
  readonly tokenEstimate?: unknown
  readonly tools?: unknown
  readonly source?: unknown
  readonly license?: unknown
}

function descriptionI18n(value: unknown): { zh?: string; en?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const result: { zh?: string; en?: string } = {}
  if (typeof record.zh === 'string' && record.zh.trim() !== '') result.zh = record.zh
  if (typeof record.en === 'string' && record.en.trim() !== '') result.en = record.en
  return result.zh === undefined && result.en === undefined ? undefined : result
}

/** Pick a localized description, falling back to the base field. */
export function localizedDescription(pack: SkillPack, locale: string | undefined): string {
  const language = locale?.toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
  return pack.descriptionI18n?.[language] ?? pack.description
}

function stringArray(value: unknown, fallback: readonly string[] = []): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
}

function parsePack(directory: string, origin: SkillOrigin): SkillPack {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest
  for (const field of ['id', 'name', 'description', 'source', 'license'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      throw new Error(`skill pack ${directory}: ${field} must be a non-empty string`)
    }
  }
  const roles = stringArray(manifest.roles).filter((role): role is 'supervisor' | 'worker' => role === 'supervisor' || role === 'worker')
  if (roles.length === 0) throw new Error(`skill pack ${directory}: roles must contain supervisor/worker`)
  const tokenEstimate = typeof manifest.tokenEstimate === 'number' && Number.isFinite(manifest.tokenEstimate) && manifest.tokenEstimate >= 0
    ? manifest.tokenEstimate : 0
  const i18n = descriptionI18n(manifest.descriptionI18n)
  const author = typeof manifest.author === 'string' && manifest.author.trim() !== '' ? manifest.author.trim() : undefined
  let homepage: string | undefined
  if (typeof manifest.homepage === 'string' && manifest.homepage.trim() !== '') {
    let parsed: URL
    try {
      parsed = new URL(manifest.homepage)
    } catch {
      throw new Error(`skill pack ${directory}: homepage must be an https URL`)
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new Error(`skill pack ${directory}: homepage must be a credential-free https URL`)
    }
    homepage = manifest.homepage
  }
  return {
    id: manifest.id as string,
    name: manifest.name as string,
    description: manifest.description as string,
    ...(i18n === undefined ? {} : { descriptionI18n: i18n }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    origin,
    roles,
    tokenEstimate,
    tools: stringArray(manifest.tools),
    source: manifest.source as string,
    license: manifest.license as string,
    path: join(directory, 'SKILL.md'),
    content: readFileSync(join(directory, 'SKILL.md'), 'utf8'),
  }
}

/**
 * Scan one pack per immediate child directory, `manifest.json` + `SKILL.md`.
 * Also scans `@scope/<pack>` containers whose pack carries only a frontmatter
 * `SKILL.md` (SkillHub layout). Missing directories produce an empty catalog;
 * duplicate ids keep the first pack in scan order and log a warning.
 * @param directory - catalog root.
 * @param origin - builtin or installed; copied onto every pack.
 * @returns pack id → pack.
 */
export function loadSkillCatalog(directory: string, origin: SkillOrigin = 'installed'): ReadonlyMap<string, SkillPack> {
  const catalog = new Map<string, SkillPack>()
  const add = (directory: string, scope: string | undefined, source: string): void => {
    let pack: SkillPack
    try {
      pack = loadPack(directory, origin, scope, source)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return
      if (existsSync(join(directory, 'manifest.json'))) throw error
      console.warn(`host-session-skills: skipping invalid SKILL.md in ${directory}: ${String(error)}`)
      return
    }
    if (catalog.has(pack.id)) {
      console.warn(`host-session-skills: duplicate skill id ${pack.id} at ${directory}; keeping ${catalog.get(pack.id)?.path ?? ''}`)
      return
    }
    catalog.set(pack.id, pack)
  }
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') return catalog
    throw error
  }
  for (const name of entries) {
    const path = join(directory, name)
    if (!statSync(path).isDirectory()) continue
    if (existsSync(join(path, 'manifest.json')) || existsSync(join(path, 'SKILL.md'))) {
      add(path, undefined, `local:${name}`)
      continue
    }
    if (!name.startsWith('@')) continue
    const scope = name.slice(1)
    let children: string[]
    try {
      children = readdirSync(path)
    } catch {
      continue
    }
    for (const child of children) {
      const nested = join(path, child)
      if (!statSync(nested).isDirectory()) continue
      if (!existsSync(join(nested, 'SKILL.md'))) continue
      add(nested, scope, `skillhub:${name}/${child}`)
    }
  }
  return catalog
}

function loadPack(directory: string, origin: SkillOrigin, scope: string | undefined, source: string): SkillPack {
  if (existsSync(join(directory, 'manifest.json'))) return parsePack(directory, origin)
  return synthesizePack(directory, origin, scope, source)
}

/** Parse the simple YAML frontmatter SkillHub ships; nested maps are ignored. */
function frontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) return undefined
  const fields: Record<string, string> = {}
  const lines = (match[1] ?? '').split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line)
    if (field === null) continue
    const key = (field[1] ?? '').toLowerCase()
    let value = (field[2] ?? '').trim()
    if (value === '>' || value === '|') {
      const parts: string[] = []
      while (index + 1 < lines.length && /^\s+/u.test(lines[index + 1] ?? '')) {
        index += 1
        parts.push((lines[index] ?? '').trim())
      }
      value = parts.join(value === '|' ? '\n' : ' ')
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') fields[key] = value
  }
  return Object.keys(fields).length === 0 ? undefined : fields
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  if (id === '' || !/^[a-z0-9]/u.test(id)) throw new Error(`cannot derive a safe id from ${JSON.stringify(value)}`)
  return id
}

function synthesizePack(directory: string, origin: SkillOrigin, scope: string | undefined, source: string): SkillPack {
  const content = readFileSync(join(directory, 'SKILL.md'), 'utf8')
  const fields = frontmatter(content)
  if (fields === undefined) throw new Error('SKILL.md has no frontmatter')
  const fallbackName = basename(directory)
  const name = fields.displayname ?? fields.name ?? fallbackName
  const slug = fields.slug ?? fields.name ?? fallbackName
  const id = scope === undefined ? safeId(slug) : `${safeId(scope)}-${safeId(slug)}`
  const description = fields.description ?? name
  if (description.trim() === '') throw new Error('SKILL.md frontmatter description is empty')
  const roles = (fields.roles ?? 'worker')
    .replace(/^\[|\]$/gu, '')
    .split(/[,\s]+/u)
    .map(role => role.trim().toLowerCase())
    .filter((role): role is 'supervisor' | 'worker' => role === 'supervisor' || role === 'worker')
  const i18n = {
    ...(fields.description_zh === undefined ? {} : { zh: fields.description_zh }),
    ...(fields.description_en === undefined ? {} : { en: fields.description_en }),
  }
  let homepage: string | undefined
  if (fields.homepage !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(fields.homepage)
    } catch {
      throw new Error('frontmatter homepage must be an https URL')
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new Error('frontmatter homepage must be a credential-free https URL')
    }
    homepage = fields.homepage
  }
  return {
    id,
    name,
    description,
    ...(Object.keys(i18n).length === 0 ? {} : { descriptionI18n: i18n }),
    ...(fields.author === undefined ? {} : { author: fields.author }),
    ...(homepage === undefined ? {} : { homepage }),
    origin,
    roles: roles.length === 0 ? ['worker'] : [...new Set(roles)],
    tokenEstimate: Math.ceil(content.length / 4),
    tools: (fields.tools ?? '').split(/[,\s]+/u).filter(tool => tool !== ''),
    source,
    license: fields.license ?? 'unknown',
    path: join(directory, 'SKILL.md'),
    content,
  }
}

/** One local search candidate, shaped like a remote result without a URL. */
export interface LocalSearchHit {
  readonly packId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string
  readonly license: string
  readonly author?: string
  readonly homepage?: string
}

/**
 * Match packs against a free-text query, ranked by id/name before description.
 * @param packs - the merged local catalog.
 * @param query - case-insensitive text; empty matches every pack.
 * @param limit - maximum results returned.
 * @returns local candidates in rank order.
 */
export function searchLocalPacks(
  packs: ReadonlyMap<string, SkillPack>,
  query: string,
  limit: number,
): LocalSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const ranked: { readonly rank: number; readonly hit: LocalSearchHit }[] = []
  for (const pack of packs.values()) {
    const id = pack.id.toLowerCase()
    const name = pack.name.toLowerCase()
    const description = pack.description.toLowerCase()
    let rank = -1
    if (id === needle || name === needle) rank = 0
    else if (id.startsWith(needle) || name.startsWith(needle)) rank = 1
    else if (id.includes(needle) || name.includes(needle)) rank = 2
    else if (description.includes(needle)) rank = 3
    if (rank < 0) continue
    ranked.push({
      rank,
      hit: {
        packId: pack.id,
        name: pack.name,
        description: pack.description,
        sourceUrl: pack.homepage ?? '',
        license: pack.license,
        ...(pack.author === undefined ? {} : { author: pack.author }),
        ...(pack.homepage === undefined ? {} : { homepage: pack.homepage }),
      },
    })
  }
  return ranked.sort((left, right) => left.rank - right.rank).slice(0, Math.max(0, limit)).map(item => item.hit)
}

/**
 * Find ids present in both the builtin and installed roots.
 * @param left - one catalog map.
 * @param right - the other catalog map.
 * @returns ids that exist in both.
 */
export function duplicateIds(left: ReadonlyMap<string, SkillPack>, right: ReadonlyMap<string, SkillPack>): string[] {
  const ids: string[] = []
  for (const id of left.keys()) {
    if (right.has(id)) ids.push(id)
  }
  return ids
}

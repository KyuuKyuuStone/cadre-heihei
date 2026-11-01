/** Skill pack catalog shared by the Host plugin and its tests. @module */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
 * Missing directories produce an empty catalog; duplicate ids fail loud.
 * @param directory - catalog root.
 * @param origin - builtin or installed; copied onto every pack.
 * @returns pack id → pack.
 */
export function loadSkillCatalog(directory: string, origin: SkillOrigin = 'installed'): ReadonlyMap<string, SkillPack> {
  const catalog = new Map<string, SkillPack>()
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
    let pack: SkillPack
    try {
      pack = parsePack(path, origin)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') continue
      throw error
    }
    if (catalog.has(pack.id)) throw new Error(`duplicate skill pack id ${pack.id}`)
    catalog.set(pack.id, pack)
  }
  return catalog
}

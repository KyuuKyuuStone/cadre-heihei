/** Skill pack catalog shared by the Host plugin and its tests. @module */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** One on-disk skill pack. */
export interface SkillPack {
  readonly id: string
  readonly name: string
  readonly description: string
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
  readonly roles?: unknown
  readonly tokenEstimate?: unknown
  readonly tools?: unknown
  readonly source?: unknown
  readonly license?: unknown
}

function stringArray(value: unknown, fallback: readonly string[] = []): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback
}

function parsePack(directory: string): SkillPack {
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
  return {
    id: manifest.id as string,
    name: manifest.name as string,
    description: manifest.description as string,
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
 * @returns pack id → pack.
 */
export function loadSkillCatalog(directory: string): ReadonlyMap<string, SkillPack> {
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
      pack = parsePack(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') continue
      throw error
    }
    if (catalog.has(pack.id)) throw new Error(`duplicate skill pack id ${pack.id}`)
    catalog.set(pack.id, pack)
  }
  return catalog
}

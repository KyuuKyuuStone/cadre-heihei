/**
 * DESIGN §4 health checks, item by item: unreadable root, broken manifest, empty
 * SKILL.md, missing description, non-SPDX license, illegal roles, duplicate id,
 * oversized token estimate, declared-but-unused tools, and builtin/installed conflicts.
 * Every issue must carry a Chinese message and an actionable Chinese remediation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSkillCatalog } from '../src/diagnostics.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch {
        // A transient Windows handle keeps the TEMP directory; it never affects assertions.
      }
    }
  }
})

const CHINESE = /[\u4e00-\u9fa5]/
const MANIFEST = {
  id: 'demo-pack', name: 'Demo Pack', description: 'demo', roles: ['worker'],
  tokenEstimate: 100, tools: ['read'], source: 'github:o/r', license: 'MIT', author: 'cadre',
}

interface Catalog {
  readonly skillsDir: string
  readonly builtinDir: string
  readonly root: string
}

function catalog(): Catalog {
  const root = mkdtempSync(join(tmpdir(), 'cadre-skill-check-'))
  roots.push(root)
  const skillsDir = join(root, 'installed')
  const builtinDir = join(root, 'builtin')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(builtinDir, { recursive: true })
  return { root, skillsDir, builtinDir }
}

function pack(dir: string, name: string, manifest: object, content: string): void {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  if (manifest !== undefined) writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest))
  if (content !== undefined) writeFileSync(join(target, 'SKILL.md'), content)
}

function issuesOf(catalog0: Catalog, packId?: string) {
  const health = checkSkillCatalog({
    skillsDir: catalog0.skillsDir,
    builtinDir: catalog0.builtinDir,
    ...(packId === undefined ? {} : { packId }),
  })
  for (const item of health.items) {
    for (const issue of item.issues) {
      expect(issue.message).toMatch(CHINESE)
      expect(issue.remediation).toMatch(CHINESE)
      expect(issue.message).not.toBe(issue.code)
      console.log(`check ${item.packId} ${item.status} code=${issue.code} field=${issue.field ?? '-'} message=${issue.message} remediation=${issue.remediation}`)
    }
    if (item.issues.length === 0) console.log(`check ${item.packId} ${item.status} (no issues)`)
  }
  return health
}

function codes(health: ReturnType<typeof issuesOf>): string[] {
  return health.items.flatMap(item => item.issues.map(issue => issue.code))
}

describe('DESIGN §4 skill_check catalog health', () => {
  it('reports an unreadable catalog root as an actionable failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'cadre-skill-check-'))
    roots.push(root)
    const skillsDir = join(root, 'installed')
    writeFileSync(skillsDir, 'not a directory\n')
    const health = checkSkillCatalog({ skillsDir, builtinDir: join(root, 'builtin') })
    expect(health.status).toBe('error')
    expect(codes(health)).toContain('SKILL_SEARCH_UNAVAILABLE')
    const issue = health.items[0]?.issues[0]
    console.log(`check unreadable-root: code=${issue?.code} message=${issue?.message} remediation=${issue?.remediation}`)
  })

  it('reports broken manifests, empty content, and missing description', () => {
    const c = catalog()
    const broken = join(c.skillsDir, 'broken-manifest')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'manifest.json'), '{ not json ')
    writeFileSync(join(broken, 'SKILL.md'), '# broken\n')
    pack(c.skillsDir, 'empty-content', MANIFEST, '   \n')
    pack(c.skillsDir, 'no-description', { ...MANIFEST, id: 'no-description', description: '' }, '# no description\n')
    const health = issuesOf(c)
    expect(codes(health)).toContain('PACK_MANIFEST_INVALID')
    expect(codes(health)).toContain('PACK_CONTENT_MISSING')
    const noDescription = health.items.find(item => item.packId === 'no-description')
    expect(noDescription?.issues[0]?.field).toBe('description')
  })

  it('reports a non-SPDX license, illegal roles, and an oversized token estimate', () => {
    const c = catalog()
    pack(c.skillsDir, 'bad-license', { ...MANIFEST, id: 'bad-license', license: 'proprietary' }, '# uses read\n')
    pack(c.skillsDir, 'bad-roles', { ...MANIFEST, id: 'bad-roles', roles: ['admin'] }, '# uses read\n')
    pack(c.skillsDir, 'too-big', { ...MANIFEST, id: 'too-big', tokenEstimate: 50000 }, '# uses read\n')
    const health = issuesOf(c)
    expect(health.items.find(item => item.packId === 'bad-license')?.issues[0]?.message).toContain('SPDX')
    expect(health.items.find(item => item.packId === 'bad-roles')?.issues[0]?.message).toContain('admin')
    expect(health.items.find(item => item.packId === 'too-big')?.issues[0]?.message).toContain('超出上限')
    expect(health.items.find(item => item.packId === 'too-big')?.status).toBe('warning')
  })

  it('reports duplicate ids inside one root and builtin/installed conflicts', () => {
    const c = catalog()
    pack(c.skillsDir, 'first-copy', { ...MANIFEST, id: 'dup-pack' }, '# uses read\n')
    pack(c.skillsDir, 'second-copy', { ...MANIFEST, id: 'dup-pack' }, '# uses read\n')
    pack(c.builtinDir, 'builtin-conflict', { ...MANIFEST, id: 'conflict-pack' }, '# uses read\n')
    pack(c.skillsDir, 'installed-conflict', { ...MANIFEST, id: 'conflict-pack' }, '# uses read\n')
    const health = issuesOf(c)
    const duplicates = health.items.filter(item => item.issues.some(issue => issue.code === 'PACK_DUPLICATE'))
    expect(duplicates.map(item => item.packId).sort()).toEqual(['conflict-pack', 'dup-pack'])
  })

  it('reports declared tools the SKILL.md never mentions and keeps a clean pack ok', () => {
    const c = catalog()
    pack(c.skillsDir, 'unused-tools', { ...MANIFEST, id: 'unused-tools', tools: ['grep'] }, '# uses read only\n')
    pack(c.skillsDir, 'clean', { ...MANIFEST, id: 'clean' }, '# Demo\n\nUses the read tool.\n')
    const health = issuesOf(c)
    const unused = health.items.find(item => item.packId === 'unused-tools')
    expect(unused?.issues[0]?.field).toBe('tools')
    expect(unused?.issues[0]?.message).toContain('grep')
    expect(health.items.find(item => item.packId === 'clean')?.status).toBe('ok')
  })

  it('returns SKILL_NOT_FOUND for an unknown pack id without inventing other issues', () => {
    const c = catalog()
    pack(c.skillsDir, 'clean', { ...MANIFEST, id: 'clean' }, '# Demo\n\nUses the read tool.\n')
    const health = issuesOf(c, 'missing-pack')
    expect(codes(health)).toEqual(['SKILL_NOT_FOUND'])
  })
})

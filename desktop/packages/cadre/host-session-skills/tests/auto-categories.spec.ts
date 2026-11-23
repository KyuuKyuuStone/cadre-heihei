import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveCategories, FALLBACK_CATEGORY } from '../src/auto-categories.ts'
import { loadSkillCatalog } from '../src/catalog.ts'
import { collectAdminDiagnostics } from '../src/diagnostics.ts'
import { createSkillApi } from '../src/ipc.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-auto-cat-'))
  roots.push(root)
  return root
}

function pack(root: string, id: string, manifest: Record<string, unknown> = {}): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, description: `${id} description`, roles: ['worker'], tokenEstimate: 12, tools: [],
    source: 'local', license: 'MIT', ...manifest,
  }))
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}`)
}

describe('deriveCategories', () => {
  it('assigns several tags when several topics match', () => {
    const tags = deriveCategories({ name: 'docx', description: 'Word document spreadsheet office helper' })
    expect(tags).toContain('办公')
    expect(tags).toContain('文档')
  })

  it('matches short ASCII keywords on word boundaries only', () => {
    expect(deriveCategories({ name: 'guide', description: 'buildings and guidance' })).toEqual([FALLBACK_CATEGORY])
    expect(deriveCategories({ name: 'ui-kit', description: 'UI design system' })).toContain('设计')
  })

  it('falls back to a catch-all tag when nothing matches', () => {
    expect(deriveCategories({ name: 'zzz', description: 'qqq' })).toEqual([FALLBACK_CATEGORY])
  })

  it('caps the derived tag list at 8', () => {
    const tags = deriveCategories({ name: 'all', description: 'code excel pdf design browser tool data image' })
    expect(tags.length).toBe(8)
  })
})

describe('catalog category derivation', () => {
  it('derives tags when the manifest declares none', () => {
    const root = workspace()
    pack(root, 'shell-helper', { description: 'shell terminal automation tool' })
    expect(loadSkillCatalog(root).get('shell-helper')?.categories).toContain('工具')
  })

  it('respects explicit manifest tags, including an explicit empty list', () => {
    const root = workspace()
    pack(root, 'tagged', { description: 'shell terminal tool', categories: ['编程'] })
    pack(root, 'cleared', { description: 'shell terminal tool', categories: [] })
    const catalog = loadSkillCatalog(root)
    expect(catalog.get('tagged')?.categories).toEqual(['编程'])
    expect(catalog.get('cleared')?.categories).toEqual([])
  })

  it('derives tags for frontmatter-only SkillHub packs', () => {
    const root = workspace()
    const dir = join(root, '@scope', 'demo-browser')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: Demo Browser\ndescription: browser automation tool\n---\n# demo\n')
    const catalog = loadSkillCatalog(root)
    const entry = [...catalog.values()][0]
    expect(entry?.categories).toContain('浏览器')
    expect(entry?.categories).toContain('工具')
  })
})

describe('install-time auto check', () => {
  function ledger(root: string): DatabaseSync {
    const db = new DatabaseSync(join(root, 'ledger.sqlite'))
    db.exec(`CREATE TABLE members (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      display_name TEXT, description TEXT, state TEXT NOT NULL,
      skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id))`)
    db.prepare(`INSERT INTO members
      (project_id, session_id, role, display_name, description, state, skills_json, created_at, updated_at)
      VALUES ('p1', 's1', 'supervisor', NULL, NULL, 'available', '[]', 'now', 'now')`).run()
    return db
  }

  it('persists derived categories and a health snapshot when a pack is added', () => {
    const root = workspace()
    const skillsDir = join(root, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const db = ledger(root)
    try {
      const api = createSkillApi({ db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir })
      const entry = api.add({
        projectId: 'p1', actorSessionId: 's1',
        id: 'demo-cli', name: 'Demo CLI', description: 'shell terminal automation tool',
        roles: ['worker'], tokenEstimate: 10, tools: [], source: 'local', license: 'MIT', content: '# demo',
      })
      expect(entry.categories).toContain('工具')
      const manifest = JSON.parse(readFileSync(join(skillsDir, 'demo-cli', 'manifest.json'), 'utf8')) as {
        categories?: string[]; health?: { status: string; checkedAt: string }
      }
      expect(manifest.categories).toContain('工具')
      expect(manifest.health?.status).toBe('ok')
      expect(typeof manifest.health?.checkedAt).toBe('string')
    } finally {
      // Close before cleanup so a failed assertion cannot leave the SQLite handle locking the temp dir.
      db.close()
    }
  })

  it('exposes per-pack health items through admin diagnostics', async () => {
    const root = workspace()
    const skillsDir = join(root, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    pack(skillsDir, 'demo-cli', { description: 'shell terminal automation tool' })
    const result = await collectAdminDiagnostics({
      presetId: 'cadre-skill-admin', presets: undefined, sessionController: undefined, adminService: undefined,
      packs: loadSkillCatalog(skillsDir),
    })
    expect(result.packs?.summary.total).toBe(1)
    expect(result.packs?.items.map(item => item.packId)).toEqual(['demo-cli'])
    expect(result.packs?.items[0]?.status).toBe('ok')
  })
})
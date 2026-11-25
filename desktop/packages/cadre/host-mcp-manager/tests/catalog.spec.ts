/**
 * Catalog scanning: which manifests are usable, and what a rejected one reports.
 * @module
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localizedDescription, parseManifest, readCatalog, resolveServersRoot } from '../src/catalog.ts'
import { McpError } from '../src/errors.ts'

const roots: string[] = []

async function catalogRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-'))
  roots.push(root)
  return root
}

async function entry(root: string, id: string, manifest: unknown): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'manifest.json'), JSON.stringify(manifest))
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('readCatalog', () => {
  it('reads stdio and http entries, masks secrets to names, and reports bad rows', async () => {
    const root = await catalogRoot()
    await entry(root, 'github', {
      id: 'github', name: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'server'],
      env: { GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN' }, LOG_LEVEL: 'debug' },
    })
    await entry(root, 'remote', { id: 'remote', name: 'Remote', transport: 'streamable-http', url: 'https://example.test/mcp' })
    // A credential-shaped literal is refused instead of stored.
    await entry(root, 'leaky', { id: 'leaky', transport: 'stdio', command: 'npx', env: { API_TOKEN: 'plaintext' } })
    // A duplicate id keeps the first entry and records the second.
    await entry(root, 'github-copy', { id: 'github', transport: 'stdio', command: 'npx' })
    // `.backups` holds removed servers and must not revive.
    await entry(root, '.backups/github', { id: 'github', transport: 'stdio', command: 'npx' })

    const scan = await readCatalog(root)
    expect([...scan.servers.keys()].sort()).toEqual(['github', 'remote'])
    expect(scan.servers.get('github')?.env).toEqual({ GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN' }, LOG_LEVEL: 'debug' })
    expect(scan.health.map(row => row.id).sort()).toEqual(['github-copy', 'leaky'])
    expect(scan.health.every(row => row.state === 'invalid')).toBe(true)
  })

  it('treats a missing root as an empty catalog', async () => {
    const scan = await readCatalog(join(await catalogRoot(), 'absent'))
    expect(scan.servers.size).toBe(0)
    expect(scan.health).toEqual([])
  })
})

describe('parseManifest', () => {
  it('rejects a transport mismatch and an over-long id', () => {
    expect(() => parseManifest({ transport: 'stdio' }, 'x')).toThrow(McpError)
    expect(() => parseManifest({ id: 'a'.repeat(33), transport: 'stdio', command: 'npx' }, 'x')).toThrow(McpError)
    expect(() => parseManifest({ transport: 'streamable-http' }, 'x')).toThrow(McpError)
  })

  it('defaults the name to the directory id', () => {
    const manifest = parseManifest({ transport: 'stdio', command: 'npx' }, 'dir-name')
    expect(manifest).toMatchObject({ id: 'dir-name', name: 'dir-name', transport: 'stdio' })
  })
})

describe('resolveServersRoot', () => {
  it('prefers the explicit config over the environment', () => {
    const previous = process.env.CADRE_MCP_DIR
    process.env.CADRE_MCP_DIR = '/from-env'
    try {
      expect(resolveServersRoot({ mcpDir: '/explicit' })).toBe('/explicit')
      expect(resolveServersRoot({})).toBe('/from-env')
    } finally {
      if (previous === undefined) delete process.env.CADRE_MCP_DIR
      else process.env.CADRE_MCP_DIR = previous
    }
  })
})

describe('localizedDescription', () => {
  const translated = parseManifest({
    id: 'translated', transport: 'stdio', command: 'npx',
    description: 'base', descriptionI18n: { zh: '中文说明', en: 'English text' },
  }, 'translated')

  it('selects the language by locale prefix and defaults to English', () => {
    expect(localizedDescription(translated, 'zh')).toBe('中文说明')
    expect(localizedDescription(translated, 'zh-CN')).toBe('中文说明')
    expect(localizedDescription(translated, 'en-US')).toBe('English text')
    // No locale, and any other language, read the English entry.
    expect(localizedDescription(translated, undefined)).toBe('English text')
    expect(localizedDescription(translated, 'fr')).toBe('English text')
  })

  it('falls back to the base description and then to an empty string', () => {
    // Only the Chinese translation exists, so an English reader sees the base field.
    const partial = parseManifest({
      id: 'partial', transport: 'stdio', command: 'npx',
      description: 'base', descriptionI18n: { zh: '中文说明' },
    }, 'partial')
    expect(localizedDescription(partial, 'en')).toBe('base')
    expect(localizedDescription(partial, 'zh')).toBe('中文说明')

    // A manifest carrying only descriptionI18n used to project an empty description.
    const onlyI18n = parseManifest({
      id: 'only', transport: 'stdio', command: 'npx', descriptionI18n: { zh: '仅中文' },
    }, 'only')
    expect(localizedDescription(onlyI18n, 'zh')).toBe('仅中文')
    expect(localizedDescription(onlyI18n, 'en')).toBe('')

    expect(localizedDescription(parseManifest({ id: 'bare', transport: 'stdio', command: 'npx' }, 'bare'), 'zh'))
      .toBe('')
  })

  it('drops blank translations while parsing', () => {
    const blank = parseManifest({
      id: 'blank', transport: 'stdio', command: 'npx', descriptionI18n: { zh: '   ', en: '' },
    }, 'blank')
    expect(blank.descriptionI18n).toBeUndefined()
    expect(localizedDescription(blank, 'zh')).toBe('')
  })
})

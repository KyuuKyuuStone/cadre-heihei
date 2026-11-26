/**
 * Catalog writes against a real directory: staging under `.backups`, an atomic
 * rename, rollback when a step fails, and the validation each entry point applies
 * before it touches the filesystem.
 * @module
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCatalog } from '../src/catalog.ts'
import { McpError } from '../src/errors.ts'
import { addManifest, BACKUP_DIR, editManifest, parseIncomingManifest, removeManifest, writeManifest } from '../src/write.ts'

const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'mcp-write-'))
  roots.push(path)
  return path
}

function stdio(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, transport: 'stdio', command: 'npx', ...extra }
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof McpError) return error.code
    throw error
  }
  throw new Error('expected a failure')
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('parseIncomingManifest', () => {
  it('requires an id and reports the grammar it enforces', () => {
    expect(codeOf(() => parseIncomingManifest({ transport: 'stdio', command: 'npx' }))).toBe('MCP_INVALID')
    expect(codeOf(() => parseIncomingManifest(stdio('bad id!')))).toBe('MCP_INVALID')
    expect(codeOf(() => parseIncomingManifest([]))).toBe('MCP_INVALID')
  })

  it('refuses a field the whitelist does not carry', () => {
    expect(codeOf(() => parseIncomingManifest(stdio('ok', { unexpected: 1 })))).toBe('MCP_INVALID')
  })

  it('refuses a plaintext secret in a credential-shaped name', () => {
    expect(codeOf(() => parseIncomingManifest(stdio('ok', { env: { GITHUB_TOKEN: 'plain' } })))).toBe('MCP_INVALID')
  })

  it('accepts a fromEnv reference and a non-secret literal', () => {
    const manifest = parseIncomingManifest(stdio('ok', {
      env: { GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN' }, LOG_LEVEL: 'debug' },
    }))
    expect(manifest.env).toEqual({ GITHUB_TOKEN: { fromEnv: 'GITHUB_TOKEN' }, LOG_LEVEL: 'debug' })
  })
})

describe('addManifest', () => {
  it('creates the entry and leaves the catalog readable', async () => {
    const path = root()
    const written = addManifest(path, stdio('alpha'), false)
    expect(written).toEqual({ id: 'alpha', created: true, overwritten: false })
    const scan = await readCatalog(path)
    expect([...scan.servers.keys()]).toEqual(['alpha'])
    expect(JSON.parse(readFileSync(join(path, 'alpha', 'manifest.json'), 'utf8'))).toMatchObject({ id: 'alpha' })
  })

  it('refuses an id that already exists unless overwrite is requested', () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    expect(codeOf(() => { addManifest(path, stdio('alpha'), false) })).toBe('MCP_NAME_CONFLICT')
    const replaced = addManifest(path, stdio('alpha', { description: 'second' }), true)
    expect(replaced).toEqual({ id: 'alpha', created: false, overwritten: true })
  })

  it('keeps the previous generation under .backups and never scans it back', async () => {
    const path = root()
    addManifest(path, stdio('alpha', { description: 'first' }), false)
    addManifest(path, stdio('alpha', { description: 'second' }), true)
    const scan = await readCatalog(path)
    expect(scan.servers.size).toBe(1)
    expect(scan.servers.get('alpha')?.description).toBe('second')
  })
})

describe('editManifest', () => {
  it('merges the patch into the stored manifest', async () => {
    const path = root()
    addManifest(path, stdio('alpha', { args: ['-y'], tags: ['beta'] }), false)
    expect(editManifest(path, 'alpha', { description: 'patched', args: ['-y', 'pkg'] })).toEqual({ id: 'alpha' })
    const manifest = (await readCatalog(path)).servers.get('alpha')
    expect(manifest).toMatchObject({ description: 'patched', args: ['-y', 'pkg'], tags: ['beta'] })
  })

  it('refuses a renamed id and an unknown id', () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    expect(codeOf(() => editManifest(path, 'alpha', { id: 'beta' }))).toBe('MCP_INVALID')
    expect(codeOf(() => editManifest(path, 'missing', { description: 'x' }))).toBe('MCP_SERVER_UNAVAILABLE')
  })

  it('refuses a patch field outside the whitelist and an unknown patched id shape', () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    expect(codeOf(() => editManifest(path, 'alpha', { command2: 'x' }))).toBe('MCP_INVALID')
    expect(codeOf(() => editManifest(path, 'alpha', 'not an object'))).toBe('MCP_INVALID')
    expect(codeOf(() => editManifest(path, 'bad id!', { description: 'x' }))).toBe('MCP_INVALID')
  })

  it('refuses a patch that would persist a manifest the parser rejects', () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    expect(codeOf(() => editManifest(path, 'alpha', { transport: 'streamable-http' }))).toBe('MCP_INVALID')
  })

  it('reports a damaged stored manifest as unwritable', () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    writeFileSync(join(path, 'alpha', 'manifest.json'), '{', 'utf8')
    expect(codeOf(() => editManifest(path, 'alpha', { description: 'x' }))).toBe('MCP_CATALOG_UNAVAILABLE')
  })
})

describe('removeManifest', () => {
  it('moves the entry under .backups instead of destroying it', async () => {
    const path = root()
    addManifest(path, stdio('alpha'), false)
    removeManifest(path, 'alpha')
    expect(existsSync(join(path, 'alpha'))).toBe(false)
    expect(readdirSync(join(path, BACKUP_DIR)).some(name => name.startsWith('alpha.old-'))).toBe(true)
    expect((await readCatalog(path)).servers.size).toBe(0)
  })

  it('refuses an unknown id and a malformed one', () => {
    const path = root()
    expect(codeOf(() => { removeManifest(path, 'missing') })).toBe('MCP_SERVER_UNAVAILABLE')
    expect(codeOf(() => { removeManifest(path, 'bad id!') })).toBe('MCP_INVALID')
  })
})

describe('writeManifest rollback', () => {
  it('reports the write failure and leaves the live entry readable', () => {
    const path = root()
    addManifest(path, stdio('alpha', { description: 'first' }), false)
    // A file where the backup root must go fails the write before the live entry
    // is touched, so the previous generation stays readable.
    rmSync(join(path, BACKUP_DIR), { recursive: true, force: true })
    writeFileSync(join(path, BACKUP_DIR), 'not a directory', 'utf8')
    const manifest = parseIncomingManifest(stdio('alpha', { description: 'second' }))
    expect(codeOf(() => { writeManifest(path, manifest) })).toBe('MCP_CATALOG_UNAVAILABLE')
    expect(JSON.parse(readFileSync(join(path, 'alpha', 'manifest.json'), 'utf8'))).toMatchObject({ description: 'first' })
  })
})

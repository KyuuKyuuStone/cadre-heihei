/**
 * Selection storage and validation: tolerant reads, strict writes, and the
 * override allowlist that keeps a session from redirecting a catalog entry.
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { McpError } from '../src/errors.ts'
import { openLedger, parseSelection, readSelection, validateSelection, writeSelection } from '../src/selection.ts'

const paths: string[] = []

async function ledger(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-selection-'))
  paths.push(root)
  return join(root, 'ledger.db')
}

afterEach(async () => {
  for (const root of paths.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('parseSelection', () => {
  it('degrades damage to the empty selection', () => {
    expect(parseSelection(undefined)).toEqual({ servers: [] })
    expect(parseSelection({ servers: 'nope' })).toEqual({ servers: [] })
    expect(parseSelection({ servers: [null, 7, {}, { id: '' }] })).toEqual({ servers: [] })
  })

  it('keeps valid entries and drops unusable overrides', () => {
    const parsed = parseSelection({
      servers: [
        { id: 'github', enabled: true, overrides: { toolCallTimeoutMs: 90_000, env: { TOKEN: { fromEnv: 'ALT' } } } },
        { id: 'remote', enabled: false },
        { id: 'bad-override', overrides: { toolCallTimeoutMs: -1, env: { TOKEN: 'plain' } } },
      ],
    })
    expect(parsed.servers).toEqual([
      { id: 'github', enabled: true, overrides: { toolCallTimeoutMs: 90_000, env: { TOKEN: { fromEnv: 'ALT' } } } },
      { id: 'remote', enabled: false },
      { id: 'bad-override', enabled: true },
    ])
  })
})

describe('validateSelection', () => {
  const known = (id: string): boolean => id === 'github'

  it('deduplicates and rejects unknown ids', () => {
    expect(validateSelection([{ id: 'github' }, { id: 'github' }], known).servers).toEqual([
      { id: 'github', enabled: true },
    ])
    expect(() => validateSelection([{ id: 'nope' }], known)).toThrow(McpError)
  })

  it('refuses endpoint overrides and plaintext secrets', () => {
    expect(() => validateSelection([{ id: 'github', overrides: { command: 'evil' } }], known)).toThrow(McpError)
    expect(() => validateSelection([{ id: 'github', overrides: { env: { TOKEN: 'plain' } } }], known)).toThrow(McpError)
    expect(validateSelection([{ id: 'github', overrides: { env: { TOKEN: { fromEnv: 'ALT' } } } }], known).servers)
      .toEqual([{ id: 'github', enabled: true, overrides: { env: { TOKEN: { fromEnv: 'ALT' } } } }])
  })
})

describe('readSelection/writeSelection', () => {
  it('round-trips a selection and creates the table on first write', async () => {
    const path = await ledger()
    // The host always has a ledger; a read-only handle needs the file to exist.
    const created = new DatabaseSync(path)
    created.close()
    const db = openLedger(path)
    try {
      expect(readSelection(db, 'session-1')).toEqual({ servers: [] })
    } finally {
      db.close()
    }
    writeSelection(path, 'session-1', { servers: [{ id: 'github', enabled: true }] })
    const reopened = openLedger(path)
    try {
      expect(readSelection(reopened, 'session-1')).toEqual({ servers: [{ id: 'github', enabled: true }] })
      expect(readSelection(reopened, 'other')).toEqual({ servers: [] })
    } finally {
      reopened.close()
    }
  })
})

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCadreLedgerPath } from '../src/cadre-ledger.ts'
import {
  markRosterSeen,
  migrateLegacyCadreLedger,
  planCadreLedgerPaths,
  readLedgerMarker,
  rosterMissing,
} from '../src/cadre-ledger-migration.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-ledger-'))
  roots.push(root)
  return root
}

const LEDGER_TABLES = ['members', 'tasks', 'messages', 'task_events', 'employees'] as const

/** Minimal valid cadre ledger carrying one roster row. */
function createLedger(path: string, sessionId: string, options: {
  readonly wal?: boolean
  readonly omit?: readonly (typeof LEDGER_TABLES)[number][]
} = {}): DatabaseSync | undefined {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  const tables: Record<(typeof LEDGER_TABLES)[number], string> = {
    members: 'CREATE TABLE members (project_id TEXT, session_id TEXT, role TEXT)',
    tasks: 'CREATE TABLE tasks (task_id TEXT)',
    messages: 'CREATE TABLE messages (message_id TEXT)',
    task_events: 'CREATE TABLE task_events (task_id TEXT)',
    employees: 'CREATE TABLE employees (session_id TEXT)',
  }
  for (const table of LEDGER_TABLES) {
    if (options.omit?.includes(table) === true) continue
    db.exec(tables[table])
  }
  db.prepare('INSERT INTO members VALUES (?, ?, ?)').run('project-1', sessionId, 'supervisor')
  if (options.wal === true) return db
  db.close()
  return undefined
}

function members(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare('SELECT session_id FROM members').all() as { session_id?: string }[])
      .map(row => String(row.session_id))
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cadre ledger migration', () => {
  it('copies a legacy ledger into the canonical path and keeps the source', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')
    createLedger(legacy, 'supervisor-1')
    const before = readFileSync(legacy)

    const outcome = migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} })

    expect(outcome).toMatchObject({ status: 'migrated', activePath: target })
    expect(members(target)).toEqual(['supervisor-1'])
    expect(members(legacy)).toEqual(['supervisor-1'])
    expect(readFileSync(legacy).equals(before)).toBe(true)
  })

  it('includes rows that only exist in the source WAL', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')
    const open = createLedger(legacy, 'supervisor-1', { wal: true })
    open?.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    open?.exec('PRAGMA wal_autocheckpoint = 0')
    open?.exec("INSERT INTO members VALUES ('project-1', 'worker-wal', 'worker')")

    const outcome = migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} })
    open?.close()

    expect(outcome.status).toBe('migrated')
    expect(members(target).sort()).toEqual(['supervisor-1', 'worker-wal'])
  })

  it('never overwrites an existing canonical ledger', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')
    createLedger(legacy, 'old-roster')
    createLedger(target, 'new-roster')

    const outcome = migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} })

    expect(outcome).toMatchObject({ status: 'existing', activePath: target })
    expect(members(target)).toEqual(['new-roster'])
    expect(members(legacy)).toEqual(['old-roster'])
  })

  it('keeps the legacy ledger intact when the copy fails', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, 'not a sqlite database')

    const outcome = migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} })

    expect(outcome.status).toBe('failed')
    expect(outcome.activePath).toBe(legacy)
    expect(outcome.reason).toBeTypeOf('string')
    expect(readFileSync(legacy, 'utf8')).toBe('not a sqlite database')
    expect(() => readFileSync(target)).toThrow()
    expect(readdirSync(dirname(target)).some(name => name.includes('.migrating-'))).toBe(false)
  })

  it('refuses a copy missing any collaboration table', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')
    createLedger(legacy, 'supervisor-1', { omit: ['messages'] })

    const outcome = migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} })

    expect(outcome).toMatchObject({ status: 'failed', activePath: legacy })
    expect(outcome.reason).toContain('messages')
    expect(() => readFileSync(target)).toThrow()
    expect(members(legacy)).toEqual(['supervisor-1'])
  })

  it('reports a fresh install when neither path exists', () => {
    const root = scratch()
    const legacy = join(root, 'user-data', 'cadre.sqlite')
    const target = join(root, 'home', 'cadre.sqlite')

    expect(migrateLegacyCadreLedger({ targetPath: target, legacyPath: legacy, log: () => {} }))
      .toMatchObject({ status: 'fresh', activePath: target })
  })
})

describe('cadre ledger path overrides', () => {
  it('defaults to DSH_HOME/cadre.sqlite instead of Electron userData', () => {
    const root = scratch()
    const env = { DSH_HOME: join(root, 'dsh-home') }
    expect(resolveCadreLedgerPath(join(root, 'user-data'), env)).toBe(join(root, 'dsh-home', 'cadre.sqlite'))
    expect(planCadreLedgerPaths(join(root, 'user-data'), env).explicit).toBe(false)
  })

  it('keeps CADRE_LEDGER_PATH and CADRE_USER_DATA as explicit overrides', () => {
    const root = scratch()
    const explicit = join(root, 'pinned', 'ledger.sqlite')
    const ledgerOverride = planCadreLedgerPaths(join(root, 'user-data'), { CADRE_LEDGER_PATH: explicit })
    expect(ledgerOverride.targetPath).toBe(explicit)
    expect(ledgerOverride.explicit).toBe(true)

    const userDataOverride = planCadreLedgerPaths(join(root, 'user-data'), {
      CADRE_USER_DATA: join(root, 'cadre-data'),
    })
    expect(userDataOverride.targetPath).toBe(join(root, 'cadre-data', 'cadre.sqlite'))
    expect(userDataOverride.explicit).toBe(true)
  })
})

describe('roster loss marker', () => {
  it('distinguishes a recreated ledger from a brand-new empty roster', () => {
    const root = scratch()
    expect(rosterMissing(0, readLedgerMarker(root))).toBe(false)

    expect(markRosterSeen(root, '2026-10-26T00:00:00.000Z')).toBe(true)
    const marker = readLedgerMarker(root)
    expect(marker.rosterSeenAt).toBe('2026-10-26T00:00:00.000Z')
    expect(rosterMissing(0, marker)).toBe(true)
    expect(rosterMissing(1, marker)).toBe(false)
  })
})

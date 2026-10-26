/**
 * One-time move of the cadre ledger from Electron userData into the shared
 * Harness home, where sessions already live and uninstall never reaches.
 *
 * Safety rules:
 * - the new path always wins; an existing target is never overwritten;
 * - the legacy database is only read, never deleted or modified;
 * - the copy is a SQLite `VACUUM INTO` snapshot (WAL included), integrity
 *   checked, then published with a hard link so a partial file cannot appear
 *   at the target path;
 * - any failure leaves the legacy database untouched and reports `failed`, so
 *   the caller can keep using it instead of creating an empty replacement.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveCadreLedgerPath, resolveHarnessHome } from './cadre-ledger.ts'

/** User-visible warning when a populated roster disappeared between launches. */
export const ROSTER_MISSING_MESSAGE = '团队数据丢失或未找到：花名册为空。请从备份恢复，或重新创建团队。'

const MARKER_FILE = 'cadre-ledger-state.json'
const MIGRATION_SUFFIX = '.migrating-'
const DEFAULT_LOG = (message: string): void => { console.log(message) }
/** A copy missing any of these would silently lose roster, ledger or reports. */
const REQUIRED_TABLES = ['members', 'tasks', 'messages', 'task_events', 'employees'] as const
const REQUIRED_TABLE_SQL = REQUIRED_TABLES.map(name => `'${name}'`).join(', ')

/** Paths and override state used at startup. */
export interface CadreLedgerPlan {
  /** Canonical path (`$DSH_HOME/cadre.sqlite` unless overridden). */
  readonly targetPath: string
  /** Pre-0.8.7 Electron userData path. */
  readonly legacyPath: string
  /** Shared Harness home, also holding the roster marker. */
  readonly dshHome: string
  /** True when an environment variable pins the ledger path. */
  readonly explicit: boolean
}

export interface CadreLedgerMigration {
  readonly status: 'existing' | 'fresh' | 'migrated' | 'failed' | 'skipped'
  /** Path the process must open; falls back to legacy after a failed copy. */
  readonly activePath: string
  readonly targetPath: string
  readonly legacyPath: string
  readonly reason?: string
}

export interface CadreLedgerMarker {
  readonly rosterSeenAt?: string
}

/** Resolve the canonical/legacy paths without touching the filesystem. */
export function planCadreLedgerPaths(userData: string, env: NodeJS.ProcessEnv = process.env): CadreLedgerPlan {
  return {
    targetPath: resolveCadreLedgerPath(userData, env),
    legacyPath: join(userData, 'cadre.sqlite'),
    dshHome: resolveHarnessHome(env),
    explicit: (env.CADRE_LEDGER_PATH?.trim() ?? '') !== '' || (env.CADRE_USER_DATA?.trim() ?? '') !== '',
  }
}

/**
 * Copy a legacy ledger when the canonical path is still absent.
 * @param options - canonical and legacy paths plus an optional log sink.
 * @returns migration outcome; `activePath` is safe to open in every case.
 */
export function migrateLegacyCadreLedger(options: {
  readonly targetPath: string
  readonly legacyPath: string
  readonly log?: (message: string) => void
}): CadreLedgerMigration {
  const { targetPath, legacyPath } = options
  const log = options.log ?? DEFAULT_LOG
  const base = { targetPath, legacyPath }
  if (resolve(targetPath) === resolve(legacyPath) || existsSync(targetPath)) {
    return { ...base, status: 'existing', activePath: targetPath }
  }
  if (!existsSync(legacyPath)) {
    return { ...base, status: 'fresh', activePath: targetPath }
  }

  const temporary = `${targetPath}${MIGRATION_SUFFIX}${randomUUID()}`
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    const source = new DatabaseSync(legacyPath, { readOnly: true })
    try {
      source.exec('PRAGMA busy_timeout = 5000')
      source.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
    verifyCopy(temporary)
    try {
      // Hard link publishes the verified file atomically and refuses to
      // replace a target created in the meantime.
      linkSync(temporary, targetPath)
    } catch (error) {
      rmSync(temporary, { force: true })
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ...base, status: 'existing', activePath: targetPath }
      }
      throw error
    }
    rmSync(temporary, { force: true })
    log(`cadre-ledger migrated from=${legacyPath} to=${targetPath}`)
    return { ...base, status: 'migrated', activePath: targetPath }
  } catch (error) {
    rmSync(temporary, { force: true })
    const reason = error instanceof Error ? error.message : String(error)
    log(`cadre-ledger migration failed legacy=${legacyPath} target=${targetPath} reason=${reason}`)
    return { ...base, status: 'failed', activePath: legacyPath, reason }
  }
}

/** Integrity-check the temporary snapshot before it becomes the live file. */
function verifyCopy(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    if (integrity?.integrity_check !== 'ok') throw new Error('integrity_check failed')
    const found = new Set((db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${REQUIRED_TABLE_SQL})`).all() as { name?: string }[])
      .map(row => String(row.name)))
    const missing = REQUIRED_TABLES.filter(name => !found.has(name))
    if (missing.length > 0) throw new Error(`ledger tables missing: ${missing.join(', ')}`)
  } finally {
    db.close()
  }
}

/** Read the durable roster marker (`$DSH_HOME/cadre-ledger-state.json`). */
export function readLedgerMarker(dshHome: string): CadreLedgerMarker {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, MARKER_FILE), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const seen = (parsed as { rosterSeenAt?: unknown }).rosterSeenAt
    return typeof seen === 'string' && seen !== '' ? { rosterSeenAt: seen } : {}
  } catch {
    return {}
  }
}

/**
 * Record that this Harness home once had a populated roster. The marker sits
 * beside sessions, so it survives uninstall even if the ledger itself is lost.
 * @returns true when the marker was written.
 */
export function markRosterSeen(dshHome: string, at: string = new Date().toISOString()): boolean {
  const path = join(dshHome, MARKER_FILE)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ version: 1, rosterSeenAt: at }, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    rmSync(temporary, { force: true })
    return false
  }
}

/**
 * A ledger with zero members plus a marker saying a roster existed means the
 * database was recreated or replaced, not that the project is simply new.
 */
export function rosterMissing(memberCount: number, marker: CadreLedgerMarker): boolean {
  return memberCount === 0 && marker.rosterSeenAt !== undefined
}

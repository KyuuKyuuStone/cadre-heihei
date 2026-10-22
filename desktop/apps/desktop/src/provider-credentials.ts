/**
 * Read-only credential inspection for provider IPC metadata.
 *
 * Values stay in memory only long enough to compute a last-four mask; callers
 * must never log or persist them. Official precedence: stored file, then the
 * launch environment.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

function credentialsPath(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home === undefined || home === '' ? join(homedir(), '.dsh') : home, '.credentials.yaml')
}

/** @returns reference values from the credentials document; empty when absent/unreadable. */
function fileRefs(): Record<string, unknown> {
  try {
    const document = yaml.load(readFileSync(credentialsPath(), 'utf8'))
    if (typeof document !== 'object' || document === null) return {}
    const refs = (document as { refs?: unknown }).refs
    return typeof refs === 'object' && refs !== null ? refs as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Resolve a credential for masking only (file wins over environment). */
export function credentialValue(ref: string): string | undefined {
  const stored = fileRefs()[ref]
  if (typeof stored === 'string' && stored !== '') return stored
  const inherited = process.env[ref]
  return inherited === undefined || inherited === '' ? undefined : inherited
}

/** Last-four mask, e.g. `…abcd`; never the full value. */
export function maskCredential(value: string): string {
  return value.length <= 4 ? '…' : `…${value.slice(-4)}`
}

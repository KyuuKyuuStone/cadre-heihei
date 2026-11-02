/**
 * Per-project config parsing and loading. Config files are plain JSON under a
 * private directory; secrets are referenced by environment variable name only.
 * @module
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EmailConfig } from './types.ts'

/** Reject an address that cannot be used as a provider recipient. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
}

/** Default environment variable for a provider. */
function defaultKeyEnv(provider: 'sendgrid' | 'resend'): string {
  return provider === 'resend' ? 'RESEND_API_KEY' : 'SENDGRID_API_KEY'
}

/**
 * Parse one project config document.
 * @param value - untrusted JSON.
 * @returns validated config.
 * @throws when required fields are missing, a secret value is embedded, or an
 *   address is malformed.
 */
export function parseEmailConfig(value: unknown): EmailConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('EMAIL_CONFIG_INVALID: config must be an object')
  }
  const source = value as Record<string, unknown>
  if ('apiKey' in source || 'sendgridApiKey' in source || 'secret' in source) {
    throw new Error('EMAIL_SECRET_IN_CONFIG: use apiKeyEnv, never store the key in config')
  }
  if (typeof source.enabled !== 'boolean') throw new Error('EMAIL_CONFIG_INVALID: enabled must be boolean')
  const provider = source.provider === undefined ? 'sendgrid' : source.provider
  if (provider !== 'sendgrid' && provider !== 'resend') {
    throw new Error('EMAIL_CONFIG_INVALID: provider must be sendgrid or resend')
  }
  const from = source.from
  if (typeof from !== 'object' || from === null) throw new Error('EMAIL_CONFIG_INVALID: from is required')
  const fromRecord = from as Record<string, unknown>
  if (typeof fromRecord.email !== 'string' || !isEmail(fromRecord.email)) {
    throw new Error('EMAIL_CONFIG_INVALID: from.email is not an address')
  }
  if (fromRecord.name !== undefined && typeof fromRecord.name !== 'string') {
    throw new Error('EMAIL_CONFIG_INVALID: from.name must be a string')
  }
  const recipients = source.recipients
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('EMAIL_CONFIG_INVALID: recipients must be a non-empty array')
  }
  for (const recipient of recipients) {
    if (typeof recipient !== 'string' || !isEmail(recipient)) {
      throw new Error(`EMAIL_CONFIG_INVALID: recipient ${String(recipient)} is not an address`)
    }
  }
  if (source.apiKeyEnv !== undefined && (typeof source.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/u.test(source.apiKeyEnv))) {
    throw new Error('EMAIL_CONFIG_INVALID: apiKeyEnv must be an environment variable name')
  }
  const apiKeyEnv = typeof source.apiKeyEnv === 'string' ? source.apiKeyEnv : defaultKeyEnv(provider)
  const verifiedDomains = source.verifiedDomains
  if (verifiedDomains !== undefined) {
    if (!Array.isArray(verifiedDomains) || verifiedDomains.some(domain =>
      typeof domain !== 'string' || !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(domain))) {
      throw new Error('EMAIL_CONFIG_INVALID: verifiedDomains must be an array of domains')
    }
  }
  const minIntervalMs = source.minIntervalMs
  if (minIntervalMs !== undefined && (typeof minIntervalMs !== 'number' || !Number.isFinite(minIntervalMs) || minIntervalMs < 0)) {
    throw new Error('EMAIL_CONFIG_INVALID: minIntervalMs must be a non-negative number')
  }
  return {
    enabled: source.enabled,
    provider,
    from: { email: fromRecord.email, ...(fromRecord.name === undefined ? {} : { name: fromRecord.name }) },
    recipients: recipients as string[],
    apiKeyEnv,
    ...(verifiedDomains === undefined ? {} : { verifiedDomains: verifiedDomains as string[] }),
    ...(source.dryRun === true ? { dryRun: true } : {}),
    ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
  }
}

/**
 * Load one project config by id.
 * @param directory - private config directory.
 * @param projectId - project id; used as the file name after a safety check.
 * @returns parsed config.
 * @throws when the id would escape the directory or the file is unreadable.
 */
export function loadEmailConfig(directory: string, projectId: string): EmailConfig {
  if (!/^[A-Za-z0-9._-]+$/u.test(projectId) || projectId === '.' || projectId === '..') {
    throw new Error('EMAIL_CONFIG_INVALID: project id is not a safe file name')
  }
  const path = join(directory, `${projectId}.json`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      throw error
    }
    throw new Error('EMAIL_CONFIG_INVALID: unable to read project config')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('EMAIL_CONFIG_INVALID: config is not valid JSON')
  }
  return parseEmailConfig(parsed)
}

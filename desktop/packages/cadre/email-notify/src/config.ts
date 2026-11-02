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
function defaultKeyEnv(provider: 'sendgrid' | 'resend' | 'smtp'): string | undefined {
  if (provider === 'resend') return 'RESEND_API_KEY'
  if (provider === 'smtp') return undefined
  return 'SENDGRID_API_KEY'
}

/** SMTP preset hosts used by QQ Mail and 163 Mail. */
const SMTP_PRESETS = {
  qq: { host: 'smtp.qq.com', port: 465, secure: true },
  '163': { host: 'smtp.163.com', port: 465, secure: true },
} as const

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
  if ('apiKey' in source || 'sendgridApiKey' in source || 'secret' in source
    || 'authCode' in source || 'authCodeValue' in source || 'password' in source
    || 'pass' in source || 'smtpPassword' in source) {
    throw new Error('EMAIL_SECRET_IN_CONFIG: use the secret store, never store the key in config')
  }
  if (typeof source.enabled !== 'boolean') throw new Error('EMAIL_CONFIG_INVALID: enabled must be boolean')
  const provider = source.provider === undefined ? 'sendgrid' : source.provider
  if (provider !== 'sendgrid' && provider !== 'resend' && provider !== 'smtp') {
    throw new Error('EMAIL_CONFIG_INVALID: provider must be sendgrid, resend or smtp')
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
  let smtp: Pick<EmailConfig, 'smtpPreset' | 'host' | 'port' | 'secure' | 'user' | 'fromName' | 'authCodeEnv'> = {}
  if (provider === 'smtp') {
    const rawPreset = source.smtpPreset ?? 'qq'
    if (rawPreset !== 'qq' && rawPreset !== '163') {
      throw new Error('EMAIL_CONFIG_INVALID: smtpPreset must be qq or 163')
    }
    const preset = SMTP_PRESETS[rawPreset]
    const host = source.host ?? preset.host
    const port = source.port ?? preset.port
    const secure = source.secure ?? preset.secure
    const user = source.user ?? fromRecord.email
    const fromName = source.fromName ?? fromRecord.name
    const authCodeEnv = source.authCodeEnv ?? 'QQ_EMAIL_AUTH_CODE'
    if (typeof host !== 'string' || host.trim() === '') throw new Error('EMAIL_CONFIG_INVALID: host must be a non-empty string')
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('EMAIL_CONFIG_INVALID: port must be an integer 1-65535')
    }
    if (typeof secure !== 'boolean') throw new Error('EMAIL_CONFIG_INVALID: secure must be boolean')
    if (typeof user !== 'string' || !isEmail(user)) throw new Error('EMAIL_CONFIG_INVALID: user must be an address')
    if (fromName !== undefined && typeof fromName !== 'string') throw new Error('EMAIL_CONFIG_INVALID: fromName must be a string')
    if (typeof authCodeEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/u.test(authCodeEnv)) {
      throw new Error('EMAIL_CONFIG_INVALID: authCodeEnv must be an environment variable name')
    }
    smtp = { smtpPreset: rawPreset, host, port, secure, user, ...(fromName === undefined ? {} : { fromName }), authCodeEnv }
  }
  const minIntervalMs = source.minIntervalMs
  if (minIntervalMs !== undefined && (typeof minIntervalMs !== 'number' || !Number.isFinite(minIntervalMs) || minIntervalMs < 0)) {
    throw new Error('EMAIL_CONFIG_INVALID: minIntervalMs must be a non-negative number')
  }
  const authCodeRef = source.authCodeRef
  if (authCodeRef !== undefined && (typeof authCodeRef !== 'string' || !/^smtp:[A-Za-z0-9._-]+$/u.test(authCodeRef))) {
    throw new Error('EMAIL_CONFIG_INVALID: authCodeRef must be smtp:<projectId>')
  }
  let idleReminder: EmailConfig['idleReminder']
  if (source.idleReminder !== undefined) {
    if (typeof source.idleReminder !== 'object' || source.idleReminder === null || Array.isArray(source.idleReminder)) {
      throw new Error('EMAIL_CONFIG_INVALID: idleReminder must be an object')
    }
    const value = source.idleReminder as Record<string, unknown>
    const enabled = value.enabled === undefined ? true : value.enabled
    const minutes = value.minutes === undefined ? 10 : value.minutes
    if (typeof enabled !== 'boolean') throw new Error('EMAIL_CONFIG_INVALID: idleReminder.enabled must be boolean')
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
      throw new Error('EMAIL_CONFIG_INVALID: idleReminder.minutes must be an integer 1-1440')
    }
    idleReminder = { enabled, minutes }
  }
  return {
    enabled: source.enabled,
    provider,
    from: { email: fromRecord.email, ...(fromRecord.name === undefined ? {} : { name: fromRecord.name }) },
    recipients: recipients as string[],
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(verifiedDomains === undefined ? {} : { verifiedDomains: verifiedDomains as string[] }),
    ...smtp,
    ...(authCodeRef === undefined ? {} : { authCodeRef }),
    ...(idleReminder === undefined ? {} : { idleReminder }),
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

/**
 * IPC-facing config operations. These functions never return the secret value.
 * @module
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEmailConfig, parseEmailConfig } from './config.ts'
import type { CadreEmailNotifier } from './notifier.ts'
import type { EmailConfig, EmailResult } from './types.ts'

/** Config + presence flag safe to send to the settings UI. */
export type EmailConfigView = EmailConfig & { readonly hasKey: boolean }

/** First-run config shown before a project has saved one. */
export const DEFAULT_EMAIL_CONFIG_VIEW: EmailConfigView = {
  enabled: false,
  from: { email: '' },
  recipients: [],
  apiKeyEnv: 'SENDGRID_API_KEY',
  dryRun: false,
  minIntervalMs: 60_000,
  hasKey: false,
}

/** Whether a read error means "this project has no config file yet". */
function isMissingConfig(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Read one project config for the settings UI.
 * A missing file is a valid first-run state: return a disabled default instead
 * of surfacing ENOENT to the settings dialog.
 * @param directory - private config directory.
 * @param projectId - project id.
 * @param env - environment used only to compute `hasKey`.
 * @returns the config plus a boolean; the key value never crosses this boundary.
 */
export function getEmailConfigView(
  directory: string,
  projectId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailConfigView {
  try {
    const config = loadEmailConfig(directory, projectId)
    const hasKey = (env[config.apiKeyEnv] ?? '').trim() !== ''
    return { ...config, hasKey }
  } catch (error) {
    if (isMissingConfig(error)) return DEFAULT_EMAIL_CONFIG_VIEW
    throw error
  }
}

/**
 * Validate and persist one project config. Secret values are rejected by the
 * parser; only `apiKeyEnv` is stored.
 * @param directory - private config directory.
 * @param projectId - project id.
 * @param value - untrusted config payload.
 * @returns the stored config plus `hasKey`.
 */
export function setEmailConfig(
  directory: string,
  projectId: string,
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailConfigView {
  if (!/^[A-Za-z0-9._-]+$/u.test(projectId) || projectId === '.' || projectId === '..') {
    throw new Error('EMAIL_CONFIG_INVALID: project id is not a safe file name')
  }
  const config = parseEmailConfig(value)
  mkdirSync(directory, { recursive: true })
  const target = join(directory, `${projectId}.json`)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(temporary, target)
  const hasKey = (env[config.apiKeyEnv] ?? '').trim() !== ''
  return { ...config, hasKey }
}

/** Test-send through the shared notifier. */
export function testEmail(notifier: CadreEmailNotifier, projectId: string): Promise<EmailResult> {
  return notifier.testSend(projectId)
}

/** Render the test message without sending. */
export function dryRunEmail(notifier: CadreEmailNotifier, projectId: string): Promise<EmailResult> {
  return notifier.dryRun(projectId)
}

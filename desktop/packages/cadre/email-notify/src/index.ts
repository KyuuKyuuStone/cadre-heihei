/**
 * Cadre email notification core: per-project config, SendGrid v3 transport,
 * dedupe/rate limits, and structured failures.
 * @module @deepseek-ai/dsh-cadre-email-notify
 */
export { parseEmailConfig, loadEmailConfig } from './config.ts'
export { buildSendGridBody, redactSecret, sendWithSendGrid } from './sendgrid.ts'
export { buildResendBody, resendFailureCode, sendWithResend } from './resend.ts'
export { buildSmtpMail, sendWithSmtp } from './smtp.ts'
export { EmailSecretStore, SecretStoreUnavailableError, defaultSecretDir } from './secret-store.ts'
export type { SafeStoragePort } from './secret-store.ts'
export { PowerShellDpapi, powershellPath } from './dpapi.ts'
export type { DpapiPort } from './dpapi.ts'
export { CadreEmailNotifier, renderEmail } from './notifier.ts'
export { DEFAULT_EMAIL_CONFIG_VIEW, dryRunEmail, getEmailConfigView, setEmailConfig, testEmail } from './ipc.ts'
export type { EmailConfigView } from './ipc.ts'
export type * from './types.ts'

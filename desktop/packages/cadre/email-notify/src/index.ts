/**
 * Cadre email notification core: per-project config, SendGrid v3 transport,
 * dedupe/rate limits, and structured failures.
 * @module @deepseek-ai/dsh-cadre-email-notify
 */
export { parseEmailConfig, loadEmailConfig } from './config.ts'
export { buildSendGridBody, redactSecret, sendWithSendGrid } from './sendgrid.ts'
export { buildResendBody, isResendFromAllowed, sendWithResend } from './resend.ts'
export { CadreEmailNotifier, renderEmail } from './notifier.ts'
export { DEFAULT_EMAIL_CONFIG_VIEW, dryRunEmail, getEmailConfigView, setEmailConfig, testEmail } from './ipc.ts'
export type { EmailConfigView } from './ipc.ts'
export type * from './types.ts'

/**
 * SMTP transport for QQ/163-style mailboxes. Users provide an address and an
 * authorization code from the environment; no domain or API setup is needed.
 * @module
 */
import nodemailer from 'nodemailer'
import type { EmailMessage, EmailResult } from './types.ts'
import { redactSecret } from './sendgrid.ts'

/** One mail object accepted by Nodemailer's `sendMail`. */
export interface SmtpMail {
  readonly from: { readonly name?: string; readonly address: string }
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/** Injection seam for tests; the default uses Nodemailer. */
export interface SmtpTransport {
  sendMail(mail: SmtpMail): Promise<unknown>
}

/** Build one Nodemailer message from the rendered email. */
export function buildSmtpMail(message: EmailMessage, fromName: string | undefined): SmtpMail {
  const name = fromName ?? message.from.name
  return {
    from: { ...(name === undefined ? {} : { name }), address: message.from.email },
    to: message.to.join(', '),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
  }
}

function mapSmtpFailure(error: unknown, authCode: string): EmailResult {
  const source = error as { code?: unknown; responseCode?: unknown; message?: unknown }
  const code = typeof source.code === 'string' ? source.code : ''
  const responseCode = typeof source.responseCode === 'number' ? source.responseCode : 0
  const message = redactSecret(
    typeof source.message === 'string' ? source.message : String(error), authCode,
  ).slice(0, 500)
  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530) {
    return { ok: false, code: 'EMAIL_AUTH_FAILED', message }
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNTIMEOUT' || /timeout/i.test(message)) {
    return { ok: false, code: 'EMAIL_TIMEOUT', message }
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
    return { ok: false, code: 'EMAIL_CONNECTION_FAILED', message }
  }
  return { ok: false, code: 'EMAIL_SMTP_FAILED', message }
}

/**
 * Send one message through SMTP.
 * @param options - SMTP endpoint, authorization code, rendered message, optional transport.
 * @returns a structured result; transport failures never throw.
 */
export async function sendWithSmtp(options: {
  readonly authCode: string
  readonly message: EmailMessage
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string
  readonly fromName?: string
  readonly transport?: SmtpTransport
}): Promise<EmailResult> {
  const authCode = options.authCode.trim()
  if (authCode === '') return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: 'SMTP 授权码未配置' }
  const transport = options.transport ?? nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: authCode },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  })
  try {
    await transport.sendMail(buildSmtpMail(options.message, options.fromName))
    return { ok: true, status: 'sent' }
  } catch (error) {
    return mapSmtpFailure(error, authCode)
  }
}

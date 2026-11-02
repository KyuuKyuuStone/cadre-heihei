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
  readonly attachments?: {
    readonly filename: string
    readonly content: Buffer
    readonly contentType?: string
  }[]
}

/** Injection seam for tests; the default uses Nodemailer. */
export interface SmtpTransport {
  sendMail(mail: SmtpMail): Promise<unknown>
}

/** Connection options handed to a transport factory. */
export interface SmtpTransportOptions {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly requireTLS: boolean
  /** Force IPv4; some networks resolve IPv6 but cannot route it. */
  readonly family: 4
  readonly auth: { readonly user: string; readonly pass: string }
  readonly connectionTimeout: number
  readonly greetingTimeout: number
  readonly socketTimeout: number
}

/** Build one transport for one connection attempt (allows 465→587 retry). */
export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport

/** Build one Nodemailer message from the rendered email. */
export function buildSmtpMail(message: EmailMessage, fromName: string | undefined): SmtpMail {
  const name = fromName ?? message.from.name
  return {
    from: { ...(name === undefined ? {} : { name }), address: message.from.email },
    to: message.to.join(', '),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.attachments === undefined ? {} : {
      attachments: message.attachments.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      })),
    }),
  }
}

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
])

function errorCode(error: unknown): string {
  const source = error as { code?: unknown }
  return typeof source.code === 'string' ? source.code : ''
}

function errorDetail(error: unknown, authCode: string): string {
  const source = error as { code?: unknown; responseCode?: unknown; message?: unknown }
  const code = typeof source.code === 'string' ? source.code : ''
  const responseCode = typeof source.responseCode === 'number' ? `SMTP ${String(source.responseCode)}` : ''
  const message = typeof source.message === 'string' ? source.message : String(error)
  const detail = [code, responseCode, message].filter(part => part !== '').join(' | ')
  return redactSecret(detail, authCode).slice(0, 800)
}

function mapSmtpFailure(error: unknown, authCode: string): EmailResult {
  const code = errorCode(error)
  const source = error as { responseCode?: unknown }
  const responseCode = typeof source.responseCode === 'number' ? source.responseCode : 0
  const message = errorDetail(error, authCode)
  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530) {
    return { ok: false, code: 'EMAIL_AUTH_FAILED', message }
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNTIMEOUT' || /timeout/i.test(message)) {
    return { ok: false, code: 'EMAIL_TIMEOUT', message }
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN'
    || CERTIFICATE_CODES.has(code) || /certificate|self.signed|tls/i.test(message)) {
    return { ok: false, code: 'EMAIL_CONNECTION_FAILED', message }
  }
  return { ok: false, code: 'EMAIL_SMTP_FAILED', message }
}

function transportOptions(options: {
  host: string; port: number; secure: boolean; user: string; authCode: string; requireTLS?: boolean
}): SmtpTransportOptions {
  return {
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS === true,
    family: 4,
    auth: { user: options.user, pass: options.authCode },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  }
}

/**
 * Send one message through SMTP with an optional 465 → 587 STARTTLS fallback.
 * @param options - SMTP endpoint, authorization code, rendered message, test seams.
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
  readonly factory?: SmtpTransportFactory
}): Promise<EmailResult> {
  const authCode = options.authCode.trim()
  if (authCode === '') return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: 'SMTP 授权码未配置' }
  const factory = options.factory ?? (config => nodemailer.createTransport(config))
  const attempt = async (port: number, secure: boolean, requireTLS: boolean): Promise<EmailResult> => {
    try {
      const transport = options.transport ?? factory(transportOptions({
        host: options.host, port, secure, user: options.user, authCode, requireTLS,
      }))
      await transport.sendMail(buildSmtpMail(options.message, options.fromName))
      return { ok: true, status: 'sent' }
    } catch (error) {
      return mapSmtpFailure(error, authCode)
    }
  }
  const first = await attempt(options.port, options.secure, false)
  if (first.ok) return first
  const canFallback = options.port === 465 && options.secure
    && (first.code === 'EMAIL_CONNECTION_FAILED' || first.code === 'EMAIL_TIMEOUT')
  if (!canFallback) return first
  const fallback = await attempt(587, false, true)
  if (fallback.ok) return { ...fallback, warning: 'SMTP 465 连接失败，已回退到 587 STARTTLS' }
  return {
    ok: false,
    code: fallback.code,
    message: `SMTP 465 失败：${first.message}；587 回退失败：${fallback.message}`,
  }
}

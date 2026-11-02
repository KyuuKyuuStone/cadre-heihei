/**
 * Resend email transport over HTTPS. No SMTP, no local mail service.
 * @module
 */
import type { EmailMessage, EmailResult } from './types.ts'
import { redactSecret } from './sendgrid.ts'

const RESEND_URL = 'https://api.resend.com/emails'
const RETRYABLE = new Set([429, 500, 502, 503, 504])

/** Build the exact Resend request body for one rendered message. */
export function buildResendBody(message: EmailMessage): Record<string, unknown> {
  return {
    from: message.from.name === undefined ? message.from.email : `${message.from.name} <${message.from.email}>`,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
  }
}

/**
 * Whether a Resend From address is the test sender or a declared verified domain.
 * @param email - From address.
 * @param verifiedDomains - domains configured as verified in Resend.
 * @returns true when Resend may accept this address.
 */
export function isResendFromAllowed(email: string, verifiedDomains: readonly string[]): boolean {
  const normalized = email.trim().toLowerCase()
  if (normalized === 'onboarding@resend.dev') return true
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1)
  return domain !== '' && verifiedDomains.some(item => item.toLowerCase() === domain)
}

function retryDelay(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 250) })
}

/**
 * Send one message through Resend.
 * @param options - API key, rendered message, verified domains, optional fetch.
 * @returns a structured result; transport/config failures never throw.
 */
export async function sendWithResend(options: {
  readonly apiKey: string
  readonly message: EmailMessage
  readonly verifiedDomains: readonly string[]
  readonly fetch?: typeof globalThis.fetch
}): Promise<EmailResult> {
  const apiKey = options.apiKey.trim()
  if (apiKey === '') return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: 'Resend API key is not configured' }
  if (!isResendFromAllowed(options.message.from.email, options.verifiedDomains)) {
    return {
      ok: false,
      code: 'EMAIL_FROM_NOT_VERIFIED',
      message: `Resend 只接受已验证域名或 onboarding@resend.dev 发件；${options.message.from.email} 未在 verifiedDomains 中声明`,
    }
  }
  const doFetch = options.fetch ?? globalThis.fetch
  let lastFailure: EmailResult | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await retryDelay()
    let response: Response
    try {
      response = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildResendBody(options.message)),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      lastFailure = {
        ok: false,
        code: 'EMAIL_TRANSPORT_FAILED',
        message: redactSecret(error instanceof Error ? error.message : String(error), apiKey),
      }
      continue
    }
    if (response.ok) return { ok: true, status: 'sent' }
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      // The status still identifies the failure; the body is optional.
    }
    const message = redactSecret(`Resend HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 500)}`}`, apiKey)
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'EMAIL_AUTH_FAILED', message }
    }
    if (response.status === 422) {
      const fromFailure = /from|domain|verified/i.test(detail)
      return { ok: false, code: fromFailure ? 'EMAIL_FROM_NOT_VERIFIED' : 'EMAIL_HTTP_FAILED', message }
    }
    lastFailure = {
      ok: false,
      code: 'EMAIL_HTTP_FAILED',
      message,
    }
    if (!RETRYABLE.has(response.status)) return lastFailure
  }
  return lastFailure ?? { ok: false, code: 'EMAIL_TRANSPORT_FAILED', message: 'Resend request failed' }
}

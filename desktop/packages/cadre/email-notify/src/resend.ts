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
 * Map a provider rejection to a readable Cadre failure. Resend owns domain and
 * testing-recipient verification; this only classifies its response body.
 * @param status - HTTP status.
 * @param detail - response body excerpt.
 * @returns stable failure code.
 */
export function resendFailureCode(status: number, detail: string): string {
  if (/recipient|testing email|own email|onboarding/i.test(detail)) return 'EMAIL_RECIPIENT_RESTRICTED'
  if (/from|domain|verified|sender/i.test(detail)) return 'EMAIL_FROM_NOT_VERIFIED'
  if (status === 403 || status === 422) return 'EMAIL_FROM_NOT_VERIFIED'
  return 'EMAIL_HTTP_FAILED'
}

function retryDelay(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 250) })
}

/**
 * Send one message through Resend.
 * @param options - API key, rendered message, optional legacy verified domains, fetch.
 * @returns a structured result; transport/config failures never throw.
 */
export async function sendWithResend(options: {
  readonly apiKey: string
  readonly message: EmailMessage
  /** Legacy field; domain validation is owned by Resend and this is ignored. */
  readonly verifiedDomains?: readonly string[]
  readonly fetch?: typeof globalThis.fetch
}): Promise<EmailResult> {
  const apiKey = options.apiKey.trim()
  if (apiKey === '') return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: 'Resend API key is not configured' }
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
    if (response.status === 401) {
      return { ok: false, code: 'EMAIL_AUTH_FAILED', message }
    }
    if (response.status === 403 || response.status === 422) {
      return { ok: false, code: resendFailureCode(response.status, detail), message }
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

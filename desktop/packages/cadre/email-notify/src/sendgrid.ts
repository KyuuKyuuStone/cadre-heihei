/**
 * SendGrid v3 mail/send transport over HTTPS. No SMTP, no local mail service.
 * @module
 */
import type { EmailMessage, EmailResult } from './types.ts'

/** Build the exact SendGrid v3 request body for one rendered message. */
export function buildSendGridBody(message: EmailMessage): Record<string, unknown> {
  return {
    personalizations: [{ to: message.to.map(email => ({ email })) }],
    from: { email: message.from.email, ...(message.from.name === undefined ? {} : { name: message.from.name }) },
    subject: message.subject,
    content: [{ type: 'text/plain', value: message.text }],
  }
}

/** Remove a secret from any text that may be surfaced in logs or results. */
export function redactSecret(text: string, apiKey: string): string {
  if (apiKey === '') return text
  return text.split(apiKey).join('[redacted]')
}

/**
 * Send one message through SendGrid.
 * @param options - API key, rendered message, and optional fetch for tests.
 * @returns a structured result; transport/config failures never throw.
 */
export async function sendWithSendGrid(options: {
  readonly apiKey: string
  readonly message: EmailMessage
  readonly fetch?: typeof globalThis.fetch
}): Promise<EmailResult> {
  const apiKey = options.apiKey.trim()
  if (apiKey === '') return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: 'SendGrid API key is not configured' }
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildSendGridBody(options.message)),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return {
      ok: false,
      code: 'EMAIL_TRANSPORT_FAILED',
      message: redactSecret(error instanceof Error ? error.message : String(error), apiKey),
    }
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      // The status still identifies the failure; the body is optional.
    }
    return {
      ok: false,
      code: response.status === 401 || response.status === 403 ? 'EMAIL_AUTH_FAILED' : 'EMAIL_HTTP_FAILED',
      message: redactSecret(`SendGrid HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 500)}`}`, apiKey),
    }
  }
  return { ok: true, status: 'sent' }
}

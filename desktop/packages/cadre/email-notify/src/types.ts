/**
 * Public types for the Cadre email notification core.
 * @module
 */

/** Supported email transports. */
export type EmailProvider = 'sendgrid' | 'resend' | 'smtp'

/** SMTP provider preset. */
export type SmtpPreset = 'qq' | '163'

/** One project's email notification configuration (no secret value). */
export interface EmailConfig {
  readonly enabled: boolean
  /** Transport provider; older configs default to SendGrid. */
  readonly provider?: EmailProvider
  /** Display name for the From header; the address comes from the provider. */
  readonly from: { readonly email: string; readonly name?: string }
  readonly recipients: readonly string[]
  /** Environment variable name; defaults from `provider` when omitted. */
  readonly apiKeyEnv?: string
  /** Resend domains; retained for old configs but no longer used for sending. */
  readonly verifiedDomains?: readonly string[]
  /** QQ/163 SMTP preset; defaults to `qq` when provider is smtp. */
  readonly smtpPreset?: SmtpPreset
  /** SMTP host; preset fills it when omitted. */
  readonly host?: string
  /** SMTP port; preset fills it when omitted. */
  readonly port?: number
  /** SMTP TLS; preset fills it when omitted. */
  readonly secure?: boolean
  /** SMTP auth user; defaults to `from.email`. */
  readonly user?: string
  /** SMTP From display name override; defaults to `from.name`. */
  readonly fromName?: string
  /** Environment variable holding the SMTP authorization code. */
  readonly authCodeEnv?: string
  /** When true, render but do not call the provider. */
  readonly dryRun?: boolean
  /** Minimum gap between two sends for the same project (milliseconds). */
  readonly minIntervalMs?: number
}

/** A task line included in a delivered/verified summary. */
export interface SummaryTask {
  readonly taskId: string
  readonly title: string
  readonly assigneeName: string
  readonly status: 'delivered' | 'verified'
  readonly deliverable?: string
}

/** The two notification kinds the core supports in this release. */
export type EmailEvent =
  | { readonly kind: 'task-summary'; readonly projectId: string; readonly tasks: readonly SummaryTask[] }
  | {
    readonly kind: 'escalation'
    readonly projectId: string
    readonly taskId: string
    readonly title: string
    readonly reason: string
    readonly episodeId: string
  }

/** Rendered message before it becomes a SendGrid request. */
export interface EmailMessage {
  readonly to: readonly string[]
  readonly from: { readonly email: string; readonly name?: string }
  readonly subject: string
  readonly text: string
  /** Optional HTML alternative; omitted messages send text only. */
  readonly html?: string
}

/** Result of one notification attempt; failures never throw into the caller. */
export type EmailResult =
  | { readonly ok: true; readonly status: 'sent' | 'dry-run' | 'deduped' | 'disabled' | 'rate-limited'; readonly message?: EmailMessage }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** One SendGrid send input. */
export interface SendGridRequest {
  readonly apiKey: string
  readonly message: EmailMessage
}

/** One Resend send input. */
export interface ResendRequest {
  readonly apiKey: string
  readonly message: EmailMessage
  readonly verifiedDomains: readonly string[]
}

/** One SMTP send input. */
export interface SmtpRequest {
  readonly authCode: string
  readonly message: EmailMessage
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string
  readonly fromName?: string
}

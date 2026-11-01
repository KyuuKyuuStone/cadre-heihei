/**
 * Public types for the Cadre email notification core.
 * @module
 */

/** One project's email notification configuration (no secret value). */
export interface EmailConfig {
  readonly enabled: boolean
  /** Display name for the From header; the address comes from SendGrid. */
  readonly from: { readonly email: string; readonly name?: string }
  readonly recipients: readonly string[]
  /** Environment variable that holds the SendGrid API key; never the key itself. */
  readonly apiKeyEnv: string
  /** When true, render but do not call SendGrid. */
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

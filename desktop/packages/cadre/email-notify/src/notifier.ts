/**
 * Trigger, dedupe, rate-limit, and failure isolation for Cadre emails.
 * @module
 */
import { loadEmailConfig } from './config.ts'
import { sendWithResend } from './resend.ts'
import { sendWithSendGrid } from './sendgrid.ts'
import type { EmailConfig, EmailEvent, EmailMessage, EmailResult } from './types.ts'

interface NotifierOptions {
  /** Private directory holding `<projectId>.json` configs. */
  readonly configDir: string
  /** Environment lookup; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Injection seam for tests. */
  readonly fetch?: typeof globalThis.fetch
  /** Clock seam for rate-limit tests. */
  readonly now?: () => number
}

/** Render the subject/text for a supported event. */
export function renderEmail(event: EmailEvent, config: EmailConfig): EmailMessage {
  if (event.kind === 'task-summary') {
    const delivered = event.tasks.filter(task => task.status === 'delivered').length
    const verified = event.tasks.filter(task => task.status === 'verified').length
    const lines = event.tasks.map(task =>
      `- ${task.taskId}「${task.title}」 ${task.status} · ${task.assigneeName}${task.deliverable === undefined ? '' : ` · ${task.deliverable}`}`)
    return {
      to: config.recipients,
      from: config.from,
      subject: `[Cadre] 交付汇总：${String(event.tasks.length)} 项（待验收 ${String(delivered)} / 已验收 ${String(verified)}）`,
      text: [`项目：${event.projectId}`, `交付汇总：`, ...lines].join('\n'),
    }
  }
  return {
    to: config.recipients,
    from: config.from,
    subject: `[需要您决定] ${event.title}（${event.taskId}）`,
    text: [
      `项目：${event.projectId}`,
      `任务：${event.taskId}「${event.title}」`,
      `原因：${event.reason}`,
      `停摆周期：${event.episodeId}`,
      '请打开 Cadre Heihei 决定：催办 / 重派 / 取消 / 升级。',
    ].join('\n'),
  }
}

/** One process-local notifier shared by the Host wiring. */
export class CadreEmailNotifier {
  readonly #options: NotifierOptions
  readonly #sent = new Set<string>()
  readonly #lastSentAt = new Map<string, number>()

  constructor(options: NotifierOptions) {
    this.#options = options
  }

  /** Send a test message regardless of dedupe/min-interval (still honors enabled/dry-run). */
  async testSend(projectId: string): Promise<EmailResult> {
    return this.#deliver(projectId, {
      kind: 'escalation', projectId, taskId: 'test', title: '邮件通知测试',
      reason: '这是一封来自 Cadre Heihei 的测试邮件。', episodeId: 'test',
    }, `test:${projectId}:${String(this.#now())}`, true)
  }

  /** Render the test message without touching the network, even when dryRun is off. */
  async dryRun(projectId: string): Promise<EmailResult> {
    let config: EmailConfig
    try {
      config = loadEmailConfig(this.#options.configDir, projectId)
    } catch (error) {
      return { ok: false, code: 'EMAIL_CONFIG_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
    }
    if (!config.enabled) return { ok: true, status: 'disabled' }
    return {
      ok: true,
      status: 'dry-run',
      message: renderEmail({
        kind: 'escalation', projectId, taskId: 'test', title: '邮件通知测试',
        reason: '这是一封来自 Cadre Heihei 的测试邮件。', episodeId: 'test',
      }, config),
    }
  }

  /**
   * Trigger one notification. Never throws and never blocks the caller's flow.
   * @param event - delivered/verified summary or user-decision escalation.
   * @returns structured result.
   */
  async notify(event: EmailEvent): Promise<EmailResult> {
    const key = event.kind === 'task-summary'
      ? `summary:${event.projectId}:${event.tasks.map(task => `${task.taskId}:${task.status}`).sort().join(',')}`
      : `escalation:${event.projectId}:${event.taskId}:${event.episodeId}`
    return this.#deliver(event.projectId, event, key, false)
  }

  async #deliver(projectId: string, event: EmailEvent, key: string, force: boolean): Promise<EmailResult> {
    let config: EmailConfig
    try {
      config = loadEmailConfig(this.#options.configDir, projectId)
    } catch (error) {
      return { ok: false, code: 'EMAIL_CONFIG_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
    }
    if (!config.enabled) return { ok: true, status: 'disabled' }
    if (!force) {
      if (this.#sent.has(key)) return { ok: true, status: 'deduped' }
      const last = this.#lastSentAt.get(projectId)
      if (last !== undefined && this.#now() - last < (config.minIntervalMs ?? 60_000)) {
        return { ok: true, status: 'rate-limited' }
      }
    }
    const message = renderEmail(event, config)
    if (config.dryRun === true) return { ok: true, status: 'dry-run', message }
    const provider = config.provider ?? 'sendgrid'
    const keyEnv = config.apiKeyEnv ?? (provider === 'resend' ? 'RESEND_API_KEY' : 'SENDGRID_API_KEY')
    const apiKey = (this.#options.env ?? process.env)[keyEnv]
    if (apiKey === undefined || apiKey.trim() === '') {
      return { ok: false, code: 'EMAIL_MISSING_API_KEY', message: `环境变量 ${keyEnv} 未设置` }
    }
    const result = provider === 'resend'
      ? await sendWithResend({
        apiKey,
        message,
        verifiedDomains: config.verifiedDomains ?? [],
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      })
      : await sendWithSendGrid({
        apiKey,
        message,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      })
    if (result.ok) {
      this.#sent.add(key)
      this.#lastSentAt.set(projectId, this.#now())
    }
    return result
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

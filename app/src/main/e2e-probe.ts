/**
 * E2E-02 运行时探针：在 renderer 内订阅 → send → 等待终态 → 回读事件。
 * 只用于 CADRE_E2E=1 的显式冒烟，不进入产品路径；不记录密钥。
 */
export interface ProbedWebContents {
  executeJavaScript(code: string): Promise<unknown>
}

export interface E2eProbeOptions {
  readonly sessionId: string
  readonly body: string
  readonly otherTaskId?: string
  readonly timeoutMs?: number
}

export interface E2eProbeResult {
  readonly ok: boolean
  readonly elapsedMs?: number
  readonly receipt?: unknown
  readonly subscription?: unknown
  readonly events?: readonly {
    readonly kind: string
    readonly seq: number
    readonly epoch: number
    readonly toolName?: string
    readonly callId?: string
    readonly ok?: boolean
    readonly summary?: string
  }[]
  readonly finalText?: string
  readonly isolation?: unknown
  readonly error?: string
}

export async function runE2eProbe(
  webContents: ProbedWebContents,
  options: E2eProbeOptions,
): Promise<E2eProbeResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const idempotencyKey = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const script = `(async () => {
    const started = Date.now()
    const events = []
    let finalText = ''
    let resolveTerminal
    const terminal = new Promise((resolve) => { resolveTerminal = resolve })
    const unsub = window.cadre.onSessionEvent((event) => {
      events.push({
        kind: event.kind,
        seq: event.seq,
        epoch: event.epoch,
        ...(typeof event.text === 'string' ? { text: event.text.slice(0, 200) } : {}),
        ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
        ...(typeof event.callId === 'string' ? { callId: event.callId } : {}),
        ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}),
        ...(typeof event.summary === 'string' ? { summary: event.summary.slice(0, 200) } : {}),
      })
      if (event.kind === 'message.complete' && typeof event.text === 'string') finalText = event.text
      if (event.kind === 'message.complete' || event.kind === 'session.error' || event.kind === 'session.closed') {
        resolveTerminal()
      }
    })
    try {
      const subscription = await window.cadre.subscribeSession(${JSON.stringify({
        sessionId: options.sessionId,
        lastSeq: 0,
      })})
      const receipt = await window.cadre.sendMessage(${JSON.stringify({
        sessionId: options.sessionId,
        body: options.body,
        idempotencyKey,
      })})
      await Promise.race([
        terminal,
        new Promise((resolve) => setTimeout(resolve, ${timeoutMs})),
      ])
      const isolation = ${options.otherTaskId === undefined
        ? 'null'
        : `await window.cadre.getTask({ taskId: ${JSON.stringify(options.otherTaskId)} })`}
      unsub()
      return {
        ok:
          Boolean(receipt && receipt.ok === true) &&
          events.some((event) => event.kind === 'message.complete'),
        elapsedMs: Date.now() - started,
        receipt,
        subscription,
        events,
        finalText,
        isolation,
      }
    } catch (error) {
      unsub()
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  })()`
  try {
    return (await webContents.executeJavaScript(script)) as E2eProbeResult
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

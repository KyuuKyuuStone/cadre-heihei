/**
 * Low-risk context slimming helpers. They return bounded replacements while the
 * original session/event remains the source of truth.
 * @module
 */

/** Adjustable budgets; all callers can opt back into larger values. */
export interface SlimConfig {
  /** Character cap for one inline tool result. */
  readonly toolInlineChars: number
  /** Characters kept from an old assistant message before summarization. */
  readonly assistantSummaryChars: number
  /** Lines that must survive assistant summarization. */
  readonly preservePatterns: readonly RegExp[]
}

/** Defaults aligned with the Cadre bundle. */
export const SLIM_DEFAULTS: SlimConfig = {
  toolInlineChars: 2_000,
  assistantSummaryChars: 400,
  preservePatterns: [/约束/u, /验收/u, /禁止/u],
}

/** One tool result keyed by tool + target or command. */
export interface KeyedToolResult {
  readonly key: string
  readonly id: string
  readonly text: string
}

/** One result after head/tail truncation or same-round dedupe. */
export interface SlimToolResult {
  readonly id: string
  readonly text: string
  readonly duplicateOf?: string
  readonly truncated: boolean
}

/**
 * Keep head/tail and a locator for an oversized tool result.
 * @param text - full tool output.
 * @param locator - stable path/command reference for the full output.
 * @param inlineChars - advisory inline cap.
 * @returns bounded text.
 */
export function slimToolResult(text: string, locator: string, inlineChars = SLIM_DEFAULTS.toolInlineChars): string {
  if (Array.from(text).length <= inlineChars) return text
  const head = Math.max(0, Math.floor(inlineChars * 0.7))
  const tail = Math.max(0, inlineChars - head - 80)
  const chars = Array.from(text)
  const summary = firstLines(text, 3, 160)
  return `${chars.slice(0, head).join('')}\n\n[... ${String(chars.length - head - tail)} chars omitted; summary: ${summary}; full output: ${locator} ...]\n\n${chars.slice(-tail).join('')}`
}

/**
 * Remove repeated same-tool/same-target outputs from one round. The first full
 * value wins; later duplicates keep a locator to the first id.
 * @param results - results in call order.
 * @param inlineChars - advisory inline cap.
 * @returns deduped results with duplicate/truncation markers.
 */
export function dedupeToolResults(
  results: readonly KeyedToolResult[],
  inlineChars = SLIM_DEFAULTS.toolInlineChars,
): readonly SlimToolResult[] {
  const first = new Map<string, string>()
  return results.map(result => {
    const duplicateOf = first.get(result.key)
    if (duplicateOf !== undefined) {
      return { id: result.id, text: `[duplicate of ${duplicateOf}; same ${result.key} this round]`, duplicateOf, truncated: true }
    }
    first.set(result.key, result.id)
    return { id: result.id, text: slimToolResult(result.text, `event:${result.id}`, inlineChars), truncated: Array.from(result.text).length > inlineChars }
  })
}

/**
 * Collapse an old assistant message to a summary line while preserving
 * constraint/acceptance/forbidden lines. Original events are never deleted.
 * @param text - assistant message text.
 * @param config - summary budget and preserved patterns.
 * @returns summary text and whether it changed.
 */
export function summarizeAssistantHistory(text: string, config: SlimConfig = SLIM_DEFAULTS): { text: string; summarized: boolean } {
  const chars = Array.from(text)
  if (chars.length <= config.assistantSummaryChars) return { text, summarized: false }
  const preserved = text.split('\n').filter(line => config.preservePatterns.some(pattern => pattern.test(line)))
  const clipped = chars.slice(0, config.assistantSummaryChars).join('').trim()
  const suffix = preserved.length === 0 ? '' : `\n${preserved.slice(0, 5).join('\n')}`
  return {
    text: `${clipped}\n\n[历史摘要，原文仍保留在会话记录]${suffix}`,
    summarized: true,
  }
}

function firstLines(text: string, count: number, maxChars: number): string {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, count)
    .join(' / ').slice(0, maxChars)
}

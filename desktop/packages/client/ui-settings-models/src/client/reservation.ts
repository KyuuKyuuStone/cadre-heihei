/**
 * The read-only consequence view of one model row's output reservation.
 *
 * A stored `maxTokens` is not a capability fact: every request on the route
 * reserves it against the context window, and context compaction subtracts it
 * before computing its trigger line. A row that reserves most of the window
 * therefore compacts early and rewrites the cached prefix often — the trap a
 * user falls into without typing anything wrong. This module turns the numbers
 * the settings page legitimately owns into a display the user can read:
 * the reservation, its share of the window, and a warning when the reservation
 * exceeds the deployment's per-request default (or, when no default is
 * readable, half the window).
 *
 * Ownership boundary: the compaction headroom and absolute threshold caps are
 * composition-owned (`cordis.patch.yml`), not Settings-readable, so this view
 * deliberately does NOT spell an absolute trigger line — a number this page
 * cannot know would be a guess presented as fact. The share and the
 * above-default warning are fully owned by the values shown here.
 */

/** Positive-integer narrowing for values drafted as `unknown`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Window share at which a reservation warns even when no per-request default
 * is readable: half the window reserved for output squeezes the conversation
 * budget materially under any headroom, so the share alone carries the signal.
 */
const WINDOW_SHARE_WARNING = 0.5

/** What one row reserves and how that reads against the window and default. */
export interface ReservationView {
  /** Tokens every request on this row reserves against the window. */
  reserved: number
  /** Whether the reservation is the inherited fallback, not a stored value. */
  inherited: boolean
  /**
   * The window share as a one-decimal percent; the empty string when the
   * window is unknown, so a renderer never needs an unreachable fallback.
   */
  percent: string
  /**
   * `above-default` when the reservation exceeds the readable per-request
   * default; `window-share` when no default is readable but the share alone is
   * material; absent when neither holds.
   */
  warning: 'above-default' | 'window-share' | undefined
  /** The default to adopt, present exactly when the warning is `above-default`. */
  suggested: number | undefined
}

/** The row's drafted values plus the fallbacks its owning editor can read. */
export interface ReservationInput {
  /** The row's stored `maxTokens`, as drafted (may be absent or invalid). */
  stored: unknown
  /**
   * Reservation used when the row omits its own value: the DeepSeek family's
   * connection default; the pi-ai family passes nothing, because an omitted
   * pi-ai entry declares no cap and reserves nothing.
   */
  inherited?: unknown
  /** Effective context window for the share (stored value or readable fallback). */
  contextWindow?: unknown
  /** The deployment's per-request output default, when the editor can read it. */
  outputDefault?: unknown
}

/**
 * Compute one row's reservation view.
 * @param input - drafted row values and the editor's readable fallbacks.
 * @returns the view, or `undefined` when no positive reservation is declared
 * (nothing to show: an undeclared pi-ai row reserves nothing).
 */
export function reservationView(input: ReservationInput): ReservationView | undefined {
  const stored = positiveInt(input.stored)
  const fallback = positiveInt(input.inherited)
  const reserved = stored ?? fallback
  if (reserved === undefined) return undefined
  const window = positiveInt(input.contextWindow)
  const percent = window === undefined ? '' : (reserved / window * 100).toFixed(1)
  const outputDefault = positiveInt(input.outputDefault)
  if (outputDefault !== undefined && reserved > outputDefault) {
    return { reserved, inherited: stored === undefined, percent, warning: 'above-default', suggested: outputDefault }
  }
  const shareWarning = outputDefault === undefined && window !== undefined
    && reserved / window >= WINDOW_SHARE_WARNING
  return {
    reserved,
    inherited: stored === undefined,
    percent,
    warning: shareWarning ? 'window-share' : undefined,
    suggested: undefined,
  }
}
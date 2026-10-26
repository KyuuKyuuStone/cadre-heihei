/** Cadre seal pulse for the running Chat status; no official brand asset. */
import css from './ChatView.module.css'

/**
 * Render the decorative running mark: a rounded seal outline with a centered
 * dot, both pulsing on the current text color. CSS owns the motion, so the
 * reduced-motion preference leaves a static seal.
 * @returns the seal seat, hidden from the accessibility tree.
 */
export function RunningCadreMark() {
  return (
    <span className={css.runningCadre} aria-hidden="true">
      <span className={css.runningCadreCore} />
    </span>
  )
}

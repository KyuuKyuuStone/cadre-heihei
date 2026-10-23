import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import sealLight from './seal-light.svg'
import sealDark from './seal-dark.svg'
import css from './Brand.module.css'

/**
 * Render the Cadre seal with the presentation requested by its host surface.
 * Both variants are mounted and CSS swaps them with `body[data-ds-dark-theme]`,
 * so a theme change repaints without remounting the sidebar slot.
 * @param props - Host-supplied mark presentation.
 * @returns the seal sized to the brand row.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <span className={css.seal} style={{ width: size, height: size }}>
      <img className={css.sealLight} src={sealLight} width={size} height={size} alt="" />
      <img className={css.sealDark} src={sealDark} width={size} height={size} alt="" />
    </span>
  )
}

/**
 * Render the product name without a mark; the mark occupies its own slot.
 * @returns the Cadre Heihei wordmark.
 */
export function OfficialBrandName() {
  return <span className={css.name}>Cadre Heihei</span>
}

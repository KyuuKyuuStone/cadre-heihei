import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import sealLight from './seal-light.svg'
import sealDark from './seal-dark.svg'
import css from './Brand.module.css'

/**
 * Both seal variants stay mounted; CSS swaps them with
 * `body[data-ds-dark-theme]`, so a theme change repaints without remounting
 * the host slot.
 * @param props.size - requested square edge in pixels.
 * @returns the seal at the requested size.
 */
function Seal({ size }: { size: number }) {
  return (
    <span className={css.seal} style={{ width: size, height: size }}>
      <img className={css.sealLight} src={sealLight} width={size} height={size} alt="" />
      <img className={css.sealDark} src={sealDark} width={size} height={size} alt="" />
    </span>
  )
}

/**
 * Render the Cadre seal with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the seal sized to the brand row.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <Seal size={size} />
}

/**
 * Render the Cadre seal in the blank-session hero. The host class carries the
 * fish's hover morph, so it is not applied to the seal; the slot's 34px size
 * keeps the headline geometry.
 * @param props - host-supplied size.
 * @returns the seal sized to the headline mark.
 */
export function OfficialHeroBrandMark({ size }: HeroBrandMarkOwnerProps) {
  return <Seal size={size} />
}

/**
 * Render the product name without a mark; the mark occupies its own slot.
 * @returns the Cadre Heihei wordmark.
 */
export function OfficialBrandName() {
  return <span className={css.name}>Cadre Heihei</span>
}

import { useSyncExternalStore } from 'react'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import sealLight from './seal-light.svg'
import sealDark from './seal-dark.svg'
import css from './Brand.module.css'

/** Attribute ui-theme keeps on <body> for the dark base palette. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Follow the palette attribute rather than a CSS descendant selector: exactly
 * one seal is mounted, so a missed selector can never leave the light tile
 * visible on a dark surface.
 * @param onChange - React's store-change callback.
 * @returns teardown for the body attribute observer.
 */
function subscribeTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
  return () => { observer.disconnect() }
}

/**
 * Read the current palette from the same attribute the theme styles use.
 * @returns whether the dark base palette is active.
 */
function readDark(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute(DARK_ATTRIBUTE)
}

/**
 * Render one seal variant at the requested square size.
 * @param props.size - requested square edge in pixels.
 * @returns the light or dark seal for the active palette.
 */
function Seal({ size }: { size: number }) {
  const dark = useSyncExternalStore(subscribeTheme, readDark, () => false)
  return (
    <span className={css.seal} style={{ width: size, height: size }}>
      <img className={css.sealImage} src={dark ? sealDark : sealLight} width={size} height={size} alt="" />
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

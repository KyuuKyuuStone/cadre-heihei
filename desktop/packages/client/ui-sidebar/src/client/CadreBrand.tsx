/**
 * Cadre brand occupants for the generic sidebar/hero slots.
 *
 * This package used to be filled by the official `ui-brand-official` bundle;
 * the product now ships no official brand plugin, so the Cadre seal and
 * wordmark live beside the sidebar that renders them.
 */
import { useSyncExternalStore } from 'react'
import type { SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps } from './contract/slots.ts'
import sealLight from './CadreBrand.seal-light.svg'
import sealDark from './CadreBrand.seal-dark.svg'
import css from './CadreBrand.module.css'

/** Hero mark presentation; the conversation package's owner share is structural. */
export interface CadreHeroBrandMarkProps {
  readonly size: number
}

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
 * Render the Cadre seal with the presentation requested by the sidebar.
 * @param props - host-supplied mark presentation.
 * @returns the seal sized to the brand row.
 */
export function CadreBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <Seal size={size} />
}

/**
 * Render the Cadre seal in the blank-session hero.
 * @param props - host-supplied size.
 * @returns the seal sized to the headline mark.
 */
export function CadreHeroBrandMark({ size }: CadreHeroBrandMarkProps) {
  return <Seal size={size} />
}

/**
 * Render the product name without a mark; the mark occupies its own slot.
 * @returns the Cadre Heihei wordmark.
 */
export function CadreBrandName(_props: SidebarBrandNameOwnerProps) {
  return <span className={css.name}>Cadre Heihei</span>
}

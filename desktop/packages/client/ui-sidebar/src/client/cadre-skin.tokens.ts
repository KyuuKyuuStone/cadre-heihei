/**
 * Cadre skin: official `--dsw-alias-*` overrides for the 「昼流 / 夜流」 theme.
 * Light values come from `docs/product/design/tokens-v3.json` v3.0.0
 * (`themes.light`); dark values come from `tokens-v3.1.json` v3.1.0 (`dark`),
 * the user-decided default palette. Everything is resolved to literals rather
 * than `var(--ch-color-*)` indirections: `overrideTokens` writes these onto
 * `document.body` as inline variables and the sidebar bundle must not depend
 * on the design document at runtime.
 *
 * Dark tertiary text is raised to the secondary grey (#C9CDD1): the titanium
 * grey (#8A8D8F) only reaches 4.04:1 on the panel, below the AA requirement.
 *
 * Keys absent from tokens-v3 (previously derived residues such as
 * `button-elevated-fill`, scrollbars, `label-dimmed`, selection and focus
 * ring) are intentionally left out so they keep the official values. Static
 * `--dsw-static-*` scales stay untouched.
 */

/**
 * Master switch for the skin. Set to `false` to remove the whole override layer
 * and fall back to the official palette (no other code change needed).
 */
export const CADRE_THEME_ENABLED = true

/** Override layer identity; one layer per source in the theme registry. */
export const CADRE_THEME_SOURCE = 'ui-sidebar:cadre-warm-skin'

/** 38 paired token overrides: light from tokens-v3, dark from tokens-v3.1. */
export const CADRE_SKIN_TOKENS = {
  '--dsw-alias-bg-base': { light: '#F6F7F9', dark: '#0E141B' },
  '--dsw-alias-bg-layer-1': { light: '#F1F4F7', dark: '#1B2A41' },
  '--dsw-alias-bg-layer-2': { light: '#F1F4F7', dark: '#22303F' },
  '--dsw-alias-bg-layer-3': { light: '#E6EBF0', dark: '#323F4C' },
  '--dsw-specific-sidebar-fill': { light: '#EEF1F4', dark: '#1B2A41' },
  '--dsw-alias-settings-card-fill': { light: '#F1F4F7', dark: '#22303F' },
  '--dsw-alias-settings-card-stroke': { light: '#DAE2E9', dark: '#3E4955' },
  '--dsw-alias-border-l1': { light: '#E7ECF1', dark: '#1D2329' },
  '--dsw-alias-border-l2': { light: '#D3DAE1', dark: '#282D32' },
  '--dsw-alias-border-l3': { light: '#D3DAE1', dark: '#353A3E' },
  '--dsw-alias-border-l4': { light: '#78858F', dark: '#8A8D8F' },
  '--dsw-alias-label-primary': { light: '#1E2A35', dark: '#E8E6DE' },
  '--dsw-alias-label-secondary': { light: '#55636F', dark: '#C9CDD1' },
  '--dsw-alias-label-tertiary': { light: '#5A6874', dark: '#C9CDD1' },
  '--dsw-alias-link': { light: '#2E6B57', dark: '#C9CDD1' },
  '--dsw-alias-state-business-primary': { light: '#2E6B57', dark: '#5B8C6E' },
  '--dsw-alias-button-primary-fill': { light: '#2E6B57', dark: '#2B4C6F' },
  '--dsw-alias-button-primary-hover': { light: '#285D4B', dark: '#31567E' },
  '--dsw-alias-label-primary-foreground': { light: '#F4F7FA', dark: '#E8E6DE' },
  '--dsw-specific-bubble': { light: '#EDF1F5', dark: '#111A23' },
  '--dsw-specific-bubble-highlight': { light: '#DEE6E8', dark: '#131E2A' },
  '--dsw-specific-input-major': { light: '#EEF1F4', dark: '#0E141B' },
  '--dsw-specific-sidebar-nav-item-active': { light: '#DFE6E7', dark: '#1F314B' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#2E6B57', dark: '#5B8C6E' },
  '--dsw-alias-interactive-bg-hover': { light: '#E3E7EB', dark: '#191E25' },
  '--dsw-alias-state-error-primary': { light: '#A34A40', dark: '#D49A97' },
  '--dsw-alias-state-success-primary': { light: '#2E6B57', dark: '#5B8C6E' },
  '--dsw-alias-state-warn-primary': { light: '#436736', dark: '#C9CDD1' },
  '--dsw-alias-state-error-tertiary': { light: '#EBE0E0', dark: '#363541' },
  '--dsw-alias-state-success-tertiary': { light: '#DBE4E3', dark: '#243C44' },
  '--dsw-alias-state-warn-tertiary': { light: '#E4EBE4', dark: '#35414D' },
  '--dsw-alias-border-inverted': { light: '#D3DAE1', dark: '#42464A' },
  '--dsw-radius-xs': { light: '4px', dark: '4px' },
  '--dsw-radius-sm': { light: '8px', dark: '8px' },
  '--dsw-radius-md': { light: '12px', dark: '12px' },
  '--dsw-radius-lg': { light: '16px', dark: '16px' },
  '--dsw-radius-xl': { light: '20px', dark: '20px' },
  '--dsw-radius-panel': { light: '28px', dark: '28px' },
} satisfies Record<string, { readonly light: string; readonly dark: string }>

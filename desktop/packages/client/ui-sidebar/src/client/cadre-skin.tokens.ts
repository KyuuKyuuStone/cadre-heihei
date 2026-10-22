/**
 * Cadre warm skin: official `--dsw-alias-*` overrides for the 「纸 · 墨 · 印」
 * palette. The first 38 entries are generated from
 * `docs/product/design/tokens.json` v1.2.0 (`officialOverrides` +
 * `themes.light` / `officialDarkResolved`), resolved to literals rather than
 * `var(--ch-color-*)` indirections: `overrideTokens` writes these onto
 * `document.body` as inline variables and the sidebar bundle must not depend
 * on the design document at runtime.
 *
 * The remaining entries close cold-gray/blue residues that our own sidebar and
 * the settings surface actually consume but tokens.json's alias list does not
 * name (`button-elevated-fill`, scrollbars, `label-dimmed`, the appearance
 * cube fill, text selection, focus ring). Each maps to an existing `ch` token,
 * so no new colours are introduced; static `--dsw-static-*` scales stay
 * untouched.
 */

/**
 * Master switch for the skin. Set to `false` to remove the whole override layer
 * and fall back to the official palette (no other code change needed).
 */
export const CADRE_THEME_ENABLED = true

/** Override layer identity; one layer per source in the theme registry. */
export const CADRE_THEME_SOURCE = 'ui-sidebar:cadre-warm-skin'

/** 47 paired token overrides: 38 from tokens.json + 9 derived residues. */
export const CADRE_SKIN_TOKENS = {
  '--dsw-alias-bg-base': { light: '#F6F0E1', dark: '#201D17' },
  '--dsw-alias-bg-layer-1': { light: '#F1EBDA', dark: '#252119' },
  '--dsw-alias-bg-layer-2': { light: '#F1EBDA', dark: '#252119' },
  '--dsw-alias-bg-layer-3': { light: '#FBF7EC', dark: '#2B271F' },
  '--dsw-specific-sidebar-fill': { light: '#EDE5D1', dark: '#1A1813' },
  '--dsw-alias-settings-card-fill': { light: '#F1EBDA', dark: '#252119' },
  '--dsw-alias-settings-card-stroke': { light: '#DED2B8', dark: '#383226' },
  '--dsw-alias-border-l1': { light: '#DED2B8', dark: '#383226' },
  '--dsw-alias-border-l2': { light: '#DED2B8', dark: '#383226' },
  '--dsw-alias-border-l3': { light: '#C8B897', dark: '#867E6B' },
  '--dsw-alias-border-l4': { light: '#887B61', dark: '#867E6B' },
  '--dsw-alias-label-primary': { light: '#251E11', dark: '#EDE6D6' },
  '--dsw-alias-label-secondary': { light: '#6E6146', dark: '#A79B83' },
  '--dsw-alias-label-tertiary': { light: '#746951', dark: '#9C9080' },
  '--dsw-alias-link': { light: '#96442B', dark: '#D8855D' },
  '--dsw-alias-state-business-primary': { light: '#96442B', dark: '#D8855D' },
  '--dsw-alias-button-primary-fill': { light: '#251E11', dark: '#EDE6D6' },
  '--dsw-alias-button-primary-hover': { light: '#3A3126', dark: '#F6EFE0' },
  '--dsw-alias-label-primary-foreground': { light: '#FBF6EC', dark: '#201D17' },
  '--dsw-specific-bubble': { light: '#E5DBC3', dark: '#3B2A1E' },
  '--dsw-specific-bubble-highlight': { light: '#F0E1D0', dark: '#4A3B2A' },
  '--dsw-specific-input-major': { light: '#F1EBDA', dark: '#252119' },
  '--dsw-specific-sidebar-nav-item-active': { light: '#F0E1D0', dark: '#3E2F21' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#96442B', dark: '#D8855D' },
  '--dsw-alias-interactive-bg-hover': { light: 'rgba(90, 74, 46, 0.08)', dark: 'rgba(237, 230, 214, 0.06)' },
  '--dsw-alias-state-error-primary': { light: '#B23B2E', dark: '#E17058' },
  '--dsw-alias-state-success-primary': { light: '#3A784D', dark: '#84B383' },
  '--dsw-alias-state-warn-primary': { light: '#90641B', dark: '#D3A34C' },
  '--dsw-alias-state-error-tertiary': { light: '#FAECE8', dark: '#3A241B' },
  '--dsw-alias-state-success-tertiary': { light: '#E8F2E9', dark: '#28301D' },
  '--dsw-alias-state-warn-tertiary': { light: '#F8F0DC', dark: '#332916' },
  '--dsw-alias-border-inverted': { light: 'transparent', dark: 'transparent' },
  '--dsw-radius-xs': { light: '4px', dark: '4px' },
  '--dsw-radius-sm': { light: '8px', dark: '8px' },
  '--dsw-radius-md': { light: '12px', dark: '12px' },
  '--dsw-radius-lg': { light: '16px', dark: '16px' },
  '--dsw-radius-xl': { light: '20px', dark: '20px' },
  '--dsw-radius-panel': { light: '28px', dark: '28px' },
  // Derived residues: values reuse the designer's `ch` tokens above.
  '--dsw-alias-button-elevated-fill': { light: '#FBF7EC', dark: '#2B271F' }, // bg-raised
  '--dsw-alias-button-floating-hover': { light: '#F0E1D0', dark: '#3E2F21' }, // bg-selected
  '--dsw-alias-scrollbar-bg-l2': { light: '#DED2B8', dark: '#383226' }, // border-subtle
  '--dsw-alias-scrollbar-hover-l2': { light: '#C8B897', dark: '#4C4433' }, // border-default
  '--dsw-alias-label-dimmed': { light: '#746951', dark: '#9C9080' }, // text-tertiary
  '--dsw-alias-label-primary-inverted': { light: '#FBF6EC', dark: '#201D17' }, // on-action
  '--dsw-alias-bg-module-platform': { light: '#F1EBDA', dark: '#252119' }, // bg-surface
  '--dsw-alias-bg-document-selection': { light: '#F0E1D0', dark: '#3E2F21' }, // selection-bg
  '--dsw-focus-ring-color': { light: '#865A10', dark: '#D3A34C' }, // accent / focus-ring
} satisfies Record<string, { readonly light: string; readonly dark: string }>

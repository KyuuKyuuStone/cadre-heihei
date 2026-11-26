/** Compact-page geometry shared by the skills tab, the MCP tab and the skill library. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The three Cadre pages that adopt the compact rhythm; only skill surfaces carry category chips. */
const PAGES = [
  { name: 'CadreSkillTab', css: '../src/client/CadreSkillTab.module.css', empty: '.empty', chips: true },
  { name: 'CadreMcpTab', css: '../src/client/CadreMcpTab.module.css', empty: '.empty', chips: false },
  { name: 'CadreSkillLibrary', css: '../src/client/CadreSkillLibrary.module.css', empty: '.emptyState', chips: true },
] as const

/**
 * Read one stylesheet next to this spec.
 * @param relative - module-relative path of the CSS file.
 * @returns the file contents.
 */
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/**
 * Declarations of one exact selector, keyed by property.
 * @param css - stylesheet contents.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(css: string, selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

/**
 * Leading (vertical) length of a box shorthand such as `3px 9px`.
 * @param value - shorthand declaration value.
 * @returns the top value in pixels.
 */
function vertical(value: string | undefined): number {
  return Number.parseFloat((value ?? '').split(/\s+/)[0] ?? '')
}

describe.each(PAGES)('$name compact page', ({ css: file, empty, chips }) => {
  const css = read(file)

  it('keeps the page at its content height instead of filling the pane', () => {
    const page = declarations(css, '.page')
    expect(page?.get('min-height')).not.toBe('100%')
    expect(page?.get('height')).toBeUndefined()
    expect(css).not.toMatch(/min-height:\s*100%/)
  })

  it('uses the compact rhythm between page sections', () => {
    expect(vertical(declarations(css, '.page')?.get('gap'))).toBeLessThanOrEqual(14)
    expect(vertical(declarations(css, '.page')?.get('padding'))).toBeLessThanOrEqual(20)
    expect(vertical(declarations(css, '.header')?.get('padding-bottom'))).toBeLessThanOrEqual(10)
  })

  it('keeps cards on the tight card inset', () => {
    expect(vertical(declarations(css, '.card')?.get('padding'))).toBeLessThanOrEqual(12)
    expect(declarations(css, '.card')?.get('border-radius')).toBe('var(--dsw-radius-md)')
  })

  it.skipIf(!chips)('keeps category chips on the tight chip inset', () => {
    const chip = declarations(css, '.categoryCard')
    expect(chip?.get('padding')).toBe('3px 9px')
    expect(chip?.get('font-size')).toBe('12px')
    expect(chip?.get('line-height')).toBe('16px')
    expect(vertical(declarations(css, '.categoryCards')?.get('gap'))).toBeLessThanOrEqual(4)
  })

  it('keeps the empty state a small box', () => {
    const state = declarations(css, empty)
    expect(vertical(state?.get('padding'))).toBeLessThanOrEqual(16)
    expect(state?.get('border-radius')).toBe('var(--dsw-radius-md)')
  })

  it('keeps the card grid inside a pane narrower than one card', () => {
    // min(…, 100%) stops the track floor from overflowing a narrow pane.
    expect(css).toMatch(/minmax\(min\(\d+px, 100%\), 1fr\)/)
  })

  it('draws only from design tokens, so both themes keep working', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu)
    expect(css).not.toMatch(/\b(?:rgba?|hsla?)\(/u)
  })
})
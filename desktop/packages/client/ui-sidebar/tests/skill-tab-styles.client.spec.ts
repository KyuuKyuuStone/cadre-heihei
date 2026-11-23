/** Skills tab geometry contract: the page must never outgrow the conversation scrollport. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/CadreSkillTab.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
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

describe('CadreSkillTab.module.css', () => {
  it('keeps the capped page width inside the scrollport at narrow windows', () => {
    // Content-box padding once added 48px outside width:min(100%,880px), so the
    // trailing filter chip and the save button were clipped whenever the
    // scrollport was narrower than 928px. border-box keeps the inset inside.
    const page = declarations('.page')
    expect(page?.get('box-sizing')).toBe('border-box')
    expect(page?.get('min-width')).toBe('0')
    expect(page?.get('width')).toBe('min(100%, 880px)')
    expect(page?.get('margin')).toBe('0 auto')
  })

  it('wraps filters and category cards instead of overflowing them', () => {
    expect(declarations('.filters')?.get('flex-wrap')).toBe('wrap')
    expect(declarations('.categoryCards')?.get('flex-wrap')).toBe('wrap')
    expect(declarations('.categoryRow')?.get('max-width')).toBe('100%')
    expect(declarations('.categoryRow')?.get('min-width')).toBe('0')
  })

  it('keeps card columns from overflowing an extremely narrow scrollport', () => {
    expect(declarations('.cards')?.get('grid-template-columns')).toBe('repeat(auto-fill, minmax(min(240px, 100%), 1fr))')
  })

  it('drops to one card column and a tighter inset below 720px', () => {
    expect(css).toMatch(/@media \(max-width: 720px\)\s*\{[^}]*\.page\s*\{[^}]*padding: 16px/)
    expect(css).toMatch(/@media \(max-width: 720px\)\s*\{[\s\S]*?\.cards\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
  })
})
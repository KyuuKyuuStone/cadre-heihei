import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Dry-run must rehearse the real release order.
 *
 * Step 1.5 builds the gitignored cadre CJS; step 2 preflight fails hard when
 * its stamp is missing. If 1.5 is skipped under `--dry-run` but 2 runs, a clean
 * checkout can never pass a dry-run. This is a source-level pin because the full
 * `release.mjs --dry-run` needs Windows plus prepared installer assets; the
 * executable end-to-end evidence is attached to the hand-off report instead.
 */
const releaseSource = readFileSync(new URL('../apps/desktop/scripts/release.mjs', import.meta.url), 'utf8')

function stepLine(marker: string): string {
  const line = releaseSource.split(/\r?\n/u).find(candidate => candidate.includes(marker))
  if (line === undefined) throw new Error(`release.mjs: step ${marker} not found`)
  return line
}

describe('release dry-run step order', () => {
  it('runs the cadre build in dry-run before the preflight that needs its stamp', () => {
    expect(stepLine("'1.5-cadre-collab'")).toContain('runInDryRun: true')
    expect(stepLine("'2-preflight'")).toContain('runInDryRun: true')
    expect(releaseSource.indexOf("'1.5-cadre-collab'")).toBeLessThan(releaseSource.indexOf("'2-preflight'"))
  })
})

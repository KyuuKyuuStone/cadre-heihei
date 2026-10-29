import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CADRE_ASAR_ENTRIES,
  assertCadreAsarEntries,
  cadreAsarPath,
  cadreBundlePaths,
  ensureCadreBundles,
  readAsarFilePaths,
} from '../scripts/cadre-bundles.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function desktopRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-package-guard-'))
  roots.push(root)
  return root
}

function writeBundle(root: string, relativePath: string): void {
  const path = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '// bundle', 'utf8')
}

function writeAsar(path: string, entries: readonly string[]): void {
  const header = { files: {} as Record<string, unknown> }
  for (const entry of entries) {
    const parts = entry.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) {
      const existing = node.files[part] as { files: Record<string, unknown> } | undefined
      if (existing === undefined) {
        const created = { files: {} as Record<string, unknown> }
        node.files[part] = created
        node = created
      } else {
        node = existing
      }
    }
    node.files[parts.at(-1) ?? ''] = {}
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const buffer = Buffer.alloc(16 + json.length)
  buffer.writeUInt32LE(4, 0)
  buffer.writeUInt32LE(8 + json.length, 4)
  buffer.writeUInt32LE(json.length, 8)
  buffer.writeUInt32LE(json.length, 12)
  json.copy(buffer, 16)
  writeFileSync(path, buffer)
}

describe('ensureCadreBundles', () => {
  it('does nothing when both bundles exist', () => {
    const root = desktopRoot()
    for (const path of Object.values(cadreBundlePaths(root))) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '// bundle', 'utf8')
    }
    let built = 0
    expect(ensureCadreBundles(root, { build: () => { built += 1 } })).toEqual({ rebuilt: false })
    expect(built).toBe(0)
  })

  it('rebuilds when either bundle is missing', () => {
    const root = desktopRoot()
    writeBundle(root, 'apps/desktop/lib/cadre-collab.cjs')
    expect(ensureCadreBundles(root, {
      build: (desktop) => {
        writeBundle(desktop, 'packages/cadre/host-collab/lib/cadre-ledger.cjs')
      },
    })).toEqual({ rebuilt: true })
  })

  it('fails closed when the rebuild leaves a bundle missing', () => {
    const root = desktopRoot()
    expect(() => ensureCadreBundles(root, { build: () => {} }))
      .toThrow(/missing .*cadre-collab\.cjs.*cadre-ledger\.cjs/u)
  })
})

describe('assertCadreAsarEntries', () => {
  it('accepts an asar containing both required entries', () => {
    const root = desktopRoot()
    const asar = join(root, 'app.asar')
    writeAsar(asar, CADRE_ASAR_ENTRIES)
    expect(readAsarFilePaths(asar)).toEqual(expect.arrayContaining([...CADRE_ASAR_ENTRIES]))
    expect(() => assertCadreAsarEntries(asar)).not.toThrow()
  })

  it('rejects an asar missing the host ledger bridge', () => {
    const root = desktopRoot()
    const asar = join(root, 'app.asar')
    writeAsar(asar, CADRE_ASAR_ENTRIES.slice(0, 1))
    expect(() => assertCadreAsarEntries(asar))
      .toThrow(/app\.asar is missing dsh\/node_modules\/@deepseek-ai\/dsh-host-collab\/lib\/cadre-ledger\.cjs/u)
  })

  it('rejects a missing asar', () => {
    const root = desktopRoot()
    expect(() => assertCadreAsarEntries(join(root, 'app.asar')))
      .toThrow(/app\.asar is missing/u)
  })
})

describe('cadreAsarPath', () => {
  it('pins the Cadre compaction threshold to 150k', () => {
    const patch = readFileSync('packages/bundle/cadre-app/cordis.patch.yml', 'utf8')
    expect(patch).toContain('- id: compaction-basic')
    expect(patch).toMatch(/thresholdTokens:\s*150000/)
  })

  it('mirrors electron-builder output for Windows and macOS', () => {
    expect(cadreAsarPath({ platform: 'win32', arch: 'x64' }, 'C:/out'))
      .toBe(join('C:/out', 'win-unpacked', 'resources', 'app.asar'))
    expect(cadreAsarPath({ platform: 'darwin', arch: 'arm64' }, 'C:/out'))
      .toBe(join('C:/out', 'mac-arm64', 'Cadre Heihei.app', 'Contents', 'Resources', 'app.asar'))
  })
})

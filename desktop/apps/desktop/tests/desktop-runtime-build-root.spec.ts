import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopRuntimeBuildRoot, resolveDesktopRuntimeBuildRoot } from '../scripts/desktop-runtime-build-root.mjs'

it('defaults to a fixed per-account root outside the repository and the system temporary directory', () => {
  const root = resolveDesktopRuntimeBuildRoot({})
  expect(root).toBe(join(homedir(), '.dsh-desktop-build', 'runtime'))
  expect(isAbsolute(root)).toBe(true)
  expect(root.startsWith(tmpdir())).toBe(false)
})

it('resolves an explicit absolute override', () => {
  expect(resolveDesktopRuntimeBuildRoot({ DSH_DESKTOP_RUNTIME_BUILD_ROOT: 'D:/private-build' }))
    .toBe(resolve('D:/private-build'))
})

it.each(['', 'build', './build', 'build/root'])('rejects the non-absolute override %j', (value) => {
  expect(() => resolveDesktopRuntimeBuildRoot({ DSH_DESKTOP_RUNTIME_BUILD_ROOT: value })).toThrow(/absolute/u)
})

it('creates a fresh prefixed scratch tree inside an explicit root', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-build-root-test-'))
  try {
    const scratch = createDesktopRuntimeBuildRoot({ DSH_DESKTOP_RUNTIME_BUILD_ROOT: root })
    try {
      expect(existsSync(scratch)).toBe(true)
      expect(dirname(scratch)).toBe(resolve(root))
      expect(basename(scratch).startsWith('dsh-desktop-runtime-')).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

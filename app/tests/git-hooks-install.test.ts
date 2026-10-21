import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installHook } from '../scripts/git-hooks/install.ts'

test('installHook: 复制 hook 到目标路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-hook-'))
  try {
    const sourcePath = join(dir, 'source-pre-commit')
    const hookPath = join(dir, 'hooks', 'pre-commit')
    writeFileSync(sourcePath, '#!/usr/bin/env bash\necho quality\n')
    const result = installHook({ kind: 'pre-commit', rootDir: dir, sourcePath, hookPath })
    assert.equal(result.hookPath, hookPath)
    assert.equal(existsSync(hookPath), true)
    assert.match(readFileSync(hookPath, 'utf8'), /echo quality/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('installHook: 默认拒绝覆盖不同内容，--force 才覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-hook-'))
  try {
    const sourcePath = join(dir, 'source-pre-commit')
    const hookPath = join(dir, 'hooks', 'pre-commit')
    writeFileSync(sourcePath, '#!/usr/bin/env bash\necho new\n')
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    writeFileSync(hookPath, '#!/usr/bin/env bash\necho old\n')

    assert.throws(
      () => installHook({ kind: 'pre-commit', rootDir: dir, sourcePath, hookPath }),
      /Refusing to overwrite/,
    )

    installHook({ kind: 'pre-commit', rootDir: dir, sourcePath, hookPath, force: true })
    assert.match(readFileSync(hookPath, 'utf8'), /echo new/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

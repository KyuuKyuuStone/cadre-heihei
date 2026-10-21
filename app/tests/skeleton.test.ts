import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('smoke: app 骨架目录齐全', () => {
  for (const rel of [
    'src/ports',
    'src/adapters',
    'src/collab',
    'src/main',
    'src/preload',
    'src/renderer',
    'scripts/gates',
    'scripts/git-hooks',
    'tests',
  ]) {
    const full = join(APP_ROOT, rel)
    assert.equal(existsSync(full), true, `${rel} 不存在`)
    assert.equal(statSync(full).isDirectory(), true, `${rel} 不是目录`)
  }
})

test('smoke: 四门禁脚本与 fixture 存在', () => {
  for (const rel of [
    'scripts/gates/check-file-size.ts',
    'scripts/gates/check-import-semantics.ts',
    'scripts/gates/check-tsc-baseline.ts',
    'scripts/gates/acceptance-lib.ts',
    'scripts/gates/smoke.ts',
    'scripts/gates/fixtures/file-size/oversize.fixture',
    'scripts/gates/fixtures/import-semantics/bad-fs-import.fixture',
    'scripts/gates/fixtures/tsc/bad-type.fixture',
    'scripts/gates/fixtures/smoke/failing.test.fixture',
  ]) {
    assert.equal(existsSync(join(APP_ROOT, rel)), true, `${rel} 不存在`)
  }
})

test('smoke: 入口占位与 workspace 文件可读', () => {
  assert.match(readFileSync(join(APP_ROOT, 'src/main/index.ts'), 'utf8'), /APP_NAME = 'cadre-heihei'/)
  const workspace = readFileSync(join(APP_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const nonComment = workspace
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(nonComment, /vendor\//, 'pnpm-workspace.yaml 的 packages 不得 include vendor/')
})

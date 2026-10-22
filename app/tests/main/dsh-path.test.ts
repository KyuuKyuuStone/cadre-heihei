/** dshBin 路径解析：env 覆盖 → 打包 resources/dsh → dev 官方构建树 → SDK 默认。 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { DSH_ENTRY_SUFFIX, resolveDshBin } from '../../src/main/dsh-path.ts'

const REPO = 'C:/repo'
const RESOURCES = 'C:/install/resources'
const DEV_TREE = join(
  REPO,
  'vendor',
  'deepseek-harness',
  'apps',
  'desktop',
  '.desktop-build',
  'targets',
  'win-x64',
  'dsh',
  DSH_ENTRY_SUFFIX,
)
const PACKAGED = join(RESOURCES, 'dsh', DSH_ENTRY_SUFFIX)

test('env CADRE_DSH_BIN 优先于默认路径', () => {
  const resolved = resolveDshBin({
    env: { CADRE_DSH_BIN: 'C:/custom/dsh/bin.js' },
    isPackaged: true,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: () => true,
  })
  assert.equal(resolved, 'C:/custom/dsh/bin.js')
})

test('打包态解析 resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', () => {
  const resolved = resolveDshBin({
    env: {},
    isPackaged: true,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: (path) => path === PACKAGED,
  })
  assert.equal(resolved, PACKAGED)
})

test('dev 态解析官方构建树；缺失返回 undefined（SDK 回退 installed）', () => {
  const found = resolveDshBin({
    env: {},
    isPackaged: false,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: (path) => path === DEV_TREE,
  })
  assert.equal(found, DEV_TREE)

  const missing = resolveDshBin({
    env: {},
    isPackaged: false,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: () => false,
  })
  assert.equal(missing, undefined)
})

test('打包态路径缺失同样回退 SDK 默认', () => {
  const missing = resolveDshBin({
    env: {},
    isPackaged: true,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: () => false,
  })
  assert.equal(missing, undefined)
})

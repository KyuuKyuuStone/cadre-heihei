/** findRepoRoot：包形态从 asar/resources 命中；官方 dsh 树本身不是 SDK 根。 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { findRepoRootFrom } from '../../src/adapters/engine/harness/sdk.ts'

const SDK_MARKER = join('vendor', 'deepseek-harness', 'packages', 'sdk')

test('包形态：从 asar 内模块路径上溯到 resources/vendor', () => {
  const resources = join('C:', 'Program Files', 'cadre', 'resources')
  const start = join(resources, 'app.asar', 'dist', 'main')
  const found = findRepoRootFrom([start], (path) => path === join(resources, SDK_MARKER))
  assert.equal(found, resources)
})

test('官方 dsh 树没有 packages/，不能误判为 SDK 根', () => {
  const dshRoot = join('C:', 'install', 'dsh')
  const start = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  const found = findRepoRootFrom([start], () => false)
  assert.equal(found, undefined)
})

test('多起点时取最近可用根', () => {
  const outer = join('C:', 'repo')
  const inner = join(outer, 'app')
  const found = findRepoRootFrom(
    [join(inner, 'dist', 'main'), join(outer, 'resources')],
    (path) => path === join(inner, SDK_MARKER) || path === join(outer, SDK_MARKER),
  )
  assert.equal(found, inner)
})

#!/usr/bin/env node
/**
 * smoke.ts —— smoke/acceptance 门禁（四门禁之一，从 app/scripts/gates 迁移到 desktop）
 *
 * 迁移改动：
 *   - desktop 的测试体系是 vitest（没有 app 的 node:test 套件），因此单 runner
 *   - 只跑冒烟子集（协作状态机 + 桌面壳 + 宿主桥接），避免与 `pnpm test` 全量重复
 *   - JUnit 落 desktop/scripts/gates/evidence/smoke.junit.xml
 * 判据保持：必须收集到 >0 例，且 skipped=0、fail=0。
 *
 * 用法：node desktop/scripts/gates/smoke.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJunit } from './acceptance-lib.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_DIR = join(APP_ROOT, 'scripts/gates/evidence')
const VITEST_JUNIT = join(EVIDENCE_DIR, 'smoke.junit.xml')
const VITEST_BIN = join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

/** 冒烟子集：快、稳定、覆盖协作状态机与桌面壳的接线。 */
const SMOKE_TARGETS = [
  'cadre-collab/actor.test.ts',
  'apps/desktop/tests/cadre-projects.spec.ts',
  'apps/desktop/tests/cadre-ledger-migration.spec.ts',
  'packages/cadre/host-collab/tests',
]

mkdirSync(EVIDENCE_DIR, { recursive: true })

const args = [
  VITEST_BIN,
  'run',
  '--reporter=junit',
  `--outputFile=${VITEST_JUNIT}`,
  ...SMOKE_TARGETS,
]

const r = spawnSync(process.execPath, args, {
  cwd: APP_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const exitCode = r.status ?? -1

if (!existsSync(VITEST_JUNIT)) {
  console.error('[smoke:vitest] FAIL: JUnit 输出不存在，测试未收集到任何用例')
  if (r.stdout) console.error(r.stdout.slice(-4000))
  if (r.stderr) console.error(r.stderr.slice(-4000))
  process.exit(1)
}

const parsed = parseJunit(readFileSync(VITEST_JUNIT, 'utf8'))
console.log(`[smoke:vitest] collected tests=${parsed.total} pass=${parsed.pass} fail=${parsed.fail} skipped=${parsed.skipped}`)

let failed = false
if (parsed.total === 0 || parsed.cases.length === 0) {
  console.error('[smoke:vitest] FAIL: 收集 0 例（空跑不算通过）')
  failed = true
}
if (parsed.skipped > 0) {
  console.error(`[smoke:vitest] FAIL: 存在 ${parsed.skipped} 个 skipped 用例（smoke 不允许跳过）`)
  failed = true
}
if (parsed.fail > 0 || exitCode !== 0) {
  console.error(`[smoke:vitest] FAIL: ${parsed.fail} 个用例失败（runner exit=${exitCode}）`)
  for (const f of parsed.failures.slice(0, 20)) {
    console.error(`  - ${f.file || '<unknown>'} :: ${f.name}${f.message ? ` — ${f.message}` : ''}`)
  }
  if (r.stdout) console.error(r.stdout.slice(-4000))
  if (r.stderr) console.error(r.stderr.slice(-4000))
  failed = true
}

if (failed) {
  console.error(`[smoke] FAIL: ${parsed.pass}/${parsed.total} 通过（vitest）`)
  process.exit(1)
}
console.log(`[smoke] PASS: ${parsed.pass}/${parsed.total} 通过，0 skipped（vitest）`)

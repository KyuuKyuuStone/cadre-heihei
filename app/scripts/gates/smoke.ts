#!/usr/bin/env node
/**
 * smoke.ts —— smoke/acceptance 门禁（四门禁之一）
 *
 * 用 Node 内置 test runner 跑 app/tests，输出 JUnit，再交给
 * acceptance-lib.parseJunit 判定：
 *   - 收集 0 例 → 直接报错（不允许空跑假绿）
 *   - skipped > 0 → 报错（不允许跳过）
 *   - fail > 0 → 报错并列失败用例
 *   - total == pass 且 skipped == 0 → 通过
 *
 * 用法：node app/scripts/gates/smoke.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJunit } from './acceptance-lib.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_DIR = join(APP_ROOT, 'scripts/gates/evidence')
const JUNIT_PATH = join(EVIDENCE_DIR, 'smoke.junit.xml')

mkdirSync(EVIDENCE_DIR, { recursive: true })

const r = spawnSync(process.execPath, [
  '--test',
  '--test-reporter=junit',
  `--test-reporter-destination=${JUNIT_PATH}`,
  'tests/**/*.test.ts',
], {
  cwd: APP_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

if (!existsSync(JUNIT_PATH)) {
  console.error('[smoke] FAIL: JUnit 输出不存在，测试未收集到任何用例')
  if (r.stdout) console.error(r.stdout.slice(-4000))
  if (r.stderr) console.error(r.stderr.slice(-4000))
  process.exit(1)
}

const parsed = parseJunit(readFileSync(JUNIT_PATH, 'utf8'))
console.log(`[smoke] collected tests=${parsed.total} pass=${parsed.pass} fail=${parsed.fail} skipped=${parsed.skipped}`)

if (parsed.total === 0 || parsed.cases.length === 0) {
  console.error('[smoke] FAIL: 收集 0 例（空跑不算通过）')
  if (r.stdout) console.error(r.stdout.slice(-4000))
  if (r.stderr) console.error(r.stderr.slice(-4000))
  process.exit(1)
}

if (parsed.skipped > 0) {
  console.error(`[smoke] FAIL: 存在 ${parsed.skipped} 个 skipped 用例（smoke 不允许跳过）`)
  process.exit(1)
}

if (parsed.fail > 0 || r.status !== 0) {
  console.error(`[smoke] FAIL: ${parsed.fail} 个用例失败（test runner exit=${r.status ?? -1}）`)
  for (const f of parsed.failures.slice(0, 20)) {
    console.error(`  - ${f.file || '<unknown>'} :: ${f.name}${f.message ? ` — ${f.message}` : ''}`)
  }
  if (r.stdout) console.error(r.stdout.slice(-4000))
  if (r.stderr) console.error(r.stderr.slice(-4000))
  process.exit(1)
}

console.log(`[smoke] PASS: ${parsed.pass}/${parsed.total} 通过，0 skipped，JUnit=${JUNIT_PATH}`)

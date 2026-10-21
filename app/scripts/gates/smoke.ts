#!/usr/bin/env node
/**
 * smoke.ts —— smoke/acceptance 门禁（四门禁之一）
 *
 * 双 runner（ADR-0020 §测试与门禁 6）：
 *   - node:test：纯函数 / 协议 / 门禁自测，JUnit 落 smoke.junit.xml
 *   - vitest：组件/DOM（jsdom），JUnit 落 vitest.junit.xml
 * 每个 runner 都必须收集到 >0 例，且 skipped=0、fail=0。
 *
 * 用法：node app/scripts/gates/smoke.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJunit, type ParsedRun } from './acceptance-lib.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_DIR = join(APP_ROOT, 'scripts/gates/evidence')
const NODE_JUNIT = join(EVIDENCE_DIR, 'smoke.junit.xml')
const VITEST_JUNIT = join(EVIDENCE_DIR, 'vitest.junit.xml')
const VITEST_BIN = join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

mkdirSync(EVIDENCE_DIR, { recursive: true })

type Runner = {
  name: string
  command: string[]
  junitPath: string
}

const RUNNERS: Runner[] = [
  {
    name: 'node',
    command: [
      process.execPath,
      '--test',
      '--test-reporter=junit',
      `--test-reporter-destination=${NODE_JUNIT}`,
      'tests/**/*.test.ts',
    ],
    junitPath: NODE_JUNIT,
  },
  {
    name: 'vitest',
    command: [
      process.execPath,
      VITEST_BIN,
      'run',
      '--reporter=junit',
      `--outputFile=${VITEST_JUNIT}`,
    ],
    junitPath: VITEST_JUNIT,
  },
]

type RunnerResult = {
  name: string
  exitCode: number
  parsed: ParsedRun | null
}

const results: RunnerResult[] = []
let failed = false

for (const runner of RUNNERS) {
  const [bin, ...args] = runner.command
  const r = spawnSync(bin!, args, {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const exitCode = r.status ?? -1

  if (!existsSync(runner.junitPath)) {
    console.error(`[smoke:${runner.name}] FAIL: JUnit 输出不存在，测试未收集到任何用例`)
    if (r.stdout) console.error(r.stdout.slice(-4000))
    if (r.stderr) console.error(r.stderr.slice(-4000))
    results.push({ name: runner.name, exitCode, parsed: null })
    failed = true
    continue
  }

  const parsed = parseJunit(readFileSync(runner.junitPath, 'utf8'))
  results.push({ name: runner.name, exitCode, parsed })
  console.log(
    `[smoke:${runner.name}] collected tests=${parsed.total} pass=${parsed.pass} fail=${parsed.fail} skipped=${parsed.skipped}`,
  )

  if (parsed.total === 0 || parsed.cases.length === 0) {
    console.error(`[smoke:${runner.name}] FAIL: 收集 0 例（空跑不算通过）`)
    if (r.stdout) console.error(r.stdout.slice(-4000))
    if (r.stderr) console.error(r.stderr.slice(-4000))
    failed = true
    continue
  }

  if (parsed.skipped > 0) {
    console.error(`[smoke:${runner.name}] FAIL: 存在 ${parsed.skipped} 个 skipped 用例（smoke 不允许跳过）`)
    failed = true
  }

  if (parsed.fail > 0 || exitCode !== 0) {
    console.error(`[smoke:${runner.name}] FAIL: ${parsed.fail} 个用例失败（runner exit=${exitCode}）`)
    for (const f of parsed.failures.slice(0, 20)) {
      console.error(`  - ${f.file || '<unknown>'} :: ${f.name}${f.message ? ` — ${f.message}` : ''}`)
    }
    if (r.stdout) console.error(r.stdout.slice(-4000))
    if (r.stderr) console.error(r.stderr.slice(-4000))
    failed = true
  }
}

const total = results.reduce((sum, r) => sum + (r.parsed?.total ?? 0), 0)
const passed = results.reduce((sum, r) => sum + (r.parsed?.pass ?? 0), 0)

if (failed) {
  console.error(`[smoke] FAIL: ${passed}/${total} 通过（node:test + vitest）`)
  process.exit(1)
}

console.log(`[smoke] PASS: ${passed}/${total} 通过，0 skipped（node:test + vitest）`)

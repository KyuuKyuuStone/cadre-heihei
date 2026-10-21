/**
 * M2 §2.3 · EnginePort 契约测试——harness 侧独立脚本（不进常规 node --test）。
 *
 * 用真实 harness（W1-02 pin 构建产物 vendor/deepseek-harness + 模型凭据）跑与
 * tests/ports/contract-shared.ts 完全相同的断言集；逐用例输出 PASS/FAIL。
 *
 * 用法（凭据由调用方注入环境，本脚本不读不打印）：
 *   set -a; source D:/xxw_p/cadre-spike-env/.secrets/deepseek.env; set +a
 *   node app/scripts/m2-port-contract/run.ts --out <summary.json 路径>
 *
 * fake 专有（harness 不适用，列明 not-applicable，不静默跳过）：
 *   脚本事件注入、abort 中断、session.error/session.closed 注入、未映射错误投毒。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
void assert // shared suite 内部使用 assert；脚本自身仅转引
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessAdapter } from '../../src/adapters/engine/harness/index.ts'
import { runPortContractSuite } from '../../tests/ports/contract-shared.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1]! : undefined

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('!! DEEPSEEK_API_KEY is empty — source secrets first (exit 3)')
  process.exit(3)
}

interface CaseResult {
  readonly name: string
  readonly status: 'PASS' | 'FAIL'
  readonly ms: number
  readonly error?: string
}
const results: CaseResult[] = []
const dshBases: string[] = []
const workDirs: string[] = []
const t0 = Date.now()

const fixture = {
  name: 'harness',
  makeEngine: () => {
    const base = mkdtempSync(join(tmpdir(), 'm2c-dsh-'))
    dshBases.push(base)
    return new HarnessAdapter({
      dshHomeBase: base,
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: 300_000,
    })
  },
  makeWorkDir: (tag: string) => {
    const dir = mkdtempSync(join(tmpdir(), `m2c-wd-${tag}-`))
    workDirs.push(dir)
    return dir
  },
}

// 注册制：suite 同步注册，注册完后顺序执行（真实 harness 用例必须串行，避免凭据/资源竞争）。
const queue: Array<{ name: string; fn: () => Promise<void> | void }> = []
runPortContractSuite(fixture, (name, fn) => queue.push({ name, fn }))

for (const { name, fn } of queue) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, status: 'PASS', ms: Date.now() - started })
    console.log(`PASS ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    results.push({ name, status: 'FAIL', ms: Date.now() - started, error: message.slice(0, 500) })
    console.log(`FAIL ${name} (${Date.now() - started}ms) — ${message.slice(0, 300)}`)
  }
}

const summary = {
  suite: 'm2-port-contract(harness)',
  sharedAssertions: queue.length,
  pass: results.filter((r) => r.status === 'PASS').length,
  fail: results.filter((r) => r.status === 'FAIL').length,
  wallMs: Date.now() - t0,
  results,
  notApplicableOnHarness: [
    'abort stops production (fake 脚本事件流的中断语义)',
    'scripted event kinds（fake 脚本事件注入）',
    'session.error 注入',
    'session.closed 注入',
    'unmapped error poison（fake 脚本投毒）',
    'close→resume→ready 与 resume workdir override（fake 台账语义；harness 已关闭会话按 N15/N16 须走显式 rebuildSession，adapter 对空 patch fail-closed）',
  ],
  note: '断言集与 tests/ports/contract-shared.ts 完全一致；「能力位与实测一致」「stop 后不自动恢复」在 shared 内（判别力保留）。',
}
console.log(`SUMMARY ${summary.pass}/${summary.sharedAssertions} PASS, wall=${summary.wallMs}ms`)
if (outArg !== undefined) {
  mkdirSync(dirname(resolve(outArg)), { recursive: true })
  writeFileSync(resolve(outArg), `${JSON.stringify(summary, null, 1)}\n`, 'utf8')
}
if (summary.fail > 0) process.exitCode = 1

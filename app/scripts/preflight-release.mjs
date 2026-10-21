#!/usr/bin/env node
/**
 * preflight-release.mjs —— 出包前验证脚本（从 cc-heihei v1.7.9 迁移）
 *
 * 迁移改动：
 *   - Bun → Node；去掉 desktop/electron-builder/sidecar/CC 业务字面量
 *   - 阶段改为本仓库四门禁：file-size / import-semantics / tsc-baseline / smoke
 *   - build 阶段未适配（W1-03 仅骨架，尚无打包产物）——显式 fail-closed，不静默跳过
 *   - test/smoke 都调用 app/scripts/gates/smoke.ts（Node test runner，非空、无跳过）
 *
 * 用法：
 *   node app/scripts/preflight-release.mjs --stage gates|test|smoke|build|all [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(ROOT, '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const stageIdx = args.indexOf('--stage')
const stage = stageIdx >= 0 ? args[stageIdx + 1] : 'all'

if (args.includes('--help') || args.includes('-h')) {
  console.log(`出包前验证：node app/scripts/preflight-release.mjs [--stage gates|test|smoke|build|all] [--dry-run]

  gates  工作区干净 / 版本号 / file-size / import-semantics / tsc-baseline
  test   smoke 门禁（Node test runner，非空、无跳过）
  smoke  smoke 门禁（同上）
  build  未适配：W1-03 仅骨架，尚无打包构建（fail-closed）
  all    gates → test → smoke → build；build 未适配时以非零退出，不静默跳过`)
  process.exit(0)
}
if (!['gates', 'test', 'smoke', 'build', 'all'].includes(stage)) {
  console.error(`未知阶段: ${stage}（可选 gates|test|smoke|build|all）`)
  process.exit(2)
}

let failures = 0
function fail(msg) {
  failures++
  console.error(`FAIL ${msg}`)
}
function ok(msg) {
  console.log(`OK   ${msg}`)
}
function run(label, file, argv = []) {
  const cmd = [process.execPath, file, ...argv]
  console.log(`  $ ${cmd.join(' ')}`)
  if (dryRun) return { status: 0, stdout: '', stderr: '' }
  const r = spawnSync(process.execPath, [file, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) fail(`${label} 失败（exit ${r.status ?? -1}）`)
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function stageGates() {
  console.log('== gates ==')
  const st = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
  if (dryRun) {
    console.log('  [dry-run] 跳过工作区干净检查')
  } else if ((st.stdout ?? '').trim()) {
    for (const line of (st.stdout ?? '').trim().split('\n')) fail(`工作区不干净: ${line}`)
  } else {
    ok('工作区干净')
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(pkg.version ?? '')) fail(`版本号非法: ${pkg.version}`)
  else ok(`版本号 ${pkg.version}`)

  run('file-size', 'scripts/gates/check-file-size.ts')
  run('import-semantics', 'scripts/gates/check-import-semantics.ts')
  run('tsc-baseline', 'scripts/gates/check-tsc-baseline.ts')
}

function stageTest() {
  console.log('== test ==（smoke 门禁：非空、无跳过）')
  run('smoke', 'scripts/gates/smoke.ts')
}

function stageSmoke() {
  console.log('== smoke ==（与 test 同源：Node test runner + JUnit）')
  run('smoke', 'scripts/gates/smoke.ts')
}

function stageBuild() {
  console.log('== build ==')
  if (!existsSync(join(ROOT, 'src', 'main', 'index.ts'))) {
    fail('骨架入口缺失')
    return
  }
  fail('build 阶段未适配：W1-03 只建骨架，尚无打包/构建配置；不静默跳过、不伪造通过')
}

const t0 = Date.now()
if (stage === 'gates' || stage === 'all') stageGates()
if ((stage === 'test' || stage === 'all') && failures === 0) stageTest()
if ((stage === 'smoke' || stage === 'all') && failures === 0) stageSmoke()
if ((stage === 'build' || stage === 'all') && failures === 0) stageBuild()
console.log(`\n[preflight] 阶段=${stage} 失败=${failures} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)
process.exit(failures ? 1 : 0)

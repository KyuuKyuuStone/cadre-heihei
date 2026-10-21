#!/usr/bin/env node
/**
 * check-tsc-baseline.ts —— tsc 类型棘轮门禁（从 cc-heihei v1.7.9 迁移）
 *
 * 迁移改动：
 *   - Bun 运行时依赖移除；用 node:child_process.spawnSync 跑 tsc
 *   - 路径落到 app/tsconfig.json、app/scripts/gates/tsc-baseline.json
 *   - git show 基线路径加 app/ 前缀
 *   - import.meta.main → pathToFileURL(process.argv[1]) 判定
 *   - foldVendorForms 增加 pnpm store 形态折叠
 *   - 基线从零重算（--update），不沿用旧 902KB baseline
 *
 * 规则（只紧不松）：
 *   a) 当前签名多重集 ⊆ 基线 ⇒ PASS；减少=合法收敛
 *   b) 新增签名 / 同签名计数超 ⇒ FAIL
 *   c) 收敛后同提交 --update 下调
 *   d) --baseline-ref 防倒转：工作区基线 total 相对 ref 只许降
 * 真空自毁：解析 0 条诊断且 exit≠0 ⇒ FAIL；总数 < 基线 50% ⇒ FAIL。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const GIT_PREFIX = 'app/'
const TSC = join(APP_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js')
const TSC_HEAP_MB = '12288'
const SANITY_RATIO = 0.5

/** 双 project：Node 侧与 renderer 侧各自独立基线（ADR-0020 §测试与门禁 5）。 */
export interface TscProject {
  name: string
  tsconfigRel: string
  baselineRel: string
  comment: string
}

export const PROJECTS: readonly TscProject[] = [
  {
    name: 'node',
    tsconfigRel: 'tsconfig.json',
    baselineRel: 'scripts/gates/tsc-baseline.json',
    comment: 'app root tsc 棘轮基线（Node 侧）。只紧不松：签名计数只许降。',
  },
  {
    name: 'renderer',
    tsconfigRel: 'tsconfig.renderer.json',
    baselineRel: 'scripts/gates/tsc-renderer-baseline.json',
    comment: 'app renderer tsc 棘轮基线（DOM + react-jsx + bundler）。只紧不松：签名计数只许降。',
  },
]

export interface TscDiag {
  file: string
  line: string
  col: string
  code: string
  message: string
}

const HOME = homedir().replace(/\\/g, '/')
const APP_ROOT_SLASH = APP_ROOT.replace(/\\/g, '/')

export function foldVendorForms(s: string): string {
  let out = s.replace(/\\/g, '/')
  const rrLower = APP_ROOT_SLASH.toLowerCase()
  let idx = out.toLowerCase().indexOf(rrLower + '/')
  while (idx >= 0) {
    out = out.slice(0, idx) + out.slice(idx + rrLower.length + 1)
    idx = out.toLowerCase().indexOf(rrLower + '/')
  }
  if (out.toLowerCase().startsWith(HOME.toLowerCase() + '/')) out = '~' + out.slice(HOME.length)
  out = out.replace(/(^|\/)\.bun\/install\/cache\/([^/@]+)@[^/]*@@@\d+\//g, '$1node_modules/$2/')
  out = out.replace(/(^|\/)node_modules\/\.pnpm\/[^/]+\/node_modules\/([^/]+)\//g, '$1node_modules/$2/')
  out = out.replace(/^~\/node_modules\//g, 'node_modules/')
  while (/node_modules\/[^/]+\/node_modules\//.test(out)) {
    out = out.replace(/node_modules\/[^/]+\/node_modules\//g, 'node_modules/')
  }
  return out
}

export function normalizeFilePath(f: string): string {
  return foldVendorForms(f)
}

export function parseTscOutput(text: string): TscDiag[] {
  const out: TscDiag[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): (error TS\d+): (.*)$/.exec(raw)
    if (m) out.push({ file: normalizeFilePath(m[1]), line: m[2], col: m[3], code: m[4], message: m[5] })
  }
  return out
}

function sortLiteralUnions(s: string): string {
  return s.replace(
    /(['"])(?:[^'"\\]|\\.)*\1(?:\s*\|\s*(['"])(?:[^'"\\]|\\.)*\2)+/g,
    (m) => m.split(/\s*\|\s*/).sort().join(' | '),
  )
}

export function normalizeMessage(message: string): string {
  const firstLine = message.split(/\r?\n/)[0] ?? ''
  return sortLiteralUnions(foldVendorForms(firstLine).replace(/\d+/g, 'N'))
}

export function buildSignatures(diags: TscDiag[]): Map<string, number> {
  const sig = new Map<string, number>()
  for (const d of diags) {
    const key = `${d.file}::${d.code}::${normalizeMessage(d.message)}`
    sig.set(key, (sig.get(key) ?? 0) + 1)
  }
  return sig
}

export interface CompareResult {
  pass: boolean
  added: [string, number][]
  exceeded: [string, number, number][]
  currentTotal: number
  baselineTotal: number
}

export function compareSignatures(
  current: Map<string, number>,
  baseline: Map<string, number>,
): CompareResult {
  const added: [string, number][] = []
  const exceeded: [string, number, number][] = []
  let currentTotal = 0
  for (const [k, n] of current) {
    currentTotal += n
    const b = baseline.get(k)
    if (b === undefined) added.push([k, n])
    else if (n > b) exceeded.push([k, n, b])
  }
  let baselineTotal = 0
  for (const n of baseline.values()) baselineTotal += n
  return { pass: added.length === 0 && exceeded.length === 0, added, exceeded, currentTotal, baselineTotal }
}

export interface SanityResult {
  ok: boolean
  reason: string
}

export function sanityCheck(currentTotal: number, exitCode: number, baselineTotal: number | null): SanityResult {
  if (exitCode !== 0 && currentTotal === 0) {
    return { ok: false, reason: `tsc exit=${exitCode} 但解析到 0 条诊断 ⇒ 闸门失效（config 错误/真空检查，0 文件被检）` }
  }
  if (baselineTotal !== null && baselineTotal > 0 && currentTotal < baselineTotal * SANITY_RATIO) {
    return { ok: false, reason: `诊断总数 ${currentTotal} < 基线 ${baselineTotal} 的 ${SANITY_RATIO * 100}% ⇒ 疑似真空检查或大面积误删；若为合法大修请 --update 重建基线` }
  }
  return { ok: true, reason: '' }
}

export interface BaselineFile {
  comment: string
  version: number
  tsVersion: string
  total: number
  signatures: Record<string, number>
}

export function readBaseline(path: string): BaselineFile | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFile
}

function mapToRecord(m: Map<string, number>): Record<string, number> {
  const rec: Record<string, number> = {}
  for (const [k, v] of [...m.entries()].sort()) rec[k] = v
  return rec
}

export function runTsc(tsconfigPath: string, tscPath: string = TSC): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [tscPath, '-p', tsconfigPath, '--noEmit', '--pretty', 'false'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${TSC_HEAP_MB}` },
  })
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function parsePositionlessErrors(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line) continue
    if (/^(.+?)\(\d+,\d+\): error TS\d+: /.test(line)) continue
    const m = /error TS\d+: .+$/.exec(line)
    if (m) out.push(m[0])
  }
  return out
}

function gitShowBaseline(ref: string, baselineRel: string): BaselineFile | null {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'show', `${ref}:${GIT_PREFIX}${baselineRel}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0 || !r.stdout) return null
  try {
    return JSON.parse(r.stdout) as BaselineFile
  } catch {
    return null
  }
}

function tsVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(APP_ROOT, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

function fail(msg: string, detail: string[] = []): never {
  console.error(`[tsc-baseline] FAIL ${msg}`)
  for (const line of detail) console.error(`  ${line}`)
  process.exit(1)
}

function main(): void {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const refIdx = args.indexOf('--baseline-ref')
  const baselineRef = refIdx >= 0 ? args[refIdx + 1] ?? null : null

  for (const project of PROJECTS) {
    runProject(project, { update, baselineRef })
  }
}

function runProject(project: TscProject, opts: { update: boolean; baselineRef: string | null }): void {
  const tag = `[tsc-baseline:${project.name}]`
  const tsconfigPath = join(APP_ROOT, project.tsconfigRel)
  const baselinePath = join(APP_ROOT, project.baselineRel)

  if (!existsSync(tsconfigPath)) {
    fail(`${tag} tsconfig 不存在：${tsconfigPath}`)
  }

  if (opts.baselineRef) {
    const work = readBaseline(baselinePath)
    const ref = gitShowBaseline(opts.baselineRef, project.baselineRel)
    if (!work) fail(`${tag} 工作区无 ${baselinePath}，防倒转无法执行`)
    if (ref) {
      if (work.total > ref.total) {
        fail(`${tag} 基线 total 上调（${ref.total} → ${work.total}）⇒ 棘轮倒转，禁止（相对 ${opts.baselineRef}）`, [
          '新增签名 key 若伴随旧签名消失（合法移位）应体现为 total 不升；如确需上调请联系架构师重裁。',
        ])
      }
      console.log(`${tag} 防倒转 PASS：基线 total ${ref.total} → ${work.total}（相对 ${opts.baselineRef} 未上调）`)
    } else {
      console.log(`${tag} 防倒转跳过：${opts.baselineRef} 无基线文件（首次接入期）`)
    }
  }

  const t0 = Date.now()
  const { exitCode, stdout, stderr } = runTsc(tsconfigPath)
  const rawOutput = stdout + stderr
  const diags = parseTscOutput(rawOutput)
  const current = buildSignatures(diags)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const baseline = readBaseline(baselinePath)
  const sanity = sanityCheck(diags.length, exitCode, baseline ? baseline.total : null)
  if (!sanity.ok) {
    const dump: string[] = []
    const posless = parsePositionlessErrors(rawOutput)
    if (posless.length) {
      dump.push(`无位置的 error 行 ${posless.length} 条（config 级候选，诊断解析不收）：`)
      for (const l of posless.slice(0, 10)) dump.push(`  ${l}`)
      if (posless.length > 10) dump.push(`  …另有 ${posless.length - 10} 条未列出`)
    }
    dump.push('—— tsc stdout 前 40 行：')
    for (const l of stdout.split(/\r?\n/).filter((x) => x.trim()).slice(0, 40)) dump.push(`  | ${l}`)
    dump.push('—— tsc stderr 尾 20 行：')
    for (const l of stderr.split(/\r?\n/).filter((x) => x.trim()).slice(-20)) dump.push(`  | ${l}`)
    fail(`${tag} ${sanity.reason}`, dump)
  }

  if (opts.update) {
    if (baseline && diags.length < baseline.total * SANITY_RATIO) {
      fail(`${tag} 拒绝写入：新 total ${diags.length} < 旧基线 ${baseline.total} 的 50%（疑似真空/误删；确为大修请人工确认后重试）`)
    }
    const file: BaselineFile = {
      comment: project.comment,
      version: 1,
      tsVersion: tsVersion(),
      total: diags.length,
      signatures: mapToRecord(current),
    }
    writeFileSync(baselinePath, JSON.stringify(file, null, 2) + '\n')
    console.log(`${tag} 基线已写入：total=${diags.length}，签名数=${current.size}（tsc ${elapsed}s，exit=${exitCode}）`)
    if (baseline) console.log(`${tag} 旧基线 total=${baseline.total}（同提交下调，规则 c）`)
    return
  }

  if (!baseline) fail(`${tag} 基线文件不存在：${baselinePath}（首跑请 node app/scripts/gates/check-tsc-baseline.ts --update 生成）`)

  const cmp = compareSignatures(current, new Map(Object.entries(baseline.signatures)))
  const detail: string[] = []
  for (const [k, n] of cmp.added.slice(0, 20)) detail.push(`新增签名 x${n}: ${k}`)
  for (const [k, n, b] of cmp.exceeded.slice(0, 20)) detail.push(`计数超基线 x${n}（基线 ${b}）: ${k}`)
  if (cmp.added.length > 20) detail.push(`…另有 ${cmp.added.length - 20} 条新增签名未列出`)
  if (cmp.exceeded.length > 20) detail.push(`…另有 ${cmp.exceeded.length - 20} 条计数超未列出`)

  if (!cmp.pass) {
    fail(`${tag} 类型签名棘轮被触发（tsc ${elapsed}s，exit=${exitCode}）`, [
      `当前 total=${cmp.currentTotal} vs 基线 total=${cmp.baselineTotal}`,
      `新增签名 ${cmp.added.length} 条 / 计数超 ${cmp.exceeded.length} 条`,
      ...detail,
      '处置：修掉新增/超量类型错误；或若属合法重构移位，--update 下调基线并同提交。',
    ])
  }

  console.log(`${tag} PASS：total=${cmp.currentTotal}（基线 ${cmp.baselineTotal}），签名数=${current.size}，新增 0 / 计数超 0（tsc ${elapsed}s，exit=${exitCode}）`)
}

const invoked = process.argv[1]
if (invoked && pathToFileURL(resolve(invoked)).href === import.meta.url) main()

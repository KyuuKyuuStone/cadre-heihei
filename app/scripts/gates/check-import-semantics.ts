#!/usr/bin/env node
/**
 * check-import-semantics.ts —— import 语义检查（从 cc-heihei v1.7.9 迁移）
 *
 * 迁移改动：
 *   - 扫描根收敛为 app/src（新项目骨架）
 *   - L1 的 git 路径加 app/ 前缀；默认 L2/L3 不变
 *   - 帮助文本改为 node 调用
 *
 * L2/L3：`import * as fs from 'node:fs'` 混用 promise 方法、或具名导入与
 * promises/回调套件不匹配时失败。L1 说明符对账仍需显式传
 * --baseline/--baseline-files/--dirs，本项目暂无旧基线。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const GIT_PREFIX = 'app/'
const ROOTS = ['src']
const TEST_RE = /(\.test\.|\.spec\.|\.bench\.|__tests__)/
const SRC_RE = /\.(ts|tsx)$/

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`import 语义检查：node app/scripts/gates/check-import-semantics.ts [选项]

  （默认）                 L2+L3 形态检查，范围 app/src 非测试源码
  --baseline <rev>         加跑 L1 说明符对账（基线 git 修订）
  --baseline-files <列表>  逗号分隔的基线文件
  --dirs <列表>            逗号分隔的 L1 目标目录（相对 app/）

  退出码：0=无问题；1=有形态不符或说明符漂移`)
  process.exit(0)
}

const baselineIdx = argv.indexOf('--baseline')
const BASELINE_REV = baselineIdx >= 0 ? argv[baselineIdx + 1] ?? '' : ''
const baselineFilesIdx = argv.indexOf('--baseline-files')
const BASELINE_FILES = baselineFilesIdx >= 0 ? (argv[baselineFilesIdx + 1] ?? '').split(',').filter(Boolean) : []
const dirsIdx = argv.indexOf('--dirs')
const L1_DIRS = dirsIdx >= 0 ? (argv[dirsIdx + 1] ?? '').split(',').filter(Boolean) : []

type ImportEntry = { spec: string; symbols: string[]; namespaces: string[] }

function parseImports(src: string): ImportEntry[] {
  const out: ImportEntry[] = []
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    const clause = m[1]!.trim()
    const spec = m[2]!
    const symbols: string[] = []
    const namespaces: string[] = []
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (ns) namespaces.push(ns[1]!)
    const named = clause.match(/\{([\s\S]*)\}/)
    if (named) {
      for (const part of named[1]!.split(',')) {
        const t = part.trim().replace(/^type\s+/, '')
        if (!t) continue
        const alias = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        symbols.push(alias ? alias[1]! : t)
      }
    }
    if (!ns && !named && /^[A-Za-z_$][\w$]*$/.test(clause)) symbols.push(clause)
    out.push({ spec, symbols, namespaces })
  }
  return out
}

function isBoundary(src: string, pos: number): boolean {
  if (pos === 0) return true
  return !/[A-Za-z0-9_$.]/.test(src[pos - 1]!)
}

function scanMethodCalls(src: string, name: string): Array<{ method: string; awaits: boolean }> {
  const res: Array<{ method: string; awaits: boolean }> = []
  let i = 0
  const needle = name + '.'
  while ((i = src.indexOf(needle, i)) !== -1) {
    if (isBoundary(src, i)) {
      let j = i + needle.length
      const start = j
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++
      const method = src.slice(start, j)
      if (method) {
        let k = j
        while (k < src.length && /\s/.test(src[k]!)) k++
        if (src[k] === '(') {
          res.push({ method, awaits: /await\s*$/.test(src.slice(Math.max(0, i - 12), i)) })
        }
      }
      i = j
    } else {
      i += needle.length
    }
  }
  return res
}

function scanAwaitedCall(src: string, name: string): boolean {
  let i = 0
  while ((i = src.indexOf('await', i)) !== -1) {
    let j = i + 5
    while (j < src.length && /\s/.test(src[j]!)) j++
    if (src.startsWith(name, j)) {
      let k = j + name.length
      while (k < src.length && /\s/.test(src[k]!)) k++
      if (src[k] === '(') return true
    }
    i += 5
  }
  return false
}

const PROMISE_VARIANT: Record<string, string | null> = {
  'node:fs': 'node:fs/promises',
  'node:readline': 'node:readline/promises',
  'node:dns': 'node:dns/promises',
  'node:stream': 'node:stream/promises',
  'node:timers': 'node:timers/promises',
}
const PROMISE_MODULES = new Set(Object.values(PROMISE_VARIANT).filter(Boolean) as string[])
const PROMISE_ONLY_METHODS = new Set([
  'readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'readdir', 'mkdir', 'rm', 'unlink',
  'rmdir', 'rename', 'copyFile', 'access', 'chmod', 'utimes', 'realpath', 'readlink', 'symlink',
  'truncate', 'mkdtemp', 'cp',
])
const CALLBACK_ONLY_METHODS = new Set([
  'createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile',
  'readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync',
  'readdirSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'copyFileSync',
  'accessSync', 'realpathSync', 'readlinkSync', 'truncateSync', 'openSync', 'closeSync',
  'readSync', 'writeSync', 'mkdtempSync', 'cpSync',
])

function collect(dir: string, out: string[]) {
  const fullDir = join(APP_ROOT, dir)
  if (!existsSync(fullDir)) return
  for (const e of readdirSync(fullDir, { withFileTypes: true })) {
    const full = join(fullDir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      collect(relative(APP_ROOT, full).split(sep).join('/'), out)
      continue
    }
    if (!SRC_RE.test(e.name)) continue
    const rel = relative(APP_ROOT, full).split(sep).join('/')
    if (TEST_RE.test(rel) || rel.endsWith('.d.ts')) continue
    out.push(rel)
  }
}

const findings: string[] = []
let l1Rows = 0

if (BASELINE_REV) {
  if (!BASELINE_FILES.length || !L1_DIRS.length) {
    console.error('L1 需要 --baseline-files 与 --dirs')
    process.exit(2)
  }
  const { execFileSync } = await import('node:child_process')
  const symbolMap = new Map<string, Set<string>>()
  for (const bf of BASELINE_FILES) {
    const src = execFileSync('git', ['-C', REPO_ROOT, 'show', `${BASELINE_REV}:${GIT_PREFIX}${bf}`], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString()
    for (const e of parseImports(src)) {
      for (const s of [...e.symbols, ...e.namespaces]) {
        if (!symbolMap.has(s)) symbolMap.set(s, new Set())
        symbolMap.get(s)!.add(e.spec)
      }
    }
  }
  const files: string[] = []
  for (const d of L1_DIRS) {
    const found = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', `${GIT_PREFIX}${d}/*.ts`, `${GIT_PREFIX}${d}/*.tsx`], {
      maxBuffer: 16 * 1024 * 1024,
    }).toString().trim().split('\n').filter(Boolean)
    files.push(...found.map((f) => f.replace(new RegExp(`^${GIT_PREFIX}`), '')).filter((f) => !f.includes('__tests__')))
  }
  for (const f of files) {
    const src = readFileSync(join(APP_ROOT, f), 'utf8')
    for (const e of parseImports(src)) {
      if (e.spec.startsWith('.')) continue
      for (const sym of [...e.symbols, ...e.namespaces]) {
        const base = symbolMap.get(sym)
        if (!base) continue
        l1Rows++
        if (!base.has(e.spec)) {
          findings.push(`[L1 说明符漂移] ${f}: ${sym}: 基线 ${[...base].join('|')} ≠ 现在 ${e.spec}`)
        }
      }
    }
  }
}

const all: string[] = []
for (const r of ROOTS) collect(r, all)
for (const rel of all) {
  const src = readFileSync(join(APP_ROOT, rel), 'utf8')
  const imports = parseImports(src)
  const localOrigin = new Map<string, string>()
  for (const e of imports) {
    for (const ns of e.namespaces) localOrigin.set(ns, e.spec)
    for (const s of e.symbols) localOrigin.set(s, e.spec)
  }
  for (const [ns, spec] of localOrigin) {
    if (!(spec in PROMISE_VARIANT)) continue
    for (const { method, awaits } of scanMethodCalls(src, ns)) {
      if (PROMISE_ONLY_METHODS.has(method) && !PROMISE_MODULES.has(spec)) {
        findings.push(`[L2 形态不符] ${rel}: ${ns}.${method}(...) 是 promise 式，但 ${ns} 来自 ${spec}`)
      }
      if (CALLBACK_ONLY_METHODS.has(method) && spec !== 'node:fs') {
        findings.push(`[L2 形态不符] ${rel}: ${ns}.${method}(...) 属回调/同步套件，但 ${ns} 来自 ${spec}`)
      }
      if (awaits && spec !== 'node:fs/promises') {
        findings.push(`[L2 形态不符] ${rel}: await ${ns}.${method}(...) 要求 promises，但 ${ns} 来自 ${spec}`)
      }
    }
  }
  for (const [localName, spec] of localOrigin) {
    if (spec === 'node:fs' && PROMISE_ONLY_METHODS.has(localName) && scanAwaitedCall(src, localName)) {
      findings.push(`[L3 形态不符] ${rel}: await ${localName}(...) 是 promise 式，但具名导入自 ${spec}`)
    }
    if (PROMISE_MODULES.has(spec) && CALLBACK_ONLY_METHODS.has(localName)) {
      findings.push(`[L3 形态不符] ${rel}: ${localName} 属回调/同步套件，但具名导入自 promises 模块 ${spec}`)
    }
  }
}

console.log(`=== import 语义检查（L2/L3 app/src ${all.length} 文件${BASELINE_REV ? `；L1 基线 ${BASELINE_REV} 对账 ${l1Rows} 处` : ''}）===`)
if (findings.length === 0) {
  console.log('PASS  无形态不符、无说明符漂移')
  process.exit(0)
}
for (const f of findings) console.log(`FAIL  ${f}`)
console.log(`\n共 ${findings.length} 处问题`)
process.exit(1)

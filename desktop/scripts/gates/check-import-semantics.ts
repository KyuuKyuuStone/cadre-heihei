#!/usr/bin/env node
/* oxlint-disable typescript/no-non-null-assertion -- 正则捕获组在匹配成功后必然存在；沿用迁移实现，避免改写引入行为漂移 */
/**
 * check-import-semantics.ts —— import 语义检查 + 边界（从 app/scripts/gates 迁移到 desktop）
 *
 * 迁移改动：
 *   - 扫描根从 app/src 改为 desktop 的生产源码：`apps/<app>/src`、`packages/<组>/<包>/src`、
 *     `cadre-collab`；git 路径前缀改为 `desktop/`
 *   - §1.6 的旧骨架边界（src/ports、src/adapters、vendor/deepseek-harness）在 desktop 不成立
 *     （desktop 自己就是 dsh 的 fork，@deepseek-ai/dsh-* 是仓内工作区包），改为两条
 *     desktop 实际成立的隔离规则：
 *       UI-ISO     `packages/client/ui-*\/src/**` 与 `apps/desktop/src/client/**`
 *                  禁 node:* / electron（浏览器侧代码不碰 Node/Electron）
 *       COLLAB-ISO `cadre-collab/**` 禁 electron，禁引用 apps/** 与 packages/**
 *                  （协作状态机保持独立，不反向依赖桌面壳或产品包）
 *   - 保留 L2/L3 形态检查（node 内建模块 promise/回调套件混用）
 *
 * 覆盖：静态 `import ... from`、无 `from` 的副作用 import、`export ... from`
 * re-export、动态 `import()`、`require()`、TS `import x = require()`。
 * 扫描范围内全部 .ts/.tsx（含 *.test.ts 与 .d.ts，无测试豁免）。
 * symlink：先 realpath 再判定；无法解析的链接显式计数并打印，不静默跳过。
 *
 * L2/L3：`import * as fs from 'node:fs'` 混用 promise 方法、或具名导入与
 * promises/回调套件不匹配时失败。L1 说明符对账仍需显式传
 * --baseline/--baseline-files/--dirs，本项目暂无旧基线。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const GIT_PREFIX = 'desktop/'
const SRC_RE = /\.(ts|tsx)$/

/** desktop 的生产源码根（相对 desktop/，/ 分隔）。 */
function discoverRoots(): string[] {
  const roots: string[] = []
  const subdirs = (dir: string): string[] => {
    const full = join(APP_ROOT, dir)
    if (!existsSync(full)) return []
    return readdirSync(full, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
  }
  for (const app of subdirs('apps')) {
    if (existsSync(join(APP_ROOT, 'apps', app, 'src'))) roots.push(`apps/${app}/src`)
  }
  for (const group of subdirs('packages')) {
    for (const pkg of subdirs(`packages/${group}`)) {
      if (existsSync(join(APP_ROOT, 'packages', group, pkg, 'src'))) roots.push(`packages/${group}/${pkg}/src`)
    }
  }
  if (existsSync(join(APP_ROOT, 'cadre-collab'))) roots.push('cadre-collab')
  return roots
}

const ROOTS = discoverRoots()

const UI_PREFIXES = ['packages/client/ui-', 'apps/desktop/src/client/']
const COLLAB_PREFIX = 'cadre-collab/'
const APPS_ROOT = join(APP_ROOT, 'apps')
const PACKAGES_ROOT = join(APP_ROOT, 'packages')

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`import 语义检查：node desktop/scripts/gates/check-import-semantics.ts [选项]

  （默认）                 L2+L3 形态 + UI-ISO/COLLAB-ISO 边界检查，范围 desktop 生产源码
  --baseline <rev>         加跑 L1 说明符对账（基线 git 修订）
  --baseline-files <列表>  逗号分隔的基线文件
  --dirs <列表>            逗号分隔的 L1 目标目录（相对 desktop/）

  退出码：0=无问题；1=有形态不符或说明符漂移`)
  process.exit(0)
}

const baselineIdx = argv.indexOf('--baseline')
const BASELINE_REV = baselineIdx >= 0 ? argv[baselineIdx + 1] ?? '' : ''
const baselineFilesIdx = argv.indexOf('--baseline-files')
const BASELINE_FILES = baselineFilesIdx >= 0 ? (argv[baselineFilesIdx + 1] ?? '').split(',').filter(Boolean) : []
const dirsIdx = argv.indexOf('--dirs')
const L1_DIRS = dirsIdx >= 0 ? (argv[dirsIdx + 1] ?? '').split(',').filter(Boolean) : []

type ImportEntry = {
  spec: string
  /** 具名导入的原始名字（L1 说明符对账用）。 */
  symbols: string[]
  namespaces: string[]
  typeOnly: boolean
  /** 本地绑定名 → 原始导入名；L2/L3 按源码里真正出现的名字扫描。 */
  bindings: Array<{ local: string; imported: string }>
}

function parseImports(src: string): ImportEntry[] {
  const out: ImportEntry[] = []
  // 行首/语句边界起算，避免把注释里的「import」当成语句起点（会吞掉下一行的 type 标记）。
  const re = /(?:^|[;\n])\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (const m of src.matchAll(re)) {
    const clause = m[2]!.trim()
    const spec = m[3]!
    const symbols: string[] = []
    const namespaces: string[] = []
    const bindings: Array<{ local: string; imported: string }> = []
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (ns) {
      namespaces.push(ns[1]!)
      bindings.push({ local: ns[1]!, imported: '*' })
    }
    const named = clause.match(/\{([\s\S]*)\}/)
    const namedParts = named
      ? named[1]!.split(',').map(part => part.trim()).filter(Boolean)
      : []
    if (named) {
      for (const part of namedParts) {
        const t = part.replace(/^type\s+/, '')
        if (!t) continue
        const alias = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
        const imported = alias ? alias[1]! : t
        const local = alias ? alias[2]! : t
        symbols.push(imported)
        bindings.push({ local, imported })
      }
    }
    if (!ns && !named && /^[A-Za-z_$][\w$]*$/.test(clause)) {
      symbols.push(clause)
      bindings.push({ local: clause, imported: 'default' })
    }
    // `import type`，或具名导入每一项都是 `type X`，视为纯类型导入。
    const allNamedTypeOnly = namedParts.length > 0
      && namedParts.every(part => /^type\s+/.test(part))
    const typeOnly = Boolean(m[1]) || (allNamedTypeOnly && !ns)
    out.push({ spec, symbols, namespaces, typeOnly, bindings })
  }
  return out
}

/** `export * from` / `export * as ns from` / `export type { X } from` 的说明符 */
function parseReexports(src: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = []
  const re = /export\s+(type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    const clauseIsTypeOnly = Boolean(m[1])
    // `export * from` 是运行时再导出，即使目标全是类型也不放宽。
    const isStar = /^\s*\*/.test(m[0].slice(m[0].indexOf('export') + 6))
    out.push({ spec: m[2]!, typeOnly: clauseIsTypeOnly && !isStar })
  }
  return out
}

/** 动态 import('...') 的说明符 */
function parseDynamicImports(src: string): string[] {
  const out: string[] = []
  const re = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

/** 无 from 的副作用 import：import '...' */
function parseSideEffectImports(src: string): string[] {
  const out: string[] = []
  const re = /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/gm
  for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

/** require('...') 与 TS import x = require('...') */
function parseRequires(src: string): Array<{ spec: string; kind: 'require' | 'import-equals' }> {
  const out: Array<{ spec: string; kind: 'require' | 'import-equals' }> = []
  const importEqualsSpans: Array<[number, number]> = []
  const importEquals = /\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of src.matchAll(importEquals)) {
    out.push({ spec: m[1]!, kind: 'import-equals' })
    importEqualsSpans.push([m.index, m.index + m[0].length])
  }
  const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of src.matchAll(requireCall)) {
    const at = m.index
    if (importEqualsSpans.some(([start, end]) => at >= start && at < end)) continue
    out.push({ spec: m[1]!, kind: 'require' })
  }
  return out
}

/** realFile 为绝对路径（symlink 已跟随），相对说明符按真实目录解析。 */
function resolveRelativeSpecifier(realFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  return resolve(dirname(realFile), spec)
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * UI-ISO：浏览器侧代码的越界说明；null 表示允许。
 * 只拦 node:* 与 electron——client 目录内允许引用同 app 的类型（如 ../welcome-api.ts）。
 */
function uiViolation(_realFile: string, spec: string): string | null {
  if (spec.startsWith('node:')) return 'node:*'
  if (spec === 'electron' || spec.startsWith('electron/')) return 'electron'
  return null
}

/** COLLAB-ISO：协作状态机的越界说明；null 表示允许。 */
function collabViolation(realFile: string, spec: string): string | null {
  if (spec === 'electron' || spec.startsWith('electron/')) return 'electron'
  if (spec.startsWith('@deepseek-ai/')) return '产品包（@deepseek-ai/*）'
  const resolved = resolveRelativeSpecifier(realFile, spec)
  if (resolved !== null && (isWithin(APPS_ROOT, resolved) || isWithin(PACKAGES_ROOT, resolved))) {
    return 'apps/** 或 packages/**'
  }
  return null
}

function boundaryRuleText(rule: 'UI-ISO' | 'COLLAB-ISO'): string {
  if (rule === 'UI-ISO') return 'UI-ISO 浏览器侧禁 node:*/electron'
  return 'COLLAB-ISO 协作状态机禁 electron/apps/packages'
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

interface SourceFile {
  /** 相对 desktop/ 的展示路径（symlink 使用链接位置）。 */
  rel: string
  /** 真实绝对路径（symlink 已 realpath）。 */
  realPath: string
  symlink: boolean
}

interface SymlinkTarget {
  rel: string
  realPath: string
  kind: 'file' | 'directory'
}

interface CollectState {
  visitedDirs: Set<string>
  followedSymlinks: number
  skippedSymlinks: number
  skippedPaths: string[]
}

/**
 * 扫描源码。symlink 先 realpath：
 * - 文件链接：按真实路径读取，相对 import 按真实目录解析；
 * - 目录链接：防环递归；
 * - 无法解析的链接计入 skippedSymlinks 并打印路径，不静默跳过。
 * 不豁免 *.test.ts / *.d.ts：扫描范围内的测试与声明同样受约束。
 */
function collect(
  displayDir: string,
  realDir: string,
  out: SourceFile[],
  state: CollectState,
  symlinkTargets: SymlinkTarget[],
) {
  let resolvedDir: string
  try {
    resolvedDir = realpathSync(realDir)
  } catch {
    state.skippedSymlinks++
    state.skippedPaths.push(displayDir)
    return
  }
  if (state.visitedDirs.has(resolvedDir)) return
  state.visitedDirs.add(resolvedDir)

  let entries
  try {
    entries = readdirSync(resolvedDir, { withFileTypes: true })
  } catch {
    state.skippedSymlinks++
    state.skippedPaths.push(displayDir)
    return
  }

  for (const e of entries) {
    if (e.name === 'node_modules') continue
    const displayPath = displayDir === '' ? e.name : `${displayDir}/${e.name}`
    const full = join(resolvedDir, e.name)

    if (e.isSymbolicLink()) {
      let target: string
      let targetStat
      try {
        target = realpathSync(full)
        targetStat = statSync(target)
      } catch {
        state.skippedSymlinks++
        state.skippedPaths.push(displayPath)
        continue
      }
      state.followedSymlinks++
      if (targetStat.isDirectory()) {
        symlinkTargets.push({ rel: displayPath, realPath: target, kind: 'directory' })
        if (state.visitedDirs.has(target)) {
          state.skippedSymlinks++
          state.skippedPaths.push(displayPath)
          continue
        }
        collect(displayPath, target, out, state, symlinkTargets)
      } else if (targetStat.isFile()) {
        symlinkTargets.push({ rel: displayPath, realPath: target, kind: 'file' })
        if (SRC_RE.test(e.name)) out.push({ rel: displayPath, realPath: target, symlink: true })
      } else {
        state.skippedSymlinks++
        state.skippedPaths.push(displayPath)
      }
      continue
    }

    if (e.isDirectory()) {
      collect(displayPath, full, out, state, symlinkTargets)
      continue
    }
    if (!e.isFile() || !SRC_RE.test(e.name)) continue
    out.push({ rel: displayPath, realPath: full, symlink: false })
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
    files.push(...found.map(f => f.replace(new RegExp(`^${GIT_PREFIX}`), '')).filter(f => !f.includes('__tests__')))
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

const all: SourceFile[] = []
const symlinkTargets: SymlinkTarget[] = []
const collectState: CollectState = {
  visitedDirs: new Set<string>(),
  followedSymlinks: 0,
  skippedSymlinks: 0,
  skippedPaths: [],
}
for (const r of ROOTS) collect(r, join(APP_ROOT, r), all, collectState, symlinkTargets)

for (const file of all) {
  const src = readFileSync(file.realPath, 'utf8')
  const imports = parseImports(src)
  const localOrigin = new Map<string, string>()
  for (const e of imports) {
    for (const b of e.bindings) {
      // `{ promises as X } from 'node:fs'` 得到的就是 promises 套件，按其真实来源记。
      const origin = b.imported === 'promises' && e.spec in PROMISE_VARIANT
        ? PROMISE_VARIANT[e.spec] ?? e.spec
        : e.spec
      localOrigin.set(b.local, origin)
    }
  }
  for (const [ns, spec] of localOrigin) {
    if (!(spec in PROMISE_VARIANT)) continue
    for (const { method, awaits } of scanMethodCalls(src, ns)) {
      if (PROMISE_ONLY_METHODS.has(method) && !PROMISE_MODULES.has(spec)) {
        findings.push(`[L2 形态不符] ${file.rel}: ${ns}.${method}(...) 是 promise 式，但 ${ns} 来自 ${spec}`)
      }
      if (CALLBACK_ONLY_METHODS.has(method) && spec !== 'node:fs') {
        findings.push(`[L2 形态不符] ${file.rel}: ${ns}.${method}(...) 属回调/同步套件，但 ${ns} 来自 ${spec}`)
      }
      if (awaits && spec !== 'node:fs/promises') {
        findings.push(`[L2 形态不符] ${file.rel}: await ${ns}.${method}(...) 要求 promises，但 ${ns} 来自 ${spec}`)
      }
    }
  }
  for (const [localName, spec] of localOrigin) {
    if (spec === 'node:fs' && PROMISE_ONLY_METHODS.has(localName) && scanAwaitedCall(src, localName)) {
      findings.push(`[L3 形态不符] ${file.rel}: await ${localName}(...) 是 promise 式，但具名导入自 ${spec}`)
    }
    if (PROMISE_MODULES.has(spec) && CALLBACK_ONLY_METHODS.has(localName)) {
      findings.push(`[L3 形态不符] ${file.rel}: ${localName} 属回调/同步套件，但具名导入自 promises 模块 ${spec}`)
    }
  }
}

// ── 边界：UI-ISO + COLLAB-ISO
type SpecKind = 'import' | 're-export' | 'dynamic import' | 'side-effect import' | 'require' | 'import-equals'
let boundaryCount = 0
for (const file of all) {
  const src = readFileSync(file.realPath, 'utf8')
  const entries: Array<{ spec: string; kind: SpecKind }> = [
    ...parseImports(src).map(e => ({ spec: e.spec, kind: 'import' as const })),
    ...parseReexports(src).map(e => ({ spec: e.spec, kind: 're-export' as const })),
    ...parseDynamicImports(src).map(spec => ({ spec, kind: 'dynamic import' as const })),
    ...parseSideEffectImports(src).map(spec => ({ spec, kind: 'side-effect import' as const })),
    ...parseRequires(src).map(e => ({ spec: e.spec, kind: e.kind })),
  ]
  const ui = UI_PREFIXES.some(p => file.rel.startsWith(p))
  const collab = file.rel.startsWith(COLLAB_PREFIX)
  if (!ui && !collab) continue
  const seen = new Set<string>()
  for (const { spec, kind } of entries) {
    const key = `${kind}\u0000${spec}`
    if (seen.has(key)) continue
    seen.add(key)
    const violation = ui ? uiViolation(file.realPath, spec) : collabViolation(file.realPath, spec)
    if (violation !== null) {
      boundaryCount++
      const rule = ui ? 'UI-ISO' : 'COLLAB-ISO'
      findings.push(`[${rule}] ${file.rel}: ${kind} 越界 (${spec}) — ${boundaryRuleText(rule)}；命中 ${violation}`)
    }
  }
}

// symlink 目标按 realpath 判定：协作状态机与 UI 侧的链接也不得指向禁止区域。
for (const link of symlinkTargets) {
  if (link.rel.startsWith(COLLAB_PREFIX) && (isWithin(APPS_ROOT, link.realPath) || isWithin(PACKAGES_ROOT, link.realPath))) {
    boundaryCount++
    findings.push(`[COLLAB-ISO] ${link.rel}: symlink 指向 apps/packages (realpath=${link.realPath})`)
  }
}

const symlinkNote = `symlink 跟随 ${collectState.followedSymlinks} / 跳过 ${collectState.skippedSymlinks}`
console.log(`=== import 语义检查（L2/L3 desktop 源码 ${all.length} 文件；${symlinkNote}；UI-ISO/COLLAB-ISO${BASELINE_REV ? `；L1 基线 ${BASELINE_REV} 对账 ${l1Rows} 处` : ''}）===`)
if (collectState.skippedPaths.length > 0) {
  const shown = collectState.skippedPaths.slice(0, 10).join(', ')
  const more = collectState.skippedPaths.length > 10 ? ` …另有 ${collectState.skippedPaths.length - 10} 个` : ''
  console.log(`NOTE  无法解析/不安全的 symlink 已跳过 ${collectState.skippedSymlinks} 个：${shown}${more}`)
}
if (findings.length === 0) {
  console.log(`PASS  无形态不符、无说明符漂移、无边界违规（边界检查 ${all.length} 文件）`)
  process.exit(0)
}
for (const f of findings) console.log(`FAIL  ${f}`)
console.log(`\n共 ${findings.length} 处问题（其中边界 ${boundaryCount} 处）`)
process.exit(1)

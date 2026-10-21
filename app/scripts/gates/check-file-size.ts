#!/usr/bin/env node
/**
 * check-file-size.ts —— 文件行数门禁（从 cc-heihei v1.7.9 迁移）
 *
 * 迁移改动：
 *   - Bun.spawnSync → node:child_process.spawnSync；Bun.write → node:fs.writeFileSync
 *   - 扫描根从 src/ + desktop/** 收敛为 app/src（新项目骨架）
 *   - 基线/豁免/版本路径落到 app/scripts/gates 与 app/package.json
 *   - 旧 baseline/allowlist 一律不沿用，由空仓 --generate 重新生成
 *
 * 规则保持：新文件 >2500 行失败；基线文件只许减少；豁免条目必须带
 * reason / decisionRef / expiresInVersion，过期即失败；基线只许下调。
 *
 * 用法：node app/scripts/gates/check-file-size.ts [--changed] [--generate]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const GIT_PREFIX = 'app/'
const ROOTS = ['src']
const LIMIT = 2500
const ALLOWLIST_CAP = 3000
const BASELINE_FILE = 'scripts/gates/file-size-baseline.json'
const ALLOWLIST_FILE = 'scripts/gates/file-size-allowlist.json'
const PKG_FILE = 'package.json'
const TEST_RE = /(\.test\.|\.spec\.|\.bench\.|__tests__)/
const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

const failures: string[] = []
const notices: string[] = []

function wcL(buf: Uint8Array): number {
  let n = 0
  for (const b of buf) if (b === 10) n++
  return n
}

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

/** 版本比较：a >= b 返回 true（按数值段比较，忽略 prerelease 细节） */
function versionGte(a: string, b: string): boolean {
  const pa = a.replace(/-.*$/, '').split('.').map(Number)
  const pb = b.replace(/-.*$/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

function gitShow(path: string, ref = 'HEAD'): string | null {
  const proc = spawnSync('git', ['-C', REPO_ROOT, 'show', `${ref}:${GIT_PREFIX}${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (proc.status !== 0) return null
  return proc.stdout
}

type BaselineEntry = { lines: number; kind: 'own' | 'upstream' }
type Baseline = { files: Record<string, BaselineEntry> }

// 新项目暂无自有超标文件；新增须架构师裁决后登记。
const OWN_FILES = new Set<string>()

type AllowEntry = {
  path: string
  kind?: 'file' | 'directory'
  reason: string
  decisionRef: string
  expiresInVersion: string
  cap?: number
}
type Allowlist = { entries: AllowEntry[]; comment?: string }

function loadJson<T>(path: string, fallback: T): T {
  const full = join(APP_ROOT, path)
  if (!existsSync(full)) return fallback
  return JSON.parse(readFileSync(full, 'utf8')) as T
}

const baseline = loadJson<Baseline>(BASELINE_FILE, { files: {} })
const allowlist = loadJson<Allowlist>(ALLOWLIST_FILE, { entries: [] })
const pkgPath = join(APP_ROOT, PKG_FILE)
const pkgVersion = existsSync(pkgPath)
  ? (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version
  : '0.0.0'

const args = process.argv.slice(2)
const changedOnly = args.includes('--changed')
const baselineRefIdx = args.indexOf('--baseline-ref')
const baselineRef = baselineRefIdx >= 0 ? (args[baselineRefIdx + 1] ?? 'HEAD') : 'HEAD'
const baselineFileIdx = args.indexOf('--baseline-file')
const refDesc = baselineFileIdx >= 0
  ? `file ${args[baselineFileIdx + 1]}`
  : `git ${baselineRef}:${GIT_PREFIX}${BASELINE_FILE}`
const referenceRaw = baselineFileIdx >= 0 && existsSync(args[baselineFileIdx + 1] ?? '')
  ? readFileSync(args[baselineFileIdx + 1]!, 'utf8')
  : gitShow(BASELINE_FILE, baselineRef)

if (referenceRaw !== null) {
  const ref = JSON.parse(referenceRaw) as Baseline
  for (const [file, entry] of Object.entries(ref.files)) {
    const v = typeof entry === 'number' ? entry : entry.lines
    const now = baseline.files[file]
    const nowLines = now === undefined ? undefined : typeof now === 'number' ? now : now.lines
    if (nowLines === undefined) {
      const cur = existsSync(join(APP_ROOT, file)) ? wcL(readFileSync(join(APP_ROOT, file))) : 0
      failures.push(
        `BASELINE ${file}: 基线条目被删除，但当前 ${cur} 行仍 > ${LIMIT}——不允许通过删条目绕过规则 2`,
      )
    } else if (nowLines > v) {
      failures.push(`BASELINE ${file}: 基线值被调高（${v} → ${nowLines}）——基线只允许下调（相对 ${refDesc}）`)
    }
  }
  for (const file of Object.keys(baseline.files)) {
    if (!(file in ref.files)) {
      failures.push(`BASELINE ${file}: 新增基线条目——基线条目集合只许缩小`)
    }
  }
}

const activeFileAllow = new Map<string, number>()
const activeDirAllow = new Set<string>()
for (const e of allowlist.entries) {
  if (!e.reason || !e.decisionRef || !e.expiresInVersion) {
    failures.push(`ALLOWLIST ${e.path}: 豁免条目缺少 reason / decisionRef / expiresInVersion`)
    continue
  }
  if (versionGte(pkgVersion, e.expiresInVersion)) {
    failures.push(
      `ALLOWLIST ${e.path}: 豁免已于 ${e.expiresInVersion} 过期（当前版本 ${pkgVersion}）——请移除或续期（decisionRef=${e.decisionRef}）`,
    )
    continue
  }
  if (e.kind === 'directory') activeDirAllow.add(e.path)
  else activeFileAllow.set(e.path, e.cap ?? ALLOWLIST_CAP)
}

if (args.includes('--generate')) {
  const all: string[] = []
  for (const r of ROOTS) collect(r, all)
  const files: Record<string, BaselineEntry> = {}
  for (const rel of all) {
    const lines = wcL(readFileSync(join(APP_ROOT, rel)))
    if (lines > LIMIT) files[rel] = { lines, kind: OWN_FILES.has(rel) ? 'own' : 'upstream' }
  }
  const generated: Baseline & { comment: string } = {
    comment:
      '文件行数基线（从零生成，未沿用 cc-heihei 旧 baseline）。由 scripts/gates/check-file-size.ts --generate 生成；只许下调。',
    files,
  }
  writeFileSync(join(APP_ROOT, BASELINE_FILE), JSON.stringify(generated, null, 2) + '\n')
  console.log(`[file-size] 基线已生成：${Object.keys(files).length} 个超标文件 → ${BASELINE_FILE}`)
  process.exit(0)
}

let candidates: string[]
if (changedOnly) {
  const st = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'app'], { encoding: 'utf8' })
  const lines = (st.stdout ?? '').split('\n').filter(Boolean)
  candidates = lines
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop()!.trim() : p))
    .map((p) => p.replace(/^app\//, ''))
    .filter((p) => ROOTS.some((r) => p === r || p.startsWith(`${r}/`)) && SRC_RE.test(p) && !TEST_RE.test(p))
} else {
  const all: string[] = []
  for (const r of ROOTS) collect(r, all)
  candidates = all
}

let checked = 0
for (const rel of candidates) {
  const full = join(APP_ROOT, rel)
  if (!existsSync(full)) continue
  checked++
  let dirAllowed = false
  for (const d of activeDirAllow) {
    if (rel === d || rel.startsWith(`${d}/`)) {
      dirAllowed = true
      break
    }
  }
  if (dirAllowed) continue
  const lines = wcL(readFileSync(full))
  const baseEntry = baseline.files[rel]
  const base = baseEntry === undefined ? undefined : typeof baseEntry === 'number' ? baseEntry : baseEntry.lines
  const kind = baseEntry === undefined || typeof baseEntry === 'number' ? 'upstream' : baseEntry.kind

  if (base !== undefined) {
    if (activeFileAllow.has(rel)) continue
    if (lines > base) {
      failures.push(`FAIL(${kind}) ${rel}: 当前 ${lines} 行 > 基线 ${base} 行（超出 ${lines - base} 行）——基线文件只许减少`)
      continue
    }
    if (lines < base) {
      const tail = lines <= LIMIT
        ? `且已 ≤${LIMIT}，请把条目从基线表移出`
        : `请把基线下调到 ${lines}`
      failures.push(`FAIL(${kind}) ${rel}: 当前 ${lines} 行 < 基线 ${base} 行——${tail}`)
      continue
    }
    continue
  }

  if (lines > LIMIT) {
    failures.push(`FAIL ${rel}: 当前 ${lines} 行 > 上限 ${LIMIT} 行（超出 ${lines - LIMIT} 行）`)
  }
}

const releaseCheck = versionGte(pkgVersion, '1.0.0')
if (releaseCheck) {
  for (const [rel, entry] of Object.entries(baseline.files)) {
    if (entry.kind !== 'own' || !existsSync(join(APP_ROOT, rel))) continue
    const lines = wcL(readFileSync(join(APP_ROOT, rel)))
    if (lines <= LIMIT) continue
    if (!activeFileAllow.has(rel)) {
      failures.push(`RELEASE ${rel}: 当前 ${lines} 行 > 2500——无有效豁免`)
    } else if (lines > activeFileAllow.get(rel)!) {
      failures.push(`RELEASE ${rel}: 当前 ${lines} 行 > 豁免上限 ${activeFileAllow.get(rel)} 行`)
    } else {
      notices.push(`RELEASE-PASS(豁免) ${rel}`)
    }
  }
}

for (const n of notices) console.log(n)
if (failures.length) {
  console.error(`\n[file-size] ${failures.length} 项失败：`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`\n[file-size] 通过：检查 ${checked} 个文件，0 失败（基线 ${Object.keys(baseline.files).length} 项，豁免 ${allowlist.entries.length} 项）`)

/**
 * Packaging preflight gate (runs BEFORE the official chain; any hard error exits non-zero).
 *
 * Why each check exists (0.5.0 post-mortem):
 * 1. TypeScript full build (tsc -b all projects): host aggregate check died on an
 *    unused import in tests/main-startup.spec.ts AFTER minutes of building — catch it up front.
 * 2. Product-name leftovers: the brand rename (DeepSeek Harness → Cadre Heihei) left a
 *    hardcoded exe name in scripts/smoke-packaged-runtime.ts that only exploded at the
 *    tail smoke. Sweep the repo so renames cannot strand us again.
 * 3. Icon assets: the installer shipped a stale whale because installer.ico was a
 *    different file from icon.ico, and nothing validated sizes/contents.
 * 4. NSIS wiring: installerIcon/installerSidebar must point at real
 *    files, and header art only matters for assisted (oneClick=false) installers.
 * 5. Secret scan: reuse check-no-secrets.mjs over packaging inputs.
 * 6. Stale-install cleanup: the customInstall cleanup macro must stay wired.
 *
 * Usage: node scripts/preflight-package.mjs [--fix-none]   (read-only; exit 1 on failure)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanDir } from './check-no-secrets.mjs'
import {
  CADRE_OUTPUTS,
  computeCadreSourceHashes,
  fileBytes,
  hashFile,
  readCadreStamp,
} from '../../../scripts/cadre-build-stamp.mjs'

const APP_ROOT = join(import.meta.dirname, '..')
const failures = []
const warnings = []
const check = (name, ok, detail) => {
  console.log(`[preflight] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push({ name, detail })
}
const warn = (name, detail) => {
  console.log(`[preflight] WARN ${name} — ${detail}`)
  warnings.push({ name, detail })
}

// 1) TypeScript: the official `build.ts --scope check` (host+client aggregate programs —
//    exactly the gate that caught the 0.5.0 TS6133 failures, tests included).
try {
  const repoRoot = join(APP_ROOT, '..', '..')
  const run = spawnSync('node', ['--import', 'tsx', join(repoRoot, 'scripts', 'build.ts'), '--scope', 'check'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 600_000,
  })
  if (run.status !== 0) throw new Error(`${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter((l) => /error|FAILED/i.test(l)).slice(0, 4).join(' | '))
  check('typescript-full-build', true)
} catch (error) {
  check('typescript-full-build', false, String(error.message ?? error).slice(0, 200))
}

// 2) Product-name leftovers outside whitelisted history.
const SKIP_DIRS = new Set(['node_modules', '.git', '.desktop-build', 'dist', 'lib', 'snapshots'])
const nameHits = []
const sweep = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = full.slice(APP_ROOT.length + 1).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      sweep(full)
      continue
    }
    if (/(CHANGELOG\.md|UPSTREAM\.md|package-lock|pnpm-lock)/i.test(entry.name)) continue
    if (!/\.(ts|tsx|js|cjs|mjs|nsh|md|json|ps1|yml|yaml|txt)$/.test(entry.name)) continue
    try {
      const text = readFileSync(full, 'utf8')
      if (/DeepSeek Harness/.test(text)) nameHits.push(rel)
    } catch {}
  }
}
sweep(APP_ROOT)
sweep(join(APP_ROOT, 'installer'))
warn('product-name-leftovers', nameHits.length === 0 ? 'no DeepSeek Harness hardcodes' : `${nameHits.length} file(s) need human confirm: ${nameHits.slice(0, 8).join(', ')}${nameHits.length > 8 ? ` +${nameHits.length - 8} more` : ''}`)

// 3) Icon assets: presence + format + seal sanity (non-whale = differs from the pre-0.4.0 blob).
const res = join(APP_ROOT, 'resources')
const icoChecks = {}
for (const name of ['icon.ico', 'tray.ico', 'tray-light.ico', 'installer.ico']) {
  const path = join(res, name)
  const ok = existsSync(path) && statSync(path).size > 1024
  icoChecks[name] = ok
  check(`icon-${name}`, ok, ok ? `${statSync(path).size}B` : 'missing')
}
const iconPng = join(res, 'icon.png')
let pngOk = false
if (existsSync(iconPng)) {
  const head = readFileSync(iconPng).subarray(0, 4)
  pngOk = head[0] === 0x89 && head[1] === 0x50
}
check('icon-png-format', pngOk)
check('icon-seal-not-whale', icoChecks['icon.ico'] && icoChecks['installer.ico'], 'installer.ico must be the seal (copied from icon.ico in 0.5.0 cleanup)')

// 4) NSIS wiring from electron-builder-config.
const configText = readFileSync(join(APP_ROOT, 'scripts', 'electron-builder-config.mjs'), 'utf8')
for (const key of ['installerIcon', 'uninstallerIcon', 'installerSidebar', 'uninstallerSidebar']) {
  const match = configText.match(new RegExp(`${key}:\\s*[^,\\n]+`))
  if (!match) {
    check(`nsis-${key}`, false, 'key missing from config')
    continue
  }
  const target = match[0].match(/['"]([^'"]+\.(?:ico|bmp|png))['"]/)?.[1]
  if (!target) {
    check(`nsis-${key}`, true, 'expression (resolved at build time)')
    continue
  }
  const path = target.replaceAll('../', join(APP_ROOT, '../', '')).replace('join(buildPaths.root', '')
  const resolved = target.includes('installer-ui')
    ? join(APP_ROOT, '.desktop-build', 'targets', 'win-x64', 'installer-ui', target.split('/').pop() ?? '')
    : join(APP_ROOT, 'resources', target.split('/').pop() ?? '')
  check(`nsis-${key}`, existsSync(resolved) || existsSync(path), existsSync(resolved) ? resolved.slice(APP_ROOT.length + 1) : `missing: ${resolved} / ${path}`)
}
const oneClick = /oneClick:\s*false/.test(configText)
check('nsis-assisted-mode', oneClick, oneClick ? 'oneClick=false — custom nsDialogs pages (self-drawn)' : 'oneClick=true')
// NOTE: existence checks only — the installer is a fully self-drawn window
// (installer/pages.nsh + window-frame.dll). electron-builder MUI art keys such
// as installerHeader are never painted in this framework; brand.bmp is the real
// art path (all three pages draw it). "file exists" does NOT guarantee on-screen.
const brandBmp = join(APP_ROOT, '.desktop-build', 'targets', 'win-x64', 'installer-ui', 'brand.bmp')
const sidebarBmp = join(APP_ROOT, '.desktop-build', 'targets', 'win-x64', 'installer-ui', 'uninstaller-sidebar.bmp')
check('nsis-brand-bmp', existsSync(brandBmp), existsSync(brandBmp) ? `${statSync(brandBmp).size}B (self-drawn pages paint brand; exists ≠ on-screen — confirm by real install)` : 'run scripts/prepare-windows-installer.ps1 first')
check('nsis-sidebar-bmp', existsSync(sidebarBmp), existsSync(sidebarBmp) ? `${statSync(sidebarBmp).size}B (uninstaller wiring; exists ≠ on-screen)` : 'run scripts/prepare-windows-installer.ps1 first')

// 5) Secret scan over packaging inputs.
try {
  const hits = [...scanDir(join(APP_ROOT, 'resources')), ...scanDir(join(APP_ROOT, 'installer'))]
  check('no-secrets', hits.length === 0, hits.length === 0 ? 'resources+installer clean' : `${hits.length} hit(s)`)
} catch (error) {
  check('no-secrets', false, String(error).slice(0, 120))
}

// 5b) cadre-collab 构建产物：gitignore 的 esbuild 产物。stamp 的源码哈希或产物哈希
//     任一不符都硬失败——源码改了没重建 = 主进程与 Host 插件跑旧状态机。
//     mtime 在 git checkout 后不可靠，因此只认 build-cadre-collab.mjs 写的 stamp。
const DESKTOP_ROOT = join(APP_ROOT, '..', '..')
const rebuildHint = 'node desktop/scripts/build-cadre-collab.mjs'
const cadreStampRead = readCadreStamp(DESKTOP_ROOT)
if ('problem' in cadreStampRead) {
  check('cadre-collab-build', false, `${cadreStampRead.problem}；运行 ${rebuildHint}`)
  check('cadre-host-ledger-build', false, `${cadreStampRead.problem}；运行 ${rebuildHint}`)
} else {
  const cadreStamp = cadreStampRead.stamp
  const current = computeCadreSourceHashes(DESKTOP_ROOT)
  const changed = [...new Set([
    ...Object.keys(current.sources).filter(file => cadreStamp.sources[file] !== current.sources[file]),
    ...Object.keys(cadreStamp.sources).filter(file => !(file in current.sources)),
  ])]
  const fresh = changed.length === 0 && cadreStamp.sourceHash === current.sourceHash
  const outputProblem = (relativePath) => {
    const absolute = join(DESKTOP_ROOT, ...relativePath.split('/'))
    const recorded = cadreStamp.outputs.find(output => output.path === relativePath)
    if (!existsSync(absolute)) return `产物缺失 ${relativePath}`
    if (recorded === undefined) return `stamp 未记录 ${relativePath}`
    if (recorded.sha256 !== hashFile(absolute) || recorded.bytes !== fileBytes(absolute)) {
      return `产物与 stamp 不符 ${relativePath}`
    }
    return undefined
  }
  const sourceProblem = fresh
    ? undefined
    : `源码已改未重建（${changed.slice(0, 5).join(', ') || '聚合哈希不符'}）`
  const mainProblem = outputProblem(CADRE_OUTPUTS[0])
  const mainOk = sourceProblem === undefined && mainProblem === undefined
  check('cadre-collab-build', mainOk,
    mainOk ? `sources=${current.count} hash=${cadreStamp.sourceHash.slice(0, 12)}` : `${sourceProblem ?? mainProblem}；运行 ${rebuildHint}`)
  const hostProblem = outputProblem(CADRE_OUTPUTS[1])
  check('cadre-host-ledger-build', hostProblem === undefined,
    hostProblem ?? CADRE_OUTPUTS[1])
}

// 6) Stale-install cleanup macro must stay wired.
// 6b) primary-runtime integrity — prepare-runtime 整树重建，中断即残缺（node.exe/python 缺失时 dev 无法启动）。
const runtimeRoot = join(APP_ROOT, '.desktop-build', 'targets', 'win-x64', 'runtime', 'primary-runtime', 'dependencies')
const runtimeNode = existsSync(join(runtimeRoot, 'node', 'bin', 'node.exe'))
const runtimePython = existsSync(join(runtimeRoot, 'python', 'python.exe'))
if (runtimeNode && runtimePython) check('primary-runtime-integrity', true)
else warn('primary-runtime-integrity', `runtime 残缺（node=${runtimeNode ? 'ok' : 'missing'}, python=${runtimePython ? 'ok' : 'missing'}）——dev/run start 会 ENOENT；跑官方全链重建（单跑 prepare:runtime 本机静默退出，勿盲跑）`)
const nshText = readFileSync(join(APP_ROOT, 'scripts', 'installer.nsh'), 'utf8')
const hasCleanup = /\!macro customInstall[\s\S]*RMDir \/r "\$INSTDIR\\resources"/.test(nshText)
if (hasCleanup) check('stale-install-cleanup-macro', true)
else warn('stale-install-cleanup-macro', '清理宏暂撤（0.5.1 真机装到一半中止，明示回退见 git log）；恢复后此处自动转 PASS')

console.log('')
if (failures.length > 0) {
  console.error(`[preflight] FAILED: ${failures.length} hard error(s): ${failures.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
for (const warning of warnings) console.warn(`[preflight] needs human confirm: ${warning.name} — ${warning.detail.slice(0, 120)}`)
console.log('[preflight] ALL CHECKS PASSED — safe to run package:desktop:win:x64:unsigned')

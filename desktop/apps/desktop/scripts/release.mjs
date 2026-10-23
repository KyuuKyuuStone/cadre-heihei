/**
 * One-command release tool: preflight → build → verify → publish.
 *
 * Usage:
 *   pnpm release:win [--version 0.5.1] [--dry-run] [--skip-tests]
 *
 * Steps (each stops the run on failure with "which step / why / suggested fix"):
 *   1. version   — official family bump (scripts/release/bump.ts) + lockfile; commit, no push.
 *   2. preflight — node scripts/preflight-package.mjs (TS / product name / icons / NSIS / secrets / cleanup).
 *   3. build     — package:desktop:win:x64:unsigned with reduced-concurrency env baked in.
 *   4. verify    — filename/asar version/icons/secrets/dark-theme checks (generalized verify-050).
 *   5. publish   — copy to D:\xxw_p\cadre-release\<version>\ + SHA256.txt + README.txt.
 *   6. summary   — one line: path / size / sha256 / elapsed.
 *
 * --dry-run runs steps 1-2 (planned only) and prints the execution plan.
 * Logs: apps/desktop/.desktop-build/release-logs/<ts>/ (stdout/stderr per step).
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_ROOT = join(import.meta.dirname, '..')
const REPO_ROOT = join(APP_ROOT, '..', '..')
const ARTIFACTS = join(APP_ROOT, '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts')
const RELEASE_ROOT = 'D:\\xxw_p\\cadre-release'
const LOG_ROOT = join(APP_ROOT, '.desktop-build', 'release-logs')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const versionIdx = args.indexOf('--version')
const versionArg = versionIdx >= 0 ? (args.find((a, i) => i > versionIdx && !a.startsWith('--')) ?? null) : null
const dryRun = flag('--dry-run')

const startedAt = Date.now()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = join(LOG_ROOT, stamp)
mkdirSync(logDir, { recursive: true })

const fail = (step, why, hint) => {
  console.error(`\n[release] ✗ STEP ${step} FAILED: ${why}`)
  if (hint) console.error(`[release]   hint: ${hint}`)
  console.error(`[release]   logs: ${logDir}`)
  process.exit(1)
}
const runStep = (step, command, spawnArgs, opts = {}) => {
  console.log(`\n[release] ▶ step ${step}: ${command} ${spawnArgs.join(' ')}`)
  if (dryRun && !opts.runInDryRun) {
    console.log('[release]   (dry-run: skipped)')
    return { status: 0, stdout: '', stderr: '' }
  }
  const out = []
  const result = spawnSync(command, spawnArgs, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: opts.shell ?? (process.platform === 'win32' && command !== 'node'),
  })
  writeFileSync(join(logDir, `${step}.stdout.log`), result.stdout ?? '', 'utf8')
  writeFileSync(join(logDir, `${step}.stderr.log`), result.stderr ?? '', 'utf8')
  return result
}

// ── 0. push guard（2026-10-23 用户硬规则：任何 push 必须经用户明确授权）──
const wantsPush = args.includes('--push')
const confirmPush = args.includes('--confirm')
if (wantsPush && !confirmPush) {
  fail('0-push-guard', '--push 需要同时给出 --confirm（双重显式）', '硬规则：push 必须经用户明确授权；且需版本号+CHANGELOG+发布必过清单齐备')
}
if (wantsPush && confirmPush) {
  const remotes = spawnSync('git', ['remote'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()
  if (!remotes) {
    fail('0-push-guard', '仓库没有配置远端（git remote 为空）', 'push 无处可去；配置远端并再次获得用户授权后再来')
  }
  console.log('[release] push requested AND confirmed — 仍需满足：版本节点提交集 + CHANGELOG + 发布必过清单 + 用户授权（缺一不可）')
}

// ── 0. current version ──
const pkgPath = join(APP_ROOT, 'package.json')
const currentVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const targetVersion = versionArg ?? bumpPatch(currentVersion)
console.log(`[release] version: ${currentVersion} → ${targetVersion}${dryRun ? ' (dry-run)' : ''}`)

// ── 1. bump ──
if (targetVersion !== currentVersion) {
  const bump = runStep('1-bump', 'pnpm', ['exec', 'tsx', 'scripts/release/bump.ts', '--family', 'dsh', targetVersion], { cwd: REPO_ROOT })
  if (bump.status !== 0) fail('1-bump', `bump to ${targetVersion} failed`, 'check scripts/release/bump.ts stderr log; fix blocking errors then rerun')
} else {
  console.log('[release]   (version unchanged — skipping bump)')
}

// ── 2. preflight ──
const preflight = runStep('2-preflight', 'node', [join('scripts', 'preflight-package.mjs')], { cwd: APP_ROOT, runInDryRun: true })
if (preflight.status !== 0) fail('2-preflight', (preflight.stdout ?? '').match(/FAILED: .*$/)?.[0] ?? 'preflight gate rejected', 'open 2-preflight.stdout.log for the failing check; each check comments why it exists')
if (dryRun) {
  console.log('\n[release] dry-run plan (if executed):')
  console.log('  3. pnpm -w run package:desktop:win:x64:unsigned  (DSH_GATE_CONCURRENCY=3, NODE_OPTIONS=--max-old-space-size=8192)')
  console.log(`  4. verify artifacts for ${targetVersion}`)
  console.log(`  5. publish → ${join(RELEASE_ROOT, targetVersion)}`)
  console.log(`[release] logs: ${logDir}`)
  process.exit(0)
}

// ── 3. build ──
const build = runStep('3-build', 'pnpm', ['-w', 'run', 'package:desktop:win:x64:unsigned'], {
  cwd: APP_ROOT,
  env: { DSH_GATE_CONCURRENCY: '3', NODE_OPTIONS: '--max-old-space-size=8192', ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/', ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/', npm_config_verify_deps_before_run: 'false', PATH: 'C:\\Windows\\System32;' + (process.env.PATH ?? '') },
})
if (build.status !== 0) fail('3-build', 'official chain failed', 'tail 3-build.stderr.log; gates: host aggregate (TS) → smoke-packaged-runtime (exe name) → nsis (resources)')

// ── 4. verify ──
const exeName = `cadre-heihei-${targetVersion}-win-x64-unsigned.exe`
const exePath = join(ARTIFACTS, exeName)
const verify = verifyArtifacts(targetVersion, exePath)
if (!verify.ok) fail('4-verify', verify.problems.join('; '), 'fix the flagged artifact problems; do NOT publish a failing artifact')

// ── 5. publish ──
const releaseDir = join(RELEASE_ROOT, targetVersion)
mkdirSync(releaseDir, { recursive: true })
const setupName = `cadre-heihei-${targetVersion}-setup-unsigned.exe`
copyFileSync(exePath, join(releaseDir, setupName))
const sha256 = createHash('sha256').update(readFileSync(exePath)).digest('hex')
writeFileSync(join(releaseDir, 'SHA256.txt'), `${sha256}  ${setupName}\n`, 'utf8')
const changelog = readChangelogSummary(targetVersion)
writeFileSync(join(releaseDir, 'README.txt'), readme(targetVersion, verify.bytes, changelog), 'utf8')

// ── 6. summary ──
const minutes = ((Date.now() - startedAt) / 60000).toFixed(1)
console.log(`\n[release] ✓ ${join(releaseDir, setupName)}`)
console.log(`[release] ✓ ${verify.bytes} B | sha256=${sha256} | ${minutes} min`)
console.log(`[release] ✓ README+SHA256 written; logs: ${logDir}`)

// ── helpers ──
function bumpPatch(version) {
  const parts = version.split('.')
  parts[2] = String(Number(parts[2]) + 1)
  return parts.join('.')
}
function verifyArtifacts(version, exePath) {
  const problems = []
  const ok = []
  if (!existsSync(exePath)) return { ok: false, problems: [`missing artifact ${exeName}`], bytes: 0 }
  const bytes = statSync(exePath).size
  ok.push(`filename ${exeName} (${bytes}B)`)
  const asarPath = join(ARTIFACTS, 'win-unpacked', 'resources', 'app.asar')
  if (!existsSync(asarPath)) return { ok: false, problems: ['win-unpacked/resources/app.asar missing'], bytes }
  const text = readFileSync(asarPath).toString('latin1')
  const versionInAsar = text.match(/"version":\s*"([\d.]+-?[\w.]*)"/)?.[1]
  if (versionInAsar !== version) problems.push(`asar package.json version=${versionInAsar}, expected ${version}`)
  else ok.push(`version ${versionInAsar}`)
  for (const icon of ['icon.ico', 'tray.ico', 'tray-light.ico']) {
    if (!existsSync(join(ARTIFACTS, 'win-unpacked', 'resources', icon))) problems.push(`missing resources/${icon}`)
  }
  const trayRefs = (text.match(/resolveTrayIconPath/g) ?? []).length
  if (trayRefs === 0) problems.push('resolveTrayIconPath missing (tray icon wiring)')
  else ok.push(`tray wiring ×${trayRefs}`)
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  const paths = []
  const walk = (node, prefix) => {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (meta.files) walk(meta, p)
      else paths.push(p)
    }
  }
  walk(header, '')
  const env = paths.filter((p) => /\/\.env/i.test(p)).length
  const sqlite = paths.filter((p) => /\.sqlite(-wal|-shm)?$/i.test(p)).length
  const userData = paths.filter((p) => /(^|\/)user-data\//i.test(p)).length
  const sk = (text.match(/sk-[A-Za-z0-9_-]{20,}/g) ?? []).length
  if (env + sqlite + userData + sk > 0) problems.push(`secret/user-data leak: env=${env} sqlite=${sqlite} user-data=${userData} sk=${sk}`)
  else ok.push('no secrets / user data in asar')
  const dark = (text.match(/seal-dark/g) ?? []).length + (text.match(/0E141B/gi) ?? []).length
  if (dark === 0) problems.push('dark theme tokens missing (seal-dark/#0E141B)')
  else ok.push(`dark tokens ×${dark}`)
  console.log(`[release] verify: ${ok.join(' | ')}`)
  return { ok: problems.length === 0, problems, bytes }
}
function readChangelogSummary(version) {
  try {
    const text = readFileSync(join(APP_ROOT, 'CHANGELOG.md'), 'utf8')
    const section = text.split(new RegExp(`## ${version.replace(/\./g, '\\.')}\\b`))[1]
    return section ? section.split(/\r?\n/).filter((l) => /^- /.test(l)).slice(0, 6).join('\r\n') : '（CHANGELOG 无该版本条目）'
  } catch {
    return '（CHANGELOG 缺失）'
  }
}
function readme(version, bytes, changelog) {
  const date = new Date().toISOString().slice(0, 10)
  return `cadre-heihei ${version}\r\n================\r\n\r\n- 版本: ${version}\r\n- 大小: ${bytes.toLocaleString()} B（${(bytes / 1048576).toFixed(1)} MiB）\r\n- 日期: ${date}\r\n\r\n## 变更\r\n\r\n${changelog}\r\n\r\n## 安装\r\n\r\n- 双击安装或 /S 静默（per-user）\r\n- 卸载保留 userData（%APPDATA%）\r\n- 未签名: 无代码签名证书，SmartScreen 首次运行可能告警\r\n- 无账户体系; 模型接入=设置页第三方 API Key（多厂商）\r\n- 自动更新/otel 遥测: 禁用\r\n`
}

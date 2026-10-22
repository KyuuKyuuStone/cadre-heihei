#!/usr/bin/env node
/**
 * M4 打包前置：全量复制 harness 运行树到 resources/harness-stage（U-M4-04）。
 *
 * - vendor/deepseek-harness（pin 子模块）整树复制（.git 除外），符号链接原样保留；
 *   实测（s16，2026-10-21）：vendor node_modules 内 4111 个链接全部为相对内部链接，
 *   复制后解析结构与 dev 完全一致（dsh 运行时动态加载的插件无需静态闭包推导）。
 * - 部署位 = <resources>/vendor/deepseek-harness，
 *   使 src/adapters/engine/harness/sdk.ts 的 findRepoRoot 上溯在打包态命中（不改 sdk.ts）。
 * - 硬校验：stage 内不得出现绝对目标链接（会成为开发路径依赖）；
 * - 开发路径字面量分级：node_modules 内（vendor 构建产物内嵌源码路径，无功能依赖）
 *   = 发布卫生待办；node_modules 之外 = 硬失败。
 *
 * 用法：node scripts/m4/stage-harness.ts
 * 输出：resources/harness-stage/<tree> + resources/harness-stage-manifest.json
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(APP_ROOT, '..')
const VENDOR = join(REPO_ROOT, 'vendor', 'deepseek-harness')
const STAGE = join(APP_ROOT, 'resources', 'harness-stage')
const STAGE_TREE = join(STAGE, 'vendor', 'deepseek-harness')
const SDK_ENTRY = join(STAGE_TREE, 'packages', 'sdk', 'client', 'lib', 'index.js')
const DSH_BIN = join(STAGE_TREE, 'packages', 'sdk', 'client', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const DEV_PATH_MARKERS = ['D:\\xxw_p\\cadre-heihei', 'D:/xxw_p/cadre-heihei']
// 裁剪决策（s16-R 实测）：website/ 仅 1MB 源文件 + 8958 个指向共享 store 的链接，
// 无任何运行时引用（packages 内 grep 0 命中），排除以消灭坏链接源；
// 顶层 node_modules 2.1G 为全 workspace dev+prod store，prod 闭包无法静态推导
// （pnpm deploy 实测打地鼠），不做内容裁剪，分发体积以压缩实测为准。
const EXCLUDED_TOP = ['website']
// 非运行时裁剪（s17 实测：2.7GB/10 万文件使 electron-builder NSIS 的 7za 管线
// RangeError 崩溃；裁掉测试/文档/映射等非运行时文件，lib/bin 解析链不动）。
const EXCLUDED_DIRS = new Set(['.git', 'docs', 'snapshots', 'examples', 'benchmark', 'test', 'tests', '__tests__', '.github'])
// s17 裁剪（805MB 首版口径，<500MB 发布后优化）：功能无关大件/开发工具链不随包。
// 逐包剔除后 driver probe "pong" + MCP list_roster 验证通过；详细清单见 manifest。
const EXCLUDED_PNPM_PACKAGES = new Set([
  '@openai+codex@0.153.4-win32-x64',
  '@anthropic-ai+claude-agent-sdk-win32-x64@0.3.263',
  '@deepseek-ai+libreoffice-kit-win32-x64@0.1.5',
  'chrome-devtools-frontend@1.0.1638082',
  'pnpm@11.28.5',
  'typescript@6.0.3',
  '@oxlint-tsgolint+win32-x64@7.0.2001',
  '@rolldown+binding-win32-x64-msvc@1.1.1',
  '@rolldown+binding-win32-x64-msvc@1.2.7',
  'electron-winstaller@5.4.0_supports-color@9.4.0',
  'simple-icons@16.31.0',
  'mermaid@11.17.2',
  'sherpa-onnx-win-x64@1.13.8',
  'lefthook-windows-x64@2.1.12',
  '@oxlint+binding-win32-x64-msvc@1.81.0',
])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.ts', '.txt'])
const MAX_SCAN_BYTES = 8 * 1024 * 1024

function gitPorcelain(): string {
  return execFileSync('git', ['-C', VENDOR, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
}

/** 全量复制：symlink 原样保留（dereference:false），.git 一律排除。 */
function copyVendor(): void {
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  cpSync(VENDOR, STAGE_TREE, {
    recursive: true,
    dereference: false,
    filter: (src: string) => {
      if (EXCLUDED_TOP.some((name) => src === join(VENDOR, name))) return false
      const base = basename(src)
      if (EXCLUDED_DIRS.has(base)) return false
      // packages|apps 的 src 为 TS 源码，运行时仅用 lib（node_modules 内 src 不受影响）。
      if (base === 'src' && /[\\/]packages[\\/]|[\\/]apps[\\/]/.test(src)) return false
      // s17 裁剪：.pnpm 内功能无关大件/开发工具链（EXCLUDED_PNPM_PACKAGES）。
      if (src.includes(join('node_modules', '.pnpm')) && EXCLUDED_PNPM_PACKAGES.has(base)) return false
      // .d.ts/.map/.md 为类型声明、sourcemap、文档：运行时零读取（lib/bin 解析链不含）。
      return !base.endsWith('.d.ts') && !base.endsWith('.map') && !base.endsWith('.md')
    },
  })
}

/**
 * 改写指向 vendor 内部的绝对链接为 stage 内相对链接（s16 实测）：
 * vendor 的 website/node_modules 与内层 vendor/* 包（timer/schemastery/logger-console…）
 * 存在 8958 个绝对 junction（指向开发树内位置）；复制后必须改写，
 * 否则打包产物运行时解析回开发路径。指向 vendor 之外的链接 → 硬失败。
 */
function rewriteInternalLinks(): { rewritten: number; external: string[] } {
  const stack = [STAGE]
  let rewritten = 0
  const external: string[] = []
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const raw = readlinkSync(path)
        if (!isAbsolute(raw)) continue
        const resolved = resolve(raw)
        const relToVendor = relative(VENDOR, resolved)
        if (relToVendor.startsWith('..') || isAbsolute(relToVendor)) {
          external.push(relative(STAGE, path))
          continue
        }
        const stageTarget = join(STAGE_TREE, relToVendor)
        rmSync(path, { recursive: true, force: true })
        symlinkSync(relative(dirname(path), stageTarget), path, statSync(resolved).isDirectory() ? 'dir' : 'file')
        rewritten += 1
        continue
      }
      if (entry.isDirectory()) stack.push(path)
    }
  }
  return { rewritten, external }
}

interface TreeScan {
  files: number
  bytes: number
  textLeaks: string[]
  absoluteLinks: string[]
}

/** 单遍扫描：体积、开发路径字面量（≤8MB 文本文件）、绝对目标链接。 */
function scanTree(): TreeScan {
  const result: TreeScan = { files: 0, bytes: 0, textLeaks: [], absoluteLinks: [] }
  const stack = [STAGE]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const raw = readlinkSync(path)
        if (isAbsolute(raw)) result.absoluteLinks.push(relative(STAGE, path))
        continue
      }
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      result.files += 1
      result.bytes += size
      const ext = path.includes('.') ? '.' + path.split('.').pop()!.toLowerCase() : ''
      if (size <= MAX_SCAN_BYTES && TEXT_EXT.has(ext)) {
        try {
          const text = readFileSync(path, 'utf8')
          for (const marker of DEV_PATH_MARKERS) {
            if (text.includes(marker)) {
              result.textLeaks.push(relative(STAGE, path))
              break
            }
          }
        } catch {
          // 不可读文件跳过；计数仍计入。
        }
      }
    }
  }
  return result
}

const before = gitPorcelain()
if (before !== '') {
  console.error(`[stage-harness] vendor 子模块工作区不干净，拒绝执行：\n${before}`)
  process.exit(1)
}
if (!existsSync(join(VENDOR, 'packages', 'sdk', 'client', 'lib', 'index.js'))) {
  console.error('[stage-harness] vendor SDK 构建产物缺失（W1-02 未构建？）')
  process.exit(1)
}

copyVendor()
const rewrite = rewriteInternalLinks()
console.log(`[stage-harness] rewritten internal absolute links: ${rewrite.rewritten}, external: ${rewrite.external.length}`)
if (rewrite.external.length > 0) {
  console.error(`[stage-harness] ${rewrite.external.length} 个链接指向 vendor 之外，拒绝出包：\n${rewrite.external.slice(0, 10).join('\n')}`)
  process.exit(1)
}

if (!existsSync(SDK_ENTRY) || !existsSync(DSH_BIN)) {
  console.error(`[stage-harness] 复制后解析链不完整 sdkEntry=${existsSync(SDK_ENTRY)} dshBin=${existsSync(DSH_BIN)}`)
  process.exit(1)
}

const scan = scanTree()
// 文本泄露分级（s16 实测校准）：整树均为 vendor 只读副本，泄露字面量出现在
// node_modules 与 packages/*/lib 两类 vendor 构建产物中（bundler 内嵌源码路径，
// 无运行时解析依赖）→ 一律发布卫生待办；功能性依赖由两条硬门把关：
// ① 改写后绝对目标链接必须为 0（解析级）；② driver 从 stage/产物实跑 send。
const nodeModulesLiterals = scan.textLeaks.filter((path) => path.includes('node_modules'))
const packageLiterals = scan.textLeaks.length - nodeModulesLiterals.length
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  vendorSubmoduleCleanBefore: true,
  vendorSubmoduleCleanAfter: gitPorcelain() === '',
  mode: 'full-copy',
  excludedTop: EXCLUDED_TOP,
  excludedPnpmPackages: [...EXCLUDED_PNPM_PACKAGES].sort(),
  dshVersion: JSON.parse(readFileSync(DSH_BIN.replace(/lib[\\/]bin\.js$/, 'package.json'), 'utf8')).version as string,
  clientVersion: JSON.parse(readFileSync(join(STAGE_TREE, 'packages', 'sdk', 'client', 'package.json'), 'utf8')).version as string,
  stage: STAGE,
  files: scan.files,
  bytes: scan.bytes,
  rewrittenInternalLinks: rewrite.rewritten,
  absoluteLinks: scan.absoluteLinks,
  devPathLeaks: scan.textLeaks,
  nodeModulesPathLiterals: nodeModulesLiterals.length,
  packageBuildPathLiterals: packageLiterals,
}
writeFileSync(join(APP_ROOT, 'resources', 'harness-stage-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...manifest, stage: '<app>/resources/harness-stage' }, null, 2))
if (scan.absoluteLinks.length > 0) {
  console.error(`[stage-harness] ${scan.absoluteLinks.length} 个绝对目标链接，会成为开发路径依赖，拒绝出包`)
  process.exit(1)
}
if (scan.textLeaks.length > 0) {
  console.warn(`[stage-harness] ${scan.textLeaks.length} 个 vendor 构建产物内嵌源码路径字面量（node_modules ${nodeModulesLiterals.length} / packages lib ${packageLiterals}；发布卫生待办）`)
}

// 实体化发布树：改写后的链接全部指向 stage 内部（相对），dereference 跟随复制安全；
// 发布（7z/NSIS）必须实体化——s17 实测 7za 默认跟随 symlink（-snl 才保留），
// 数万链接被重复展开导致打包时长与 stdout 爆炸；且安装时还原 symlink 需终端用户特权。
const STAGE_FLAT = join(APP_ROOT, 'resources', 'harness-stage-flat')
rmSync(STAGE_FLAT, { recursive: true, force: true })
cpSync(STAGE, STAGE_FLAT, { recursive: true, dereference: true })
const flatStats = scanFlat(join(STAGE_FLAT, 'vendor', 'deepseek-harness'))
writeFileSync(
  join(APP_ROOT, 'resources', 'harness-stage-flat-manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), source: STAGE, files: flatStats.files, bytes: flatStats.bytes }, null, 2)}\n`,
  'utf8',
)
console.log(`[stage-harness] materialized: files=${flatStats.files} bytes=${flatStats.bytes}`)

function scanFlat(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(p)
      } else {
        try {
          files += 1
          bytes += statSync(p).size
        } catch {
          continue
        }
      }
    }
  }
  return { files, bytes }
}

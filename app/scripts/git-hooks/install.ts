#!/usr/bin/env node
/**
 * install.ts —— 安装 pre-push hook（从 cc-heihei v1.7.9 迁移）
 *
 * 迁移改动：
 *   - Bun.spawnSync → node:child_process.spawnSync
 *   - 移除前身 legacy quality.* git config 逻辑（新项目不使用）
 *   - 默认源路径 app/scripts/git-hooks/<kind>，从仓库根安装到 git hooks 目录
 *
 * 用法：node app/scripts/git-hooks/install.ts [--force]
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type HookKind = 'pre-commit' | 'pre-push'

export type InstallHookOptions = {
  kind: HookKind
  rootDir?: string
  sourcePath?: string
  hookPath?: string
  force?: boolean
}

export type InstallHookResult = {
  hookPath: string
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function runGit(rootDir: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `git ${args.join(' ')} failed`).trim())
  }
  return (r.stdout ?? '').trim()
}

function defaultRootDir(): string {
  return runGit(APP_ROOT, ['rev-parse', '--show-toplevel'])
}

export function installHook(options: InstallHookOptions): InstallHookResult {
  const rootDir = resolve(options.rootDir ?? defaultRootDir())
  const sourcePath = options.sourcePath
    ? resolve(options.sourcePath)
    : join(APP_ROOT, 'scripts', 'git-hooks', options.kind)
  const hookPath = options.hookPath
    ? resolve(options.hookPath)
    : resolve(rootDir, runGit(rootDir, ['rev-parse', '--git-path', `hooks/${options.kind}`]))

  if (!existsSync(sourcePath)) {
    throw new Error(`Hook source not found: ${sourcePath}`)
  }

  if (existsSync(hookPath) && !options.force && readFileSync(hookPath, 'utf8') !== readFileSync(sourcePath, 'utf8')) {
    throw new Error(`Refusing to overwrite existing hook at ${hookPath}. Re-run with --force after reviewing it.`)
  }

  mkdirSync(dirname(hookPath), { recursive: true })
  copyFileSync(sourcePath, hookPath)
  try {
    chmodSync(hookPath, 0o755)
  } catch {
    // Windows 上不总是可执行位；git 仍会按 shebang 调用。
  }
  return { hookPath }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Install the repository pre-push hook.\n\nUsage:\n  node app/scripts/git-hooks/install.ts [--force]')
    return
  }
  const unknown = args.filter((a) => a !== '--force')
  if (unknown.length) {
    throw new Error(`Unknown option: ${unknown[0]}`)
  }
  const result = installHook({ kind: 'pre-push', force: args.includes('--force') })
  console.log(`[pre-push] installed: ${result.hookPath}`)
}

const invoked = process.argv[1]
if (invoked && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

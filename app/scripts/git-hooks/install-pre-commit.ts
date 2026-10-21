#!/usr/bin/env node
/** 安装 pre-commit hook。用法：node app/scripts/git-hooks/install-pre-commit.ts [--force] */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installHook } from './install.ts'

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Install the repository pre-commit hook.\n\nUsage:\n  node app/scripts/git-hooks/install-pre-commit.ts [--force]')
    return
  }
  const unknown = args.filter((a) => a !== '--force')
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`)
  const result = installHook({ kind: 'pre-commit', force: args.includes('--force') })
  console.log(`[pre-commit] installed: ${result.hookPath}`)
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

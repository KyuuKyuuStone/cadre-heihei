#!/usr/bin/env node
/**
 * M4 构建：esbuild（经 Vite 依赖解析）把 main/preload 打成单文件 CJS。
 *
 * node scripts/m4/build-main.ts [main|preload|all]
 * - external: electron + Node 内置模块（不打包进 bundle）；
 * - 生产 CSP meta 注入 dist/renderer/index.html（双保险，幂等；dev 值不进入产物）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire, builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROD_CSP, applyCspMeta } from '../../src/main/electron-policy.ts'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<unknown>
}

function loadEsbuild(): EsbuildLike {
  // esbuild 是 Vite 的依赖但未被 hoist；从 Vite 入口所在上下文解析。
  const viteEntry = fileURLToPath(import.meta.resolve('vite'))
  const requireFromVite = createRequire(viteEntry)
  return requireFromVite('esbuild') as EsbuildLike
}

const TARGETS = {
  main: { entry: 'src/main/index.ts', outfile: 'dist/main/index.cjs' },
  preload: { entry: 'src/preload/index.ts', outfile: 'dist/preload/index.cjs' },
} as const

type TargetName = keyof typeof TARGETS

const requested = (process.argv[2] ?? 'all') as TargetName | 'all'
const names: TargetName[] =
  requested === 'all' ? ['main', 'preload'] : [requested]
if (requested !== 'all' && !(requested in TARGETS)) {
  console.error(`[m4] unknown target: ${requested}（main|preload|all）`)
  process.exit(2)
}

const esbuild = loadEsbuild()
const external = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]

for (const name of names) {
  const target = TARGETS[name]
  const outfile = join(APP_ROOT, target.outfile)
  mkdirSync(dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [join(APP_ROOT, target.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  })
  console.log(`[m4] built ${name}: ${target.outfile} (${statSync(outfile).size} bytes)`)
}

const rendererHtml = join(APP_ROOT, 'dist', 'renderer', 'index.html')
if (existsSync(rendererHtml)) {
  const html = readFileSync(rendererHtml, 'utf8')
  const injected = applyCspMeta(html, PROD_CSP)
  if (injected !== html) writeFileSync(rendererHtml, injected, 'utf8')
  console.log(`[m4] csp meta injected: dist/renderer/index.html`)
} else {
  console.log('[m4] renderer build not found; skip csp meta (run npm run build first)')
}

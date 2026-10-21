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
  // MCP server 单文件：随 extraResources 落真实磁盘，由 ELECTRON_RUN_AS_NODE 的
  // electron.exe（或系统 node）直接执行，不依赖终端用户安装系统 Node。
  mcp: { entry: 'src/mcp/server.ts', outfile: 'dist/mcp/server.cjs' },
} as const

/**
 * esbuild 对 import.meta 生成空 shim（url=undefined），mcp 的主入口判断会失效。
 * define 只接受标识符/字面量，故 define 成 banner 注入的实体：
 * import.meta.url → __mcp_entry_url = pathToFileURL(__filename).href（CJS 运行时等价语义）。
 */
const MCP_ENTRY_URL = '__mcp_entry_url'
const DEFINES: Record<string, Record<string, string>> = {
  main: { 'process.env.NODE_ENV': '"production"' },
  preload: { 'process.env.NODE_ENV': '"production"' },
  mcp: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': MCP_ENTRY_URL,
  },
}
const BANNERS: Record<string, Record<string, string>> = {
  mcp: {
    js: `var ${MCP_ENTRY_URL} = require("node:url").pathToFileURL(__filename).href;`,
  },
}

type TargetName = keyof typeof TARGETS

const requested = (process.argv[2] ?? 'all') as TargetName | 'all'
const names: TargetName[] =
  requested === 'all' ? ['main', 'preload', 'mcp'] : [requested]
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
    define: DEFINES[name]!,
    ...(BANNERS[name] === undefined ? {} : { banner: BANNERS[name]! }),
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

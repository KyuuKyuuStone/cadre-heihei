/**
 * Build the cadre collaboration write-path libraries.
 *
 * Both outputs bundle the desktop-owned snapshot `cadre-collab/collab/**`
 * (state machine, permissions, idempotency and validation):
 * - `apps/desktop/lib/cadre-collab.cjs` — required by the Electron main process;
 * - `packages/cadre/host-collab/lib/cadre-ledger.cjs` — required by the Host
 *   plugin so an employee report walks `transitionTx` (with `from_status`)
 *   instead of writing the task row directly.
 *
 * A stamp (`apps/desktop/lib/cadre-build.json`) records the hash of every
 * bundled source file and of both bundles. `scripts/gates/check-cadre-build.ts`
 * and the packaging preflight fail closed when a source edit never rebuilt
 * them; an mtime comparison cannot catch that reliably after a git checkout.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CADRE_BUILD_STAMP_VERSION,
  CADRE_OUTPUTS,
  CADRE_STAMP_PATH,
  computeCadreSourceHashes,
  fileBytes,
  hashFile,
} from './cadre-build-stamp.mjs'

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))

const outputs = [
  {
    name: 'main',
    entry: fileURLToPath(new URL('../cadre-collab/entry.ts', import.meta.url)),
    outfile: fileURLToPath(new URL('../apps/desktop/lib/cadre-collab.cjs', import.meta.url)),
  },
  {
    name: 'host',
    entry: fileURLToPath(new URL('../cadre-collab/host-entry.ts', import.meta.url)),
    outfile: fileURLToPath(new URL(
      '../packages/cadre/host-collab/lib/cadre-ledger.cjs', import.meta.url)),
  },
]

/**
 * Locate esbuild in either a direct-dependency `.bin` or pnpm's virtual-store
 * bin. esbuild is a transitive dependency, so a pnpm install does not always
 * link it at the workspace root.
 * @returns absolute executable path.
 */
function resolveEsbuild() {
  const binary = process.platform === 'win32' ? 'esbuild.CMD' : 'esbuild'
  const candidates = [
    join(DESKTOP_ROOT, 'node_modules', '.bin', binary),
    join(DESKTOP_ROOT, 'node_modules', '.pnpm', 'node_modules', '.bin', binary),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`esbuild 不可用（查找：${candidates.join(' / ')}）；请先在 desktop/ 执行 pnpm install`)
  }
  return found
}

const esbuild = resolveEsbuild()
const esbuildVersion = execFileSync(esbuild, ['--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim()

for (const output of outputs) {
  console.log(`[cadre-collab] building ${output.name} → ${output.outfile}`)
  execFileSync(esbuild, [
    output.entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${output.outfile}`,
    '--log-level=info',
  ], { cwd: DESKTOP_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
}

const sources = computeCadreSourceHashes(DESKTOP_ROOT)
const stamp = {
  version: CADRE_BUILD_STAMP_VERSION,
  builtAt: new Date().toISOString(),
  esbuildVersion,
  sourceHash: sources.sourceHash,
  sourceFiles: sources.count,
  sources: sources.sources,
  outputs: CADRE_OUTPUTS.map((relativePath) => {
    const absolute = join(DESKTOP_ROOT, ...relativePath.split('/'))
    return { path: relativePath, sha256: hashFile(absolute), bytes: fileBytes(absolute) }
  }),
}
const stampPath = join(DESKTOP_ROOT, ...CADRE_STAMP_PATH.split('/'))
mkdirSync(dirname(stampPath), { recursive: true })
writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
console.log(`[cadre-collab] stamp → ${CADRE_STAMP_PATH} sources=${String(sources.count)} esbuild=${esbuildVersion}`)

/**
 * Build the cadre collaboration write-path libraries.
 *
 * Both outputs bundle the desktop-owned snapshot `cadre-collab/collab/**`
 * (state machine, permissions, idempotency and validation):
 * - `apps/desktop/lib/cadre-collab.cjs` — required by the Electron main process;
 * - `packages/cadre/host-collab/lib/cadre-ledger.cjs` — required by the Host
 *   plugin so an employee report walks `transitionTx` (with `from_status`)
 *   instead of writing the task row directly.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const esbuild = join(DESKTOP_ROOT, 'node_modules', '.bin',
  process.platform === 'win32' ? 'esbuild.CMD' : 'esbuild')

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

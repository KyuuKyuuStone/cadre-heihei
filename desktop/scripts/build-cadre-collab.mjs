/**
 * Build the cadre collaboration write-path library for the desktop shell.
 *
 * The library bundles `app/src/collab/**` unchanged (single source of truth
 * for the state machine, permissions, idempotency and validation) into a CJS
 * file the Electron main process requires at runtime.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const entry = fileURLToPath(new URL('../cadre-collab/entry.ts', import.meta.url))
const outfile = fileURLToPath(new URL('../apps/desktop/lib/cadre-collab.cjs', import.meta.url))
const esbuild = join(DESKTOP_ROOT, 'node_modules', '.bin',
  process.platform === 'win32' ? 'esbuild.CMD' : 'esbuild')

execFileSync(esbuild, [
  entry,
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node22',
  `--outfile=${outfile}`,
  '--log-level=info',
], { cwd: DESKTOP_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })

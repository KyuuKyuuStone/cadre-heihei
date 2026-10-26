#!/usr/bin/env node
/**
 * run-all.ts —— 顺序执行 desktop 的四门禁并落盘原始输出（从 app/scripts/gates 迁移）。
 * 退出码：0=四门禁全过；1=任一失败。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_DIR = join(APP_ROOT, 'scripts/gates/evidence')
mkdirSync(EVIDENCE_DIR, { recursive: true })

const GATES = [
  { name: 'file-size', file: 'scripts/gates/check-file-size.ts' },
  { name: 'import-semantics', file: 'scripts/gates/check-import-semantics.ts' },
  { name: 'tsc-baseline', file: 'scripts/gates/check-tsc-baseline.ts' },
  { name: 'smoke', file: 'scripts/gates/smoke.ts' },
]

const results: Array<{ name: string; exitCode: number; elapsedMs: number; stdout: string; stderr: string }> = []
const lines: string[] = []
const suiteStart = Date.now()

for (const gate of GATES) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [gate.file], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const elapsedMs = Date.now() - started
  const exitCode = r.status ?? -1
  const stdout = r.stdout
  const stderr = r.stderr
  results.push({ name: gate.name, exitCode, elapsedMs, stdout, stderr })
  const verdict = exitCode === 0 ? 'PASS' : 'FAIL'
  console.log(`[gate] ${verdict} ${gate.name} exit=${exitCode} ${(elapsedMs / 1000).toFixed(2)}s`)
  if (exitCode !== 0) {
    if (stdout.trim()) console.error(stdout.slice(-4000))
    if (stderr.trim()) console.error(stderr.slice(-4000))
  }
  lines.push(`===== ${gate.name} exit=${exitCode} elapsed=${elapsedMs}ms =====`)
  lines.push('--- stdout ---')
  lines.push(stdout.trimEnd())
  lines.push('--- stderr ---')
  lines.push(stderr.trimEnd())
  lines.push('')
}

const totalMs = Date.now() - suiteStart
const failed = results.filter(r => r.exitCode !== 0)
const summary = {
  capturedAt: new Date().toISOString(),
  gateCount: GATES.length,
  passed: results.length - failed.length,
  failed: failed.length,
  totalMs,
  results: results.map(({ name, exitCode, elapsedMs }) => ({ name, exitCode, elapsedMs })),
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(join(EVIDENCE_DIR, 'run-all.txt'), lines.join('\n'), 'utf8')
writeFileSync(join(EVIDENCE_DIR, 'run-all.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')

console.log(`\n[gates] ${summary.passed}/${summary.gateCount} passed, ${summary.failed} failed, total ${(totalMs / 1000).toFixed(2)}s`)
process.exit(failed.length === 0 ? 0 : 1)

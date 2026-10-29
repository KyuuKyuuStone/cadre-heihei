#!/usr/bin/env node
/**
 * check-cadre-build.ts —— cadre CJS 产物门禁
 *
 * 两个 `lib/*.cjs` 是 gitignore 的 esbuild 产物。源码改了不重建时，
 * `typecheck` / `test` 全绿（它们跑 TS 源码），主进程与 Host 插件却加载旧状态机。
 * 本门禁比对构建 stamp 中的源码哈希与产物哈希，任一处不符即失败。
 *
 * 判据：
 *   - stamp 缺失 / 版本不支持 → 失败（提示重建命令）
 *   - `cadre-collab/**` 任一打包源文件与 stamp 不符 → 失败并列出文件
 *   - 任一产物缺失或哈希不符 → 失败
 *
 * 用法：node desktop/scripts/gates/check-cadre-build.ts
 * 退出码：0=产物与源码一致；1=缺失/过期/损坏。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CADRE_OUTPUTS,
  computeCadreSourceHashes,
  fileBytes,
  hashFile,
  readCadreStamp,
} from '../cadre-build-stamp.mjs'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REBUILD = 'node desktop/scripts/build-cadre-collab.mjs'
const MAX_LISTED = 10

const failures: string[] = []
const fail = (message: string): void => { failures.push(message) }

const readResult = readCadreStamp(APP_ROOT)
const stamp = 'stamp' in readResult ? readResult.stamp : undefined
if (stamp === undefined) {
  fail(`${'problem' in readResult ? readResult.problem : 'stamp 不可用'}；运行 ${REBUILD}`)
} else {
  const current = computeCadreSourceHashes(APP_ROOT)
  const changed: string[] = []
  for (const [file, digest] of Object.entries(current.sources)) {
    if (stamp.sources[file] !== digest) changed.push(file)
  }
  for (const file of Object.keys(stamp.sources)) {
    if (!(file in current.sources) && !changed.includes(file)) changed.push(file)
  }
  if (changed.length > 0) {
    const listed = changed.slice(0, MAX_LISTED).join(', ')
    const more = changed.length > MAX_LISTED ? ` 等 ${String(changed.length)} 个` : ''
    fail(`源码与构建产物不一致：${listed}${more}；运行 ${REBUILD}`)
  }
  if (stamp.sourceHash !== current.sourceHash && changed.length === 0) {
    fail(`源码聚合哈希不一致（stamp=${stamp.sourceHash.slice(0, 12)} current=${current.sourceHash.slice(0, 12)}）；运行 ${REBUILD}`)
  }

  for (const relativePath of CADRE_OUTPUTS) {
    const absolute = join(APP_ROOT, ...relativePath.split('/'))
    if (!existsSync(absolute)) {
      fail(`产物缺失：${relativePath}；运行 ${REBUILD}`)
      continue
    }
    const recorded = stamp.outputs.find(output => output.path === relativePath)
    if (recorded === undefined) {
      fail(`stamp 未记录产物：${relativePath}；运行 ${REBUILD}`)
      continue
    }
    if (recorded.sha256 !== hashFile(absolute)) {
      fail(`产物哈希与 stamp 不符：${relativePath}（可能被手改或构建中断）；运行 ${REBUILD}`)
      continue
    }
    if (recorded.bytes !== fileBytes(absolute)) {
      fail(`产物大小与 stamp 不符：${relativePath}；运行 ${REBUILD}`)
    }
  }
}

if (failures.length > 0) {
  console.error(`[cadre-build] FAIL ${String(failures.length)} 项`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`[cadre-build] PASS sources=${String(stamp?.sourceFiles ?? 0)} hash=${(stamp?.sourceHash ?? '').slice(0, 12)} `
  + `outputs=${String(CADRE_OUTPUTS.length)} esbuild=${stamp?.esbuildVersion ?? 'unknown'} builtAt=${stamp?.builtAt ?? 'unknown'}`)

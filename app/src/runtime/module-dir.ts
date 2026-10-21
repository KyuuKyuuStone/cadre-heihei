/**
 * 模块目录解析：源码 ESM 用 import.meta.url，esbuild CJS bundle 用 __dirname。
 * 避免 CJS 产物里 fileURLToPath(import.meta.url) 为 undefined 导致启动崩溃。
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function moduleDirectory(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

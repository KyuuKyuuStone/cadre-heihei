/** 证据卡文件系统工具：路径安全、指纹与行读取。 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { EvidenceError } from './errors.ts'

export function evidenceRoot(projectRoot: string): string {
  return resolve(projectRoot, '.cadre', 'evidence')
}

export function taskDir(projectRoot: string, taskId: string): string {
  assertSafeTaskId(taskId)
  return resolve(evidenceRoot(projectRoot), 'tasks', taskId)
}

export function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    throw new EvidenceError('UNSAFE_PATH', `非法 taskId：${taskId}`)
  }
}

/** 解析项目相对路径；绝对路径、`..` 越界与 NUL 一律拒绝。 */
export function resolveProjectPath(projectRoot: string, relativePath: string): string {
  if (relativePath === '' || relativePath.includes('\u0000') || isAbsolute(relativePath)) {
    throw new EvidenceError('UNSAFE_PATH', `非法路径：${relativePath}`)
  }
  const root = resolve(projectRoot)
  const absolute = resolve(root, relativePath)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  const lowerAbsolute = absolute.toLowerCase()
  if (lowerAbsolute !== root.toLowerCase() && !lowerAbsolute.startsWith(prefix.toLowerCase())) {
    throw new EvidenceError('UNSAFE_PATH', `路径越界：${relativePath}`)
  }
  return absolute
}

export interface FileFingerprint {
  readonly sha256: string
  readonly mtimeMs: number
}

export function fingerprintFile(projectRoot: string, relativePath: string): FileFingerprint {
  const absolute = resolveProjectPath(projectRoot, relativePath)
  const buffer = readFileSync(absolute)
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    mtimeMs: statSync(absolute).mtimeMs,
  }
}

export function readLine(projectRoot: string, relativePath: string, line: number): string | undefined {
  const absolute = resolveProjectPath(projectRoot, relativePath)
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/)
  return lines[line - 1]
}

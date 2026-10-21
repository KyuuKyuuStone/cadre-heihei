/**
 * 证据卡机器校验（spike/03 §1.4）：
 * - schema 与 integrity 重算；
 * - 精确串逐字核对（file:line 必须存在且包含 exactText）；
 * - 文件哈希/mtime 不一致 → stale；
 * - 指针可寻址；
 * - 伪造/不存在的 file:line 必须判失败（阳性对照）。
 */
import { existsSync, statSync } from 'node:fs'
import type {
  EvidenceCard,
  EvidenceIssue,
  EvidenceItem,
  EvidenceItemStatus,
  EvidenceValidationReport,
} from './types.ts'
import { EVIDENCE_SCHEMA_VERSION } from './types.ts'
import { verifyCardIntegrity } from './integrity.ts'
import { EvidenceError } from './errors.ts'
import { fingerprintFile, readLine, resolveProjectPath } from './fs-utils.ts'

export interface ValidationOptions {
  readonly projectRoot: string
  /** 关闭文件系统核对（仅结构测试用）；默认开启。 */
  readonly checkFiles?: boolean
  /** 敏感串扫描；默认开启。 */
  readonly secretScan?: boolean
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
]

const STATUSES = new Set<string>(['ok', 'stale', 'unverified'])

function issue(
  code: EvidenceIssue['code'],
  message: string,
  extra: Omit<EvidenceIssue, 'code' | 'message'> = {},
): EvidenceIssue {
  return { code, message, ...extra }
}

function sensitive(text: string | undefined): boolean {
  return text !== undefined && SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function checkSensitive(item: EvidenceItem, issues: EvidenceIssue[]): void {
  const fields = [
    item.item,
    item.value,
    item.exactText,
    item.neededEvidence,
    item.note,
    item.source?.file,
    item.source?.command,
  ]
  if (fields.some(sensitive)) {
    issues.push(issue('SENSITIVE_CONTENT', `条目 ${item.id} 含疑似密钥/令牌`, { itemId: item.id }))
  }
}

function staleIfChanged(
  item: EvidenceItem,
  options: ValidationOptions,
  issues: EvidenceIssue[],
  staleItemIds: string[],
): void {
  const source = item.source
  if (source?.file === undefined || options.checkFiles === false) return
  try {
    const fingerprint = fingerprintFile(options.projectRoot, source.file)
    const hashChanged =
      source.fileSha256 !== undefined && source.fileSha256 !== fingerprint.sha256
    const mtimeChanged =
      source.fileMtimeMs !== undefined &&
      Math.abs(source.fileMtimeMs - fingerprint.mtimeMs) > 0.001
    if (hashChanged || mtimeChanged) {
      if (!staleItemIds.includes(item.id)) staleItemIds.push(item.id)
      issues.push(
        issue('STALE', `条目 ${item.id} 的源文件已变化，续作前必须刷新`, {
          itemId: item.id,
          file: source.file,
          ...(source.line === undefined ? {} : { line: source.line }),
        }),
      )
    }
  } catch {
    // 文件不存在在别处报 SOURCE_NOT_FOUND；这里不重复。
  }
}

function validateExactItem(
  item: EvidenceItem,
  options: ValidationOptions,
  issues: EvidenceIssue[],
  staleItemIds: string[],
): void {
  if (item.status === 'unverified') {
    if (item.neededEvidence === undefined || item.neededEvidence.trim() === '') {
      issues.push(
        issue('UNVERIFIED_MISSING_EVIDENCE', `精确项 ${item.id} 标 unverified 但未说明所需证据`, {
          itemId: item.id,
        }),
      )
    }
    return
  }
  if (item.status === 'stale') {
    staleItemIds.push(item.id)
    issues.push(issue('STALE', `条目 ${item.id} 已标记 stale，续作前必须刷新`, { itemId: item.id }))
    return
  }
  if (item.source?.file === undefined || item.source.line === undefined) {
    issues.push(
      issue('EXACT_SOURCE_MISSING', `精确项 ${item.id} 缺少 source.file/line`, { itemId: item.id }),
    )
    return
  }
  if (item.exactText === undefined || item.exactText === '') {
    issues.push(
      issue('EXACT_TEXT_MISMATCH', `精确项 ${item.id} 缺少 exactText`, { itemId: item.id }),
    )
    return
  }
  if (options.checkFiles === false) return

  let lineText: string | undefined
  try {
    resolveProjectPath(options.projectRoot, item.source.file)
    lineText = readLine(options.projectRoot, item.source.file, item.source.line)
  } catch (error) {
    const code = error instanceof EvidenceError && error.code === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'SOURCE_NOT_FOUND'
    issues.push(
      issue(code, `精确项 ${item.id} 的源文件不可读`, {
        itemId: item.id,
        file: item.source.file,
        line: item.source.line,
      }),
    )
    return
  }
  if (lineText === undefined) {
    issues.push(
      issue('EXACT_TEXT_MISMATCH', `精确项 ${item.id} 的行号越界`, {
        itemId: item.id,
        file: item.source.file,
        line: item.source.line,
      }),
    )
    return
  }
  if (!lineText.includes(item.exactText)) {
    issues.push(
      issue('EXACT_TEXT_MISMATCH', `精确项 ${item.id} 与原文不一致`, {
        itemId: item.id,
        file: item.source.file,
        line: item.source.line,
      }),
    )
    return
  }
  staleIfChanged(item, options, issues, staleItemIds)
}

function validateSemanticItem(
  item: EvidenceItem,
  options: ValidationOptions,
  issues: EvidenceIssue[],
  staleItemIds: string[],
): void {
  if (item.value.trim() === '') {
    issues.push(issue('SCHEMA', `语义项 ${item.id} 的 value 为空`, { itemId: item.id }))
  }
  if (item.status === 'unverified') {
    if (item.neededEvidence === undefined || item.neededEvidence.trim() === '') {
      issues.push(
        issue('UNVERIFIED_MISSING_EVIDENCE', `语义项 ${item.id} 未说明所需证据`, { itemId: item.id }),
      )
    }
    return
  }
  if (item.status === 'stale') {
    staleItemIds.push(item.id)
    issues.push(issue('STALE', `条目 ${item.id} 已标记 stale，续作前必须刷新`, { itemId: item.id }))
    return
  }
  if (item.source?.file === undefined && item.source?.command === undefined) {
    issues.push(issue('SCHEMA', `语义项 ${item.id} 标 ok 但缺少 source`, { itemId: item.id }))
    return
  }
  if (item.source?.file !== undefined && options.checkFiles !== false) {
    try {
      resolveProjectPath(options.projectRoot, item.source.file)
      if (!existsSync(resolveProjectPath(options.projectRoot, item.source.file))) {
        issues.push(
          issue('SOURCE_NOT_FOUND', `语义项 ${item.id} 的源文件不存在`, {
            itemId: item.id,
            file: item.source.file,
          }),
        )
        return
      }
    } catch {
      issues.push(
        issue('UNSAFE_PATH', `语义项 ${item.id} 的源文件路径非法`, {
          itemId: item.id,
          file: item.source.file,
        }),
      )
      return
    }
    staleIfChanged(item, options, issues, staleItemIds)
  }
}

function validatePointer(card: EvidenceCard, options: ValidationOptions, issues: EvidenceIssue[]): void {
  const pointer = card.pointer
  if (pointer === undefined) return
  if (pointer.file !== undefined) {
    try {
      const absolute = resolveProjectPath(options.projectRoot, pointer.file)
      if (!existsSync(absolute)) {
        issues.push(issue('POINTER_UNRESOLVABLE', `pointer 文件不存在：${pointer.file}`, { file: pointer.file }))
      } else {
        statSync(absolute)
      }
    } catch {
      issues.push(issue('POINTER_UNRESOLVABLE', `pointer 路径非法：${pointer.file}`, { file: pointer.file }))
    }
  }
  if (pointer.selector !== undefined && pointer.selector.trim() === '') {
    issues.push(issue('POINTER_UNRESOLVABLE', 'pointer.selector 不得为空'))
  }
}

export function validateEvidenceCard(
  card: EvidenceCard,
  options: ValidationOptions,
): EvidenceValidationReport {
  const issues: EvidenceIssue[] = []
  const staleItemIds: string[] = []

  if (card === null || typeof card !== 'object') {
    return {
      ok: false,
      integrityOk: false,
      checkedItems: 0,
      issues: [issue('SCHEMA', '卡片不是对象')],
      staleItemIds: [],
    }
  }
  if (card.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    issues.push(issue('SCHEMA', `schemaVersion 不支持：${String(card.schemaVersion)}`))
  }
  if (typeof card.taskId !== 'string' || card.taskId === '') {
    issues.push(issue('SCHEMA', 'taskId 缺失'))
  }
  if (!Number.isInteger(card.revision) || card.revision < 0) {
    issues.push(issue('SCHEMA', 'revision 必须是非负整数'))
  }
  if (typeof card.currentTask !== 'string' || card.currentTask.trim() === '') {
    issues.push(issue('SCHEMA', 'currentTask 不得为空'))
  }
  if (typeof card.nextStep !== 'string' || card.nextStep.trim() === '') {
    issues.push(issue('SCHEMA', 'nextStep 不得为空'))
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    const value = card[field]
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      issues.push(issue('SCHEMA', `${field} 不是合法时间戳`))
    }
  }
  if (!Array.isArray(card.items)) {
    issues.push(issue('SCHEMA', 'items 必须是数组'))
    return {
      ok: false,
      integrityOk: false,
      checkedItems: 0,
      issues,
      staleItemIds,
    }
  }

  const integrityOk = verifyCardIntegrity(card)
  if (!integrityOk) {
    issues.push(issue('INTEGRITY_MISMATCH', 'integrity 重算不一致（卡片被改动或损坏）'))
  }

  const seen = new Set<string>()
  for (const item of card.items) {
    if (typeof item.id !== 'string' || item.id === '') {
      issues.push(issue('SCHEMA', '条目缺少 id'))
      continue
    }
    if (seen.has(item.id)) {
      issues.push(issue('DUPLICATE_ITEM_ID', `条目 id 重复：${item.id}`, { itemId: item.id }))
    }
    seen.add(item.id)
    if (item.kind !== 'exact' && item.kind !== 'semantic') {
      issues.push(issue('SCHEMA', `条目 ${item.id} 的 kind 非法`, { itemId: item.id }))
      continue
    }
    if (!STATUSES.has(item.status)) {
      issues.push(
        issue('INVALID_STATUS', `条目 ${item.id} 的 status 非法：${String(item.status)}`, {
          itemId: item.id,
        }),
      )
      continue
    }
    checkSensitive(item, issues)
    if (item.kind === 'exact') {
      validateExactItem(item, options, issues, staleItemIds)
    } else {
      validateSemanticItem(item, options, issues, staleItemIds)
    }
  }

  validatePointer(card, options, issues)

  return {
    ok: issues.length === 0,
    integrityOk,
    checkedItems: card.items.length,
    issues,
    staleItemIds: [...new Set(staleItemIds)],
  }
}

export type { EvidenceItemStatus }

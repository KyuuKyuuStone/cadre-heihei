/**
 * 证据卡结构（spike/03 §1；N17 第一部分）。
 *
 * 只做本地结构，不 import harness、不接模型。精确串与语义项分开：
 * - exact：file:line / 数字 / 命令 / 文件名，必须逐字核对；
 * - semantic：结论/摘要，必须带 source，或显式标 unverified + 所需证据。
 */
import type { IsoTimestamp, ProjectId, SessionId, TaskId } from '../protocol/index.ts'

export const EVIDENCE_SCHEMA_VERSION = '1.0.0' as const

export type EvidenceItemKind = 'exact' | 'semantic'
export type EvidenceItemStatus = 'ok' | 'stale' | 'unverified'

export interface EvidenceSource {
  /** 项目相对路径（禁止绝对路径与 `..` 越界）。 */
  readonly file?: string
  /** 1-based 行号。 */
  readonly line?: number
  /** 命令原文（与工具实际执行串一致）。 */
  readonly command?: string
  readonly cwd?: string
  readonly exitCode?: number
  /** 建卡时记录的文件指纹，用于 stale 检测。 */
  readonly fileSha256?: string
  readonly fileMtimeMs?: number
}

export interface EvidenceItem {
  /** 卡内唯一 ID（用于校验报告定位）。 */
  readonly id: string
  readonly kind: EvidenceItemKind
  /** 条目名（如「保留率」「API 版本」）。 */
  readonly item: string
  /** 精确串或语义结论；精确项必须与 exactText/真实输出一致。 */
  readonly value: string
  readonly source?: EvidenceSource
  /** exact 项必填：原文片段，必须出现在 source.file:line。 */
  readonly exactText?: string
  readonly status: EvidenceItemStatus
  readonly note?: string
  /** status='unverified' 时必填：缺什么证据才能判定。 */
  readonly neededEvidence?: string
}

export interface EvidencePointer {
  /** 完整卡片或证据文件路径（项目相对）。 */
  readonly file?: string
  /** 按需检索选择器（字段/行号切片），不返回全文。 */
  readonly selector?: string
  /** `evidence_card.read(taskId, selector)` 的提示路径。 */
  readonly cardPath?: string
}

export interface EvidenceIntegrity {
  readonly algorithm: 'sha256'
  /** 对规范化 payload（不含 integrity）计算的十六进制哈希。 */
  readonly value: string
}

export interface EvidenceCard {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
  readonly taskId: TaskId
  readonly projectId?: ProjectId
  readonly sessionId?: SessionId
  readonly ownerInstanceId?: string
  readonly ownerEpoch?: number
  readonly revision: number
  readonly currentTask: string
  readonly nextStep: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly items: readonly EvidenceItem[]
  readonly pointer?: EvidencePointer
  readonly integrity: EvidenceIntegrity
}

export type EvidenceCardInput = Omit<EvidenceCard, 'integrity'>
export type EvidenceCardPayload = Omit<EvidenceCard, 'integrity'>

export interface EvidenceIssue {
  readonly code:
    | 'SCHEMA'
    | 'INTEGRITY_MISMATCH'
    | 'DUPLICATE_ITEM_ID'
    | 'EXACT_SOURCE_MISSING'
    | 'EXACT_TEXT_MISMATCH'
    | 'SOURCE_NOT_FOUND'
    | 'UNSAFE_PATH'
    | 'POINTER_UNRESOLVABLE'
    | 'STALE'
    | 'UNVERIFIED_MISSING_EVIDENCE'
    | 'SENSITIVE_CONTENT'
    | 'INVALID_STATUS'
  readonly message: string
  readonly itemId?: string
  readonly file?: string
  readonly line?: number
}

export interface EvidenceValidationReport {
  readonly ok: boolean
  readonly integrityOk: boolean
  readonly checkedItems: number
  readonly issues: readonly EvidenceIssue[]
  readonly staleItemIds: readonly string[]
}

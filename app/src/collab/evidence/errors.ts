/** 证据卡结构化错误（本地模块，不映射到协议错误码）。 */
export type EvidenceErrorCode =
  | 'INVALID_CARD'
  | 'CARD_NOT_FOUND'
  | 'CARD_CORRUPT'
  | 'INTEGRITY_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'LEASE_HELD'
  | 'LEASE_REQUIRED'
  | 'LEASE_EXPIRED'
  | 'FENCING_REJECTED'
  | 'WRITE_FAILED'
  | 'UNSAFE_PATH'

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode
  readonly detail?: Record<string, unknown>

  constructor(code: EvidenceErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
    this.detail = detail
  }
}

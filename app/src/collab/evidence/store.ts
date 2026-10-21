/**
 * 证据卡落盘：单任务单卡 + 写者租约 + 原子写。
 *
 * 目录：<projectRoot>/.cadre/evidence/tasks/<taskId>/{card.json,card.lock}
 * - 卡片写入：临时文件 → fsync → rename；失败清理临时文件，旧卡不变；
 * - revision 必须严格递增，防旧写者覆盖；
 * - 租约含 fencingToken，过期可抢占且 token +1；持旧 token 的写入被拒。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { EvidenceError } from './errors.ts'
import { taskDir } from './fs-utils.ts'
import { verifyCardIntegrity } from './integrity.ts'
import type { EvidenceCard } from './types.ts'

export interface EvidenceLease {
  readonly ownerInstanceId: string
  readonly sessionId: string
  readonly ownerEpoch: number
  readonly fencingToken: number
  readonly acquiredAt: string
  readonly expiresAt: string
}

export interface AcquireLeaseInput {
  readonly ownerInstanceId: string
  readonly sessionId: string
  readonly ttlMs?: number
  readonly nowMs?: () => number
}

export type AcquireLeaseOutcome =
  | { readonly ok: true; readonly lease: EvidenceLease; readonly status: 'acquired' | 'renewed' | 'takeover' }
  | { readonly ok: false; readonly code: 'LEASE_HELD'; readonly lease: EvidenceLease }

export interface CardWriteOptions {
  readonly renameFile?: (from: string, to: string) => void
  readonly lease?: Pick<EvidenceLease, 'ownerInstanceId' | 'fencingToken'>
  readonly nowMs?: () => number
}

const DEFAULT_TTL_MS = 30_000
let tempSeq = 0

export function cardPath(projectRoot: string, taskId: string): string {
  return `${taskDir(projectRoot, taskId)}/card.json`
}

export function lockPath(projectRoot: string, taskId: string): string {
  return `${taskDir(projectRoot, taskId)}/card.lock`
}

function ensureTaskDir(projectRoot: string, taskId: string): string {
  const dir = taskDir(projectRoot, taskId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readEvidenceCard(projectRoot: string, taskId: string): EvidenceCard {
  const path = cardPath(projectRoot, taskId)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new EvidenceError('CARD_NOT_FOUND', `证据卡不存在：${path}`)
  }
  try {
    return JSON.parse(text) as EvidenceCard
  } catch (error) {
    throw new EvidenceError('CARD_CORRUPT', `证据卡 JSON 损坏：${path}`, {
      cause: String((error as Error).message),
    })
  }
}

export function writeEvidenceCard(
  projectRoot: string,
  card: EvidenceCard,
  options: CardWriteOptions = {},
): void {
  if (!verifyCardIntegrity(card)) {
    throw new EvidenceError('INTEGRITY_MISMATCH', '写入前 integrity 校验失败')
  }
  const now = (options.nowMs ?? Date.now)()
  if (options.lease !== undefined) {
    assertLeaseValid(projectRoot, card.taskId, options.lease, now)
  }

  const path = cardPath(projectRoot, card.taskId)
  if (existsSync(path)) {
    const existing = readEvidenceCard(projectRoot, card.taskId)
    if (card.revision <= existing.revision) {
      throw new EvidenceError('REVISION_CONFLICT', `revision 必须递增：${existing.revision} → ${card.revision}`, {
        current: existing.revision,
        incoming: card.revision,
      })
    }
  }

  const dir = ensureTaskDir(projectRoot, card.taskId)
  const tempPath = `${dir}/.card.json.tmp-${process.pid}-${++tempSeq}`
  const rename = options.renameFile ?? renameSync
  try {
    writeFileSync(tempPath, `${JSON.stringify(card, null, 2)}\n`, 'utf8')
    const fd = openSync(tempPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    rename(tempPath, path)
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // 清理失败不覆盖原始错误。
    }
    throw new EvidenceError('WRITE_FAILED', `证据卡原子写失败：${path}`, {
      cause: String((error as Error).message),
    })
  }
}

export function deleteEvidenceCard(projectRoot: string, taskId: string): boolean {
  const path = cardPath(projectRoot, taskId)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export function readLease(projectRoot: string, taskId: string): EvidenceLease | undefined {
  const path = lockPath(projectRoot, taskId)
  if (!existsSync(path)) return undefined
  try {
    const lease = JSON.parse(readFileSync(path, 'utf8')) as EvidenceLease
    if (
      typeof lease.ownerInstanceId !== 'string' ||
      typeof lease.fencingToken !== 'number' ||
      typeof lease.expiresAt !== 'string'
    ) {
      return undefined
    }
    return lease
  } catch {
    return undefined
  }
}

function leaseExpired(lease: EvidenceLease, nowMs: number): boolean {
  return Date.parse(lease.expiresAt) <= nowMs
}

export function acquireLease(
  projectRoot: string,
  taskId: string,
  input: AcquireLeaseInput,
): AcquireLeaseOutcome {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
  const nowMs = (input.nowMs ?? Date.now)()
  const dir = ensureTaskDir(projectRoot, taskId)
  const path = `${dir}/card.lock`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readLease(projectRoot, taskId)
    if (existing !== undefined) {
      if (!leaseExpired(existing, nowMs)) {
        if (existing.ownerInstanceId === input.ownerInstanceId) {
          const renewed: EvidenceLease = {
            ...existing,
            expiresAt: new Date(nowMs + ttlMs).toISOString(),
          }
          writeFileSync(path, JSON.stringify(renewed), 'utf8')
          return { ok: true, lease: renewed, status: 'renewed' }
        }
        return { ok: false, code: 'LEASE_HELD', lease: existing }
      }
    }

    const fencingToken = (existing?.fencingToken ?? 0) + 1
    const lease: EvidenceLease = {
      ownerInstanceId: input.ownerInstanceId,
      sessionId: input.sessionId,
      ownerEpoch: fencingToken,
      fencingToken,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    }
    try {
      const fd = openSync(path, 'wx')
      try {
        writeFileSync(fd, JSON.stringify(lease), 'utf8')
      } finally {
        closeSync(fd)
      }
      return { ok: true, lease, status: existing === undefined ? 'acquired' : 'takeover' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new EvidenceError('WRITE_FAILED', '租约写入失败', {
          cause: String((error as Error).message),
        })
      }
      // 竞争：重新读取后按持有者/过期状态决定；过期则用 rename 抢占。
      const raced = readLease(projectRoot, taskId)
      if (raced !== undefined && leaseExpired(raced, nowMs)) {
        const temp = `${dir}/.card.lock.tmp-${process.pid}-${++tempSeq}`
        const takeover: EvidenceLease = {
          ...lease,
          fencingToken: raced.fencingToken + 1,
          ownerEpoch: raced.fencingToken + 1,
        }
        writeFileSync(temp, JSON.stringify(takeover), 'utf8')
        renameSync(temp, path)
        return { ok: true, lease: takeover, status: 'takeover' }
      }
      if (raced !== undefined) return { ok: false, code: 'LEASE_HELD', lease: raced }
    }
  }
  const lease = readLease(projectRoot, taskId)
  if (lease !== undefined) return { ok: false, code: 'LEASE_HELD', lease }
  throw new EvidenceError('WRITE_FAILED', '租约竞争未能解决')
}

export function assertLeaseValid(
  projectRoot: string,
  taskId: string,
  expected: Pick<EvidenceLease, 'ownerInstanceId' | 'fencingToken'>,
  nowMs: number = Date.now(),
): EvidenceLease {
  const lease = readLease(projectRoot, taskId)
  if (lease === undefined) {
    throw new EvidenceError('LEASE_REQUIRED', '写入必须持有租约')
  }
  if (leaseExpired(lease, nowMs)) {
    throw new EvidenceError('LEASE_EXPIRED', '租约已过期，需重新抢占', { fencingToken: lease.fencingToken })
  }
  if (
    lease.ownerInstanceId !== expected.ownerInstanceId ||
    lease.fencingToken !== expected.fencingToken
  ) {
    throw new EvidenceError('FENCING_REJECTED', '租约 fencing token 不匹配（旧写者被拒）', {
      expected,
      actual: { ownerInstanceId: lease.ownerInstanceId, fencingToken: lease.fencingToken },
    })
  }
  return lease
}

export function releaseLease(
  projectRoot: string,
  taskId: string,
  ownerInstanceId: string,
  fencingToken: number,
): boolean {
  const lease = readLease(projectRoot, taskId)
  if (lease === undefined) return false
  if (lease.ownerInstanceId !== ownerInstanceId || lease.fencingToken !== fencingToken) return false
  unlinkSync(lockPath(projectRoot, taskId))
  return true
}

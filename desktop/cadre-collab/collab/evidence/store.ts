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
  rmdirSync,
  statSync,
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
  /** 竞争失败；不返回 fencingToken，避免多头持有同一 token 的歧义。 */
  | { readonly ok: false; readonly code: 'LEASE_HELD' }

export interface CardWriteOptions {
  readonly renameFile?: (from: string, to: string) => void
  readonly lease?: Pick<EvidenceLease, 'ownerInstanceId' | 'fencingToken'>
  /**
   * 显式放弃租约保护（默认 false）。仅允许初次建卡/离线修复等单写者场景；
   * 并发下会绕过 fencing，可能丢更新——调用方必须在注释中说明风险。
   */
  readonly allowUnsafeNoLease?: boolean
  readonly nowMs?: () => number
}

const DEFAULT_TTL_MS = 30_000
const GATE_STALE_MS = 5_000
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
  } else if (options.allowUnsafeNoLease !== true) {
    // 默认强制单写者租约；并发下绕过 fencing 会丢更新。
    throw new EvidenceError('LEASE_REQUIRED', '写入证据卡必须持有租约（或显式 allowUnsafeNoLease）')
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

function gateIsStale(gatePath: string): boolean {
  try {
    return Date.now() - statSync(gatePath).mtimeMs > GATE_STALE_MS
  } catch {
    return false
  }
}

/**
 * 所有 acquire 共用一把目录门闩（mkdir 原子），把「读旧锁 → 抢占 → 写新锁」
 * 收进临界区，避免接管者在 rename 间隙互相覆盖。
 * 门闩由持锁进程在 finally 删除；异常崩溃留下的门闩超过 5s 视为陈旧。
 */
function withLeaseGate<T>(
  dir: string,
  fn: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  const gatePath = `${dir}/card.lock.gate`
  let acquired = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(gatePath)
      acquired = true
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw new EvidenceError('WRITE_FAILED', '租约门闩创建失败', {
          cause: String((error as Error).message),
        })
      }
      if (attempt === 0 && gateIsStale(gatePath)) {
        try {
          rmdirSync(gatePath)
        } catch {
          // 其他进程可能已清理；继续重试一次。
        }
        continue
      }
      return { ok: false }
    }
  }
  if (!acquired) return { ok: false }
  try {
    return { ok: true, value: fn() }
  } finally {
    try {
      rmdirSync(gatePath)
    } catch {
      // 临界区已完成；门闩清理失败不应改写业务结果。
    }
  }
}

function writeLockAtomic(path: string, lease: EvidenceLease): void {
  const temp = `${path}.new-${process.pid}-${++tempSeq}`
  try {
    writeFileSync(temp, JSON.stringify(lease), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // 清理失败不覆盖原始错误。
    }
    throw error
  }
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

  const gated = withLeaseGate(dir, (): AcquireLeaseOutcome => {
    const existing = readLease(projectRoot, taskId)

    if (existing !== undefined && !leaseExpired(existing, nowMs)) {
      if (existing.ownerInstanceId === input.ownerInstanceId) {
        const renewed: EvidenceLease = {
          ...existing,
          expiresAt: new Date(nowMs + ttlMs).toISOString(),
        }
        writeLockAtomic(path, renewed)
        return { ok: true, lease: renewed, status: 'renewed' }
      }
      return { ok: false, code: 'LEASE_HELD' }
    }

    if (existing !== undefined) {
      // 过期接管：先把旧锁 rename 到唯一 backup（rename 原子）。
      // 门闩保证同一时刻只有一个接管者进入；rename 仍作为最终仲裁。
      const backup = `${path}.stale-${process.pid}-${++tempSeq}`
      try {
        renameSync(path, backup)
      } catch {
        return { ok: false, code: 'LEASE_HELD' }
      }
      const fencingToken = existing.fencingToken + 1
      const lease: EvidenceLease = {
        ownerInstanceId: input.ownerInstanceId,
        sessionId: input.sessionId,
        ownerEpoch: fencingToken,
        fencingToken,
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      }
      try {
        writeLockAtomic(path, lease)
      } catch (error) {
        // 新锁写入失败：尽量恢复旧锁，绝不返回成功。
        try {
          renameSync(backup, path)
        } catch {
          // 恢复失败时保留 backup 供人工处理。
        }
        throw new EvidenceError('WRITE_FAILED', '接管租约写入失败', {
          cause: String((error as Error).message),
        })
      }
      try {
        unlinkSync(backup)
      } catch {
        // backup 只是旧锁副本，清理失败不影响 fencing。
      }
      return { ok: true, lease, status: 'takeover' }
    }

    const lease: EvidenceLease = {
      ownerInstanceId: input.ownerInstanceId,
      sessionId: input.sessionId,
      ownerEpoch: 1,
      fencingToken: 1,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    }
    writeLockAtomic(path, lease)
    return { ok: true, lease, status: 'acquired' }
  })

  return gated.ok ? gated.value : { ok: false, code: 'LEASE_HELD' }
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

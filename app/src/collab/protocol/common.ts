/**
 * 协议通用结构：通道、投递状态、回执自证字段、状态推进结果、空集合。
 *
 * W1-04 类型草案；契约来源 `docs/product/backend/01` §0/§2、`docs/handover/02` 铁律 11。
 */
import type { ApiVersion, IsoTimestamp, Sha256Hex } from './ids.ts'

/** HTTP 为主、文件信箱仅降级（backend/01 §2.1）。 */
export const CHANNELS = ['http', 'mailbox'] as const
export type Channel = (typeof CHANNELS)[number]

export const DELIVERY_STATES = ['received', 'delivered', 'failed'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** `preview` 的最大字符数（backend/01 §2.2）。计数单位见协议 README U-07。 */
export const PREVIEW_MAX_CHARS = 50 as const

/** `bodyBytes` 的编码口径：UTF-8 实收字节数，非发送端本地长度。 */
export const BODY_BYTES_ENCODING = 'utf-8' as const

/**
 * 回执自证字段（大藤峡 E1 事故的反向设计）：
 * 三个值均由服务端对「实收正文」计算，发送方可比对本地值发现静默失败。
 */
export interface BodyReceipt {
  readonly bodyBytes: number
  readonly preview: string
  readonly bodySha256: Sha256Hex
}

/**
 * 状态推进结果：
 * - `ledgerUpdated: false` 表示消息已投递但台账未推进，必须附原因，不得伪报成功（铁律 8）。
 */
export type LedgerUpdate =
  | { readonly ledgerUpdated: true }
  | { readonly ledgerUpdated: false; readonly ledgerError: string }

export interface ServerMeta {
  readonly serverVersion: string
}

export type ApiOk<T> = { readonly ok: true; readonly apiVersion: ApiVersion } & T

/**
 * 空集合是合法初始态（铁律 11）：必须带 `reason` 与下一步 `hint`，
 * 不得表述为 error，也不得让调用方进入排错模式。
 */
export const EMPTY_REASONS = [
  'no_projects',
  'no_workers_yet',
  'no_workers_in_project',
  'project_not_matched',
  'no_tasks',
  'no_tasks_for_filter',
  'no_messages',
  'no_candidates',
] as const
export type EmptyReason = (typeof EMPTY_REASONS)[number]

/**
 * 空集合响应。实现必须保证 `items.length === 0`（类型层以 `empty: true` 作判别）。
 */
export interface EmptyList<T> {
  readonly items: readonly T[]
  readonly empty: true
  readonly reason: EmptyReason
  readonly hint: string
}

/** 时间字段统一为服务端生成的 UTC ISO-8601。 */
export type ServerTimestamp = IsoTimestamp

/**
 * 回执自证字段计算：对「实收原样」正文计算 bodyBytes / bodySha256 / preview。
 *
 * 口径（backend/01 §2.3，U-07/U-13）：
 * - bodyBytes：UTF-8 字节数，不去 BOM、不做换行规范化、不做任何 trim；
 * - bodySha256：同口径哈希（小写十六进制）；
 * - preview：先 trim 首尾空白，再取前 50 个 Unicode code point；若仍有剩余，
 *   末尾追加一个 `…`（总长最多 51 code point）。trim 与省略号只影响 preview，
 *   不影响 bodyBytes / bodySha256。
 */
import { createHash } from 'node:crypto'
import {
  BODY_BYTES_ENCODING,
  PREVIEW_MAX_CODE_POINTS,
  type BodyReceipt,
  type Sha256Hex,
} from '../protocol/index.ts'

/**
 * 先 trim 首尾空白，再取前 N 个 code point；超长追加 `…`。
 * 展开迭代器按 code point 计数，代理对（emoji）不会被劈开。
 */
export function previewOf(body: string, limit: number = PREVIEW_MAX_CODE_POINTS): string {
  const trimmed = body.trim()
  const codePoints = [...trimmed]
  if (codePoints.length <= limit) return trimmed
  return `${codePoints.slice(0, limit).join('')}…`
}

export function buildBodyReceipt(body: string): BodyReceipt {
  return {
    bodyBytes: Buffer.byteLength(body, BODY_BYTES_ENCODING),
    preview: previewOf(body),
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') as Sha256Hex,
  }
}

/**
 * 阳性对照用：trim 后按 UTF-16 代码单元截断（错误实现，且漏掉省略号）。
 * 生产代码不得调用；仅测试用来证明 preview 断言能抓到 slice 截断。
 */
export function utf16BrokenPreview(body: string, limit: number = PREVIEW_MAX_CODE_POINTS): string {
  return body.trim().slice(0, limit)
}

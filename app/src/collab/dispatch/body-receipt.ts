/**
 * 回执自证字段计算：对「实收原样」正文计算 bodyBytes / bodySha256 / preview。
 *
 * 口径（U-07/U-13 已裁决，backend/01 §2.2）：
 * - bodyBytes：UTF-8 字节数，不去 BOM、不做换行规范化、不做任何 trim；
 * - bodySha256：同口径哈希（小写十六进制）；
 * - preview：前 50 个 Unicode code point（用迭代器，不按 UTF-16 代码单元截断）。
 */
import { createHash } from 'node:crypto'
import {
  BODY_BYTES_ENCODING,
  PREVIEW_MAX_CODE_POINTS,
  type BodyReceipt,
  type Sha256Hex,
} from '../protocol/index.ts'

/** 前 N 个 code point；`Array.from`/展开会按 code point 迭代，代理对不会被劈开。 */
export function previewOf(body: string, limit: number = PREVIEW_MAX_CODE_POINTS): string {
  return [...body].slice(0, limit).join('')
}

export function buildBodyReceipt(body: string): BodyReceipt {
  return {
    bodyBytes: Buffer.byteLength(body, BODY_BYTES_ENCODING),
    preview: previewOf(body),
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') as Sha256Hex,
  }
}

/**
 * 阳性对照用：故意按 UTF-16 代码单元截断（错误实现）。
 * 生产代码不得调用；仅测试用来证明 preview 断言能抓到 slice 截断。
 */
export function utf16BrokenPreview(body: string, limit: number = PREVIEW_MAX_CODE_POINTS): string {
  return body.slice(0, limit)
}

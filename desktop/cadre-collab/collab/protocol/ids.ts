/**
 * 协议基础类型：品牌 ID、API 版本、时间戳、哈希。
 *
 * W1-04 类型草案：只有类型声明与常量，不含构造函数与校验实现。
 * 契约来源：`docs/product/backend/01-数据契约草案.md` §0（ID/时间戳/apiVersion）。
 */

declare const cadreBrand: unique symbol

/** 品牌类型：运行时均为 string，类型层防止跨语义混用。 */
export type Brand<T, B extends string> = T & { readonly [cadreBrand]: B }

export type ProjectId = Brand<string, 'ProjectId'>
export type SessionId = Brand<string, 'SessionId'>
export type TaskId = Brand<string, 'TaskId'>
export type MessageId = Brand<string, 'MessageId'>
export type EventId = Brand<string, 'EventId'>
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

/** UTC ISO-8601，由服务端生成；不接受客户端时间（backend/01 §0）。 */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>

/** 小写十六进制 SHA-256（64 字符）；算法与大小写归一在实现层校验。 */
export type Sha256Hex = Brand<string, 'Sha256Hex'>

/** 契约版本；未知字段一律忽略（前向兼容，backend/01 §0）。 */
export const API_VERSION = 'cadre-heihei/1' as const
export type ApiVersion = typeof API_VERSION

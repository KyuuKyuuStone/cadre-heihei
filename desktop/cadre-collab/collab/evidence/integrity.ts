/**
 * 证据卡完整性：键排序 + 去 undefined → UTF-8 JSON → sha256。
 * 规范化只用于哈希，不改写卡片存储内容。
 */
import { createHash } from 'node:crypto'
import type {
  EvidenceCard,
  EvidenceCardInput,
  EvidenceCardPayload,
  EvidenceIntegrity,
} from './types.ts'

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const child = source[key]
      if (child === undefined) continue
      output[key] = normalize(child)
    }
    return output
  }
  return value
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function payloadOf(card: EvidenceCard | EvidenceCardInput): EvidenceCardPayload {
  const { integrity, ...payload } = card as EvidenceCard
  return payload
}

export function computeIntegrity(card: EvidenceCard | EvidenceCardInput): EvidenceIntegrity {
  const value = createHash('sha256').update(canonicalize(payloadOf(card)), 'utf8').digest('hex')
  return { algorithm: 'sha256', value }
}

/** 计算并封存 integrity；输入不含 integrity。 */
export function sealCard(input: EvidenceCardInput): EvidenceCard {
  return { ...input, integrity: computeIntegrity(input) }
}

export function verifyCardIntegrity(card: EvidenceCard): boolean {
  if (card.integrity?.algorithm !== 'sha256' || typeof card.integrity.value !== 'string') {
    return false
  }
  return computeIntegrity(card).value === card.integrity.value
}

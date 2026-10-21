// 新增测试（W1-10 返工）：前身仅有源码、无同名测试。
import { describe, it } from 'node:test'
import { expect } from '../assert-compat.ts'
import { formatBytes } from '../../../src/renderer/lib/formatBytes.ts'

describe('formatBytes', () => {
  it('returns 0 B for zero, negative and non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('formats bytes under 1 KiB without decimals', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('scales to KiB/MiB and keeps one decimal below 10', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
  })

  it('scales to GiB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
  })
})

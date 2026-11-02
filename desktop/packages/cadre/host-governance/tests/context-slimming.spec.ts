import { describe, expect, it } from 'vitest'
import {
  SLIM_DEFAULTS, dedupeToolResults, slimToolResult, summarizeAssistantHistory,
} from '../src/context-slimming.ts'

describe('context slimming', () => {
  it('caps inline tool output at 2k with a locator while keeping head and tail', () => {
    const text = `HEAD${'x'.repeat(5_000)}TAIL`
    const slim = slimToolResult(text, 'spill:abc', SLIM_DEFAULTS.toolInlineChars)
    expect(Array.from(slim).length).toBeLessThanOrEqual(SLIM_DEFAULTS.toolInlineChars + 160)
    expect(slim).toContain('HEAD')
    expect(slim).toContain('TAIL')
    expect(slim).toContain('spill:abc')
    expect(slim).toContain('summary:')
    expect(slimToolResult('short', 'spill:x')).toBe('short')
    expect(Array.from(slimToolResult(text, 'spill:abc', 8_000)).length).toBe(Array.from(text).length)
  })

  it('dedupes the same tool output within one round and keeps the first', () => {
    const results = dedupeToolResults([
      { key: 'read:src/a.ts', id: 'e1', text: 'A'.repeat(3_000) },
      { key: 'read:src/a.ts', id: 'e2', text: 'A'.repeat(3_000) },
      { key: 'read:src/b.ts', id: 'e3', text: 'B' },
    ])
    expect(results[0]?.truncated).toBe(true)
    expect(results[1]).toMatchObject({ duplicateOf: 'e1' })
    expect(results[1]?.text).toContain('duplicate of e1')
    expect(results[2]).toMatchObject({ id: 'e3', truncated: false, text: 'B' })
  })

  it('summarizes long assistant history without dropping constraints or acceptance', () => {
    const text = `前言${'x'.repeat(1_000)}\n约束：不得改 schema\n验收：pnpm test\n禁止：不 push`
    const readonly = summarizeAssistantHistory(text)
    expect(readonly.summarized).toBe(true)
    expect(Array.from(readonly.text).length).toBeLessThan(Array.from(text).length)
    expect(readonly.text).toContain('约束：不得改 schema')
    expect(readonly.text).toContain('验收：pnpm test')
    expect(readonly.text).toContain('禁止：不 push')
    expect(readonly.text).toContain('原文仍保留')
    expect(summarizeAssistantHistory('短')).toEqual({ text: '短', summarized: false })
    expect(summarizeAssistantHistory(text, { ...SLIM_DEFAULTS, assistantSummaryChars: 5_000 }).summarized).toBe(false)
  })
})

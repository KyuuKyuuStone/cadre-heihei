import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CADRE_BUILD_STAMP_VERSION,
  CADRE_OUTPUTS,
  CADRE_STAMP_PATH,
  readCadreStamp,
  validateCadreStamp,
} from './cadre-build-stamp.mjs'

const SHA = 'a'.repeat(64)

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function validStamp(): Record<string, unknown> {
  return {
    version: CADRE_BUILD_STAMP_VERSION,
    builtAt: '2026-10-28T12:00:00.000Z',
    esbuildVersion: '0.28.2',
    sourceHash: SHA,
    sourceFiles: 1,
    sources: { 'cadre-collab/entry.ts': SHA },
    outputs: CADRE_OUTPUTS.map(path => ({ path, sha256: SHA, bytes: 1024 })),
  }
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-stamp-'))
  roots.push(root)
  return root
}

function writeStamp(value: unknown): string {
  const root = scratch()
  const file = join(root, ...CADRE_STAMP_PATH.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return root
}

function expectProblem(result: ReturnType<typeof readCadreStamp>): string {
  if (!('problem' in result)) throw new Error('expected a stamp problem')
  return result.problem
}

describe('readCadreStamp shape validation', () => {
  it('reports a missing stamp instead of returning undefined', () => {
    const problem = expectProblem(readCadreStamp(scratch()))
    expect(problem).toContain('缺少构建产物 stamp')
  })

  it('reports invalid JSON', () => {
    const problem = expectProblem(readCadreStamp(writeStamp('{ not json')))
    expect(problem).toContain('不是合法 JSON')
  })

  it.each([
    ['null', null],
    ['array', []],
    ['string', JSON.stringify('stamp')],
  ])('rejects a non-object top level (%s)', (_name, value) => {
    expectProblem(readCadreStamp(writeStamp(value)))
  })

  it('rejects a missing outputs array', () => {
    const stamp = validStamp()
    delete stamp.outputs
    const problem = expectProblem(readCadreStamp(writeStamp(stamp)))
    expect(problem).toContain('stamp.outputs')
  })

  it('rejects a non-object outputs entry', () => {
    const stamp = { ...validStamp(), outputs: ['apps/desktop/lib/cadre-collab.cjs'] }
    const problem = expectProblem(readCadreStamp(writeStamp(stamp)))
    expect(problem).toContain('stamp.outputs[0] 不是对象')
  })

  it('rejects a sources value that is not a sha256 string', () => {
    const stamp = { ...validStamp(), sources: { 'cadre-collab/entry.ts': 42 } }
    const problem = expectProblem(validateCadreStamp(stamp))
    expect(problem).toContain('不是 sha256 字符串')
  })

  it('rejects an output with a bad sha256 or byte count', () => {
    const badSha = validStamp()
    badSha.outputs = [{ path: CADRE_OUTPUTS[0], sha256: 'short', bytes: 1 }]
    expect(expectProblem(validateCadreStamp(badSha))).toContain('sha256')

    const badBytes = validStamp()
    badBytes.outputs = [{ path: CADRE_OUTPUTS[0], sha256: SHA, bytes: -1 }]
    expect(expectProblem(validateCadreStamp(badBytes))).toContain('bytes')
  })

  it('rejects a different stamp layout version', () => {
    const stamp = { ...validStamp(), version: CADRE_BUILD_STAMP_VERSION + 1 }
    expect(expectProblem(validateCadreStamp(stamp))).toContain('stamp.version')
  })

  it('accepts a complete stamp', () => {
    const result = readCadreStamp(writeStamp(validStamp()))
    if (!('stamp' in result)) throw new Error(`unexpected problem: ${result.problem}`)
    expect(result.stamp.sourceFiles).toBe(1)
    expect(result.stamp.outputs).toHaveLength(CADRE_OUTPUTS.length)
  })
})

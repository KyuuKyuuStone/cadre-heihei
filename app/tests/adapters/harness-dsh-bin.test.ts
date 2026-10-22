/** dshBin 透传：提供时进入 SDK launch options，缺失时不注入（由 SDK 回退）。不依赖真实 dsh。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAdapter } from '../../src/adapters/engine/harness/index.ts'
import type { SessionId } from '../../src/collab/protocol/ids.ts'

const FAKE_SDK = `
globalThis.__cadreDshBinLog = globalThis.__cadreDshBinLog || []
class FakeSession {
  constructor(id, cwd) { this.id = id; this.wd = cwd || '' }
  async setWorkingDirectory(path) { this.wd = path; return path }
  async getWorkingDirectory() { return this.wd }
  async run() { return { sessionId: this.id, finalResponse: 'OK', events: [], notifications: [] } }
}
export class DeepSeekHarness {
  constructor(options) {
    this.options = options || {}
    globalThis.__cadreDshBinLog.push({
      dshBin: this.options.dshBin,
      patches: this.options.patches,
    })
  }
  async start() {}
  async close() {}
  session(id) { return new FakeSession(id || 'session-fake', this.options.cwd) }
  async resumeSession(id) { return new FakeSession(id, this.options.cwd) }
}
`

interface LogEntry {
  readonly dshBin?: string
  readonly patches?: readonly string[]
}

function setup(root: string) {
  ;(globalThis as unknown as { __cadreDshBinLog?: LogEntry[] }).__cadreDshBinLog = []
  const sdkEntry = join(root, 'fake-sdk.mjs')
  writeFileSync(sdkEntry, FAKE_SDK, 'utf8')
  const patch = join(root, 'identity.cordis.yml')
  writeFileSync(patch, '# sessionId: s1\n', 'utf8')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  return { sdkEntry, patch, work }
}

function log(): LogEntry[] {
  return (globalThis as unknown as { __cadreDshBinLog?: LogEntry[] }).__cadreDshBinLog ?? []
}

test('提供 dshBin：原样传入 SDK launch options（创建与重建）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-dsh-bin-'))
  try {
    const { sdkEntry, patch, work } = setup(root)
    const dshBin = 'C:/pack/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const adapter = new HarnessAdapter({ dshHomeBase: join(root, 'homes'), sdkEntry, dshBin })
    await adapter.start()
    const sessionId = 's1' as SessionId
    await adapter.createSessionWithRuntime({
      sessionId,
      runtimeId: 'r1',
      dshHome: join(root, 'homes', 'r1'),
      patchPaths: [patch],
      workingDirectory: work,
    })
    await adapter.rebuildSession(sessionId, { patchPaths: [patch] })
    const constructs = log()
    assert.equal(constructs.length, 2)
    assert.equal(constructs[0]?.dshBin, dshBin)
    assert.equal(constructs[1]?.dshBin, dshBin)
    await adapter.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('未提供 dshBin：不注入字段，交给 SDK 回退 installed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-dsh-bin-'))
  try {
    const { sdkEntry, patch, work } = setup(root)
    const adapter = new HarnessAdapter({ dshHomeBase: join(root, 'homes'), sdkEntry })
    await adapter.start()
    await adapter.createSessionWithRuntime({
      sessionId: 's2' as SessionId,
      runtimeId: 'r2',
      dshHome: join(root, 'homes', 'r2'),
      patchPaths: [patch],
      workingDirectory: work,
    })
    const constructs = log()
    assert.equal(constructs.length, 1)
    assert.equal(constructs[0]?.dshBin, undefined)
    await adapter.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

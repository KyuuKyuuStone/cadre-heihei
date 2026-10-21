import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAdapter } from '../../src/adapters/engine/harness/index.ts'
import type { SessionId } from '../../src/collab/protocol/ids.ts'

const FAKE_SDK = `
globalThis.__cadreFakeHarness = globalThis.__cadreFakeHarness || []
class FakeSession {
  constructor(id, cwd) { this.id = id; this.wd = cwd || '' }
  async setWorkingDirectory(path) { this.wd = path; return path }
  async getWorkingDirectory() { return this.wd }
  async run() { return { sessionId: this.id, finalResponse: 'OK', events: [], notifications: [] } }
}
export class DeepSeekHarness {
  constructor(options) {
    this.options = options || {}
    this.closed = false
    globalThis.__cadreFakeHarness.push({ event: 'construct', dshHome: this.options.dshHome, patches: this.options.patches })
  }
  async start() {}
  async close() {
    if (this.closed) return
    this.closed = true
    globalThis.__cadreFakeHarness.push({ event: 'close', dshHome: this.options.dshHome })
  }
  session(id) { return new FakeSession(id || 'session-fake', this.options.cwd) }
  async resumeSession(id) { return new FakeSession(id, this.options.cwd) }
}
`

interface FakeLogEntry {
  readonly event: 'construct' | 'close'
  readonly dshHome?: string
  readonly patches?: readonly string[]
}

test('adapter rebuildSession defaults to forced rebuild (ready state is not enough); force=false reuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-harness-rebuild-'))
  try {
    const sdkEntry = join(root, 'fake-sdk.mjs')
    writeFileSync(sdkEntry, FAKE_SDK, 'utf8')
    const patch = join(root, 'identity.cordis.yml')
    writeFileSync(patch, '# sessionId: session-rebuild\n', 'utf8')
    const work = join(root, 'work')
    const dshHome = join(root, 'homes', 'runtime-rebuild')
    mkdirSync(work, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    const adapter = new HarnessAdapter({ dshHomeBase: join(root, 'homes'), sdkEntry })
    await adapter.start()
    const sessionId = 'session-rebuild' as SessionId
    const first = await adapter.createSessionWithRuntime({
      sessionId,
      runtimeId: 'runtime-rebuild',
      dshHome,
      patchPaths: [patch],
      workingDirectory: work,
    })
    const log = (globalThis as unknown as { __cadreFakeHarness?: FakeLogEntry[] }).__cadreFakeHarness ?? []
    assert.equal(log.filter((item) => item.event === 'construct').length, 1)

    const rebuilt = await adapter.rebuildSession(sessionId, { patchPaths: [patch] })
    assert.notEqual(rebuilt, first)
    assert.equal(adapter.sessionState(sessionId), 'ready')
    assert.equal(log.filter((item) => item.event === 'construct').length, 2)
    assert.equal(log.filter((item) => item.event === 'close').length, 1)
    assert.equal(log.filter((item) => item.event === 'construct')[1]?.dshHome, dshHome)
    assert.deepEqual(log.filter((item) => item.event === 'construct')[1]?.patches, [patch])

    const before = log.length
    const reused = await adapter.rebuildSession(sessionId, { patchPaths: [patch], force: false })
    assert.equal(reused.sessionId, sessionId)
    assert.equal(log.length, before)
    await adapter.stop()
    assert.ok(log.filter((item) => item.event === 'close').length >= 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

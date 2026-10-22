/** sdkEntry 解析与 registry → adapter 透传（不依赖真实 dsh / 真实 SDK）。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionRuntimeRegistry } from '../../src/runtime/session-runtime-registry.ts'
import type { SessionId } from '../../src/collab/protocol/ids.ts'
import { resolveSdkEntry } from '../../src/main/dsh-path.ts'

const REPO = 'C:/repo'
const RESOURCES = 'C:/install/resources'
const DEV_SDK = join(REPO, 'vendor', 'deepseek-harness', 'packages', 'sdk', 'client', 'lib', 'index.js')
const PACKAGED_SDK = join(
  RESOURCES,
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh-sdk-client',
  'lib',
  'index.js',
)

test('sdkEntry：env 覆盖优先', () => {
  const resolved = resolveSdkEntry({
    env: { CADRE_SDK_ENTRY: 'C:/custom/sdk/index.js' },
    isPackaged: true,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: () => true,
  })
  assert.equal(resolved, 'C:/custom/sdk/index.js')
})

test('sdkEntry：打包态命中 resources/dsh/.../dsh-sdk-client', () => {
  const resolved = resolveSdkEntry({
    env: {},
    isPackaged: true,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: (path) => path === PACKAGED_SDK,
  })
  assert.equal(resolved, PACKAGED_SDK)
})

test('sdkEntry：dev 命中 repo packages/sdk/client', () => {
  const resolved = resolveSdkEntry({
    env: {},
    isPackaged: false,
    resourcesPath: RESOURCES,
    repoRoot: REPO,
    exists: (path) => path === DEV_SDK,
  })
  assert.equal(resolved, DEV_SDK)
})

test('sdkEntry：两态缺失均返回 undefined（保持 HARNESS_SDK_MISSING 行为）', () => {
  for (const isPackaged of [true, false]) {
    const resolved = resolveSdkEntry({
      env: {},
      isPackaged,
      resourcesPath: RESOURCES,
      repoRoot: REPO,
      exists: () => false,
    })
    assert.equal(resolved, undefined)
  }
})

const FAKE_SDK = `
globalThis.__cadreSdkEntryLog = globalThis.__cadreSdkEntryLog || []
class FakeSession {
  constructor(id, cwd) { this.id = id; this.wd = cwd || '' }
  async setWorkingDirectory(path) { this.wd = path; return path }
  async getWorkingDirectory() { return this.wd }
  async run() { return { sessionId: this.id, finalResponse: 'OK', events: [], notifications: [] } }
}
export class DeepSeekHarness {
  constructor(options) {
    this.options = options || {}
    globalThis.__cadreSdkEntryLog.push({ event: 'construct', patches: this.options.patches })
  }
  async start() {}
  async close() {}
  session(id) { return new FakeSession(id || 'session-fake', this.options.cwd) }
  async resumeSession(id) { return new FakeSession(id, this.options.cwd) }
}
`

test('registry 将 adapterOptions.sdkEntry 传给 adapter（fake SDK 被加载）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-sdk-entry-'))
  ;(globalThis as unknown as { __cadreSdkEntryLog?: unknown[] }).__cadreSdkEntryLog = []
  try {
    const sdkEntry = join(root, 'fake-sdk.mjs')
    writeFileSync(sdkEntry, FAKE_SDK, 'utf8')
    const mcpServerPath = join(process.cwd(), 'src', 'mcp', 'server.ts')
    const registry = new SessionRuntimeRegistry({
      dshHomeBase: join(root, 'homes'),
      patchDirBase: join(root, 'patches'),
      mcpServerPath,
      adapterOptions: { sdkEntry },
    })
    await registry.start()
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    await registry.createSession({
      projectId: 'p1' as never,
      sessionId: 's1' as SessionId,
      role: 'worker',
      workingDirectory: work,
      databasePath: join(root, 'cadre.sqlite'),
    })
    const log = (globalThis as unknown as { __cadreSdkEntryLog?: unknown[] }).__cadreSdkEntryLog ?? []
    assert.equal(log.length, 1)
    await registry.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

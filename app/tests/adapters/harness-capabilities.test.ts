import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeEngine } from '../../src/adapters/engine/fake/index.ts'
import { HarnessAdapter } from '../../src/adapters/engine/harness/index.ts'
import type { EnginePort } from '../../src/ports/engine.ts'

function capabilitiesOf(engine: EnginePort) {
  return engine.capabilities()
}

test('HarnessAdapter 与 FakeEngine 能力位一致，compactionEvents=available（A1 v2 / 7770113）', () => {
  const fake = new FakeEngine()
  const harness = new HarnessAdapter({ dshHomeBase: 'D:\\tmp\\cadre-harness-capabilities-unused' })

  const fakeCaps = capabilitiesOf(fake)
  const harnessCaps = capabilitiesOf(harness)
  assert.deepEqual(harnessCaps, fakeCaps)
  assert.deepEqual(harnessCaps, {
    manualCompact: false,
    tokenUsage: false,
    mcpTools: true,
    compactionEvents: 'available',
    sessionEnumeration: false,
    crashRecovery: 'structured-error-only',
  })
})

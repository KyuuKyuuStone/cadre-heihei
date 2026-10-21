/**
 * M2 §2.3 · EnginePort 契约测试 shared suite（fake 与 harness 双实现共用同一套断言）。
 *
 * 断言口径与实测对齐（A1 v2 / S1-S5b / N15-N16）：
 * - 生命周期：start → createSession → send（至少 message.complete）→ close → stop；
 *   stop 后 start 必拒（ENGINE_UNAVAILABLE）——stop 后不自动恢复（N6/N15/N16）；
 * - workingDirectory set/get 往返；
 * - listSessions：产品台账摘要（EngineSessionSummary 形状），不依赖 SDK 枚举（N7）；
 * - resumeSession：台账内 ready 会话可恢复（同 sessionId/runtimeId）；缺失 →
 *   ENGINE_UNAVAILABLE 且 retryable=false（不臆造会话）；
 * - 能力位逐项 deepEqual（manualCompact=false、tokenUsage=false、mcpTools=true、
 *   compactionEvents='available'、sessionEnumeration=false、crashRecovery='structured-error-only'），
 *   且 compactionEvents 不得扩张（A1 v2：注入仅 user-role，system 不可）；
 * - 未启动/已停止：TRANSPORT_CLOSED 显式错误；错误为 EngineError 形状（code/retryable）；
 * - 双会话隔离：runtimeId 互异、事件 sessionId 各归各（无 crosstalk）。
 *
 * 适用范围：本套件只含双实现共有行为。fake 专有（脚本事件注入、abort 中断、
 * session.error/session.closed 注入、未映射错误投毒）留在 fake-engine.test.ts，
 * harness 侧不适用并在 M2 报告中列明（不静默跳过）。
 */
import assert from 'node:assert/strict'
import type { SessionId } from '../../src/collab/protocol/ids.ts'
import type { EngineError, EngineEvent, EnginePort } from '../../src/ports/engine.ts'

export interface PortContractFixture {
  /** 'fake' | 'harness' —— 断言 engineId 用。 */
  name: string
  /** 每个用例一个全新引擎实例（调用方保证凭据/目录就绪）。 */
  makeEngine(): EnginePort
  /** 会话工作目录：harness 需真实存在的目录；fake 允许虚拟路径。 */
  makeWorkDir(tag: string): string
  /** 仅 fake 实现：向会话注入事件脚本（用于双会话文本互异断言）；harness 不提供。 */
  setSessionScript?(engine: EnginePort, sessionId: SessionId, events: readonly unknown[]): void
}

export type ContractRegister = (name: string, fn: () => Promise<void> | void) => void

async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function isCode(code: string) {
  return (error: unknown): boolean => codeOf(error) === code
}

function assertEngineErrorShape(error: unknown): void {
  const e = error as EngineError
  assert.equal(typeof e.code, 'string')
  assert.equal(typeof e.retryable, 'boolean')
  assert.equal(typeof e.message, 'string')
}

const EXPECTED_CAPABILITIES = {
  manualCompact: false,
  tokenUsage: false,
  mcpTools: true,
  compactionEvents: 'available',
  sessionEnumeration: false,
  crashRecovery: 'structured-error-only',
} as const

export function runPortContractSuite(fixture: PortContractFixture, register: ContractRegister): void {
  const t = (name: string, body: (engine: EnginePort) => Promise<void>): void => {
    register(`${fixture.name}: ${name}`, async () => {
      const engine = fixture.makeEngine()
      try {
        await body(engine)
      } finally {
        // 幂等收尾：用例内部可能已 stop（t1/t6）；stop 后再 stop 两侧均为 no-op。
        try { await engine.stop() } catch { /* 已 stopped 或首次失败，保原始错误 */ }
      }
    })
  }

  t('lifecycle: start → createSession → send(message.complete) → close → stop；stop 后 start 拒绝（不自动恢复）', async (engine) => {
    assert.equal(engine.engineId, fixture.name)
    assert.equal((await engine.health()).state, 'unknown')

    await engine.start()
    assert.equal((await engine.health()).state, 'ready')

    const wd = fixture.makeWorkDir('life')
    const session = await engine.createSession({ workingDirectory: wd, title: 'contract' })
    assert.ok(session.sessionId.length > 0)
    assert.ok(session.runtimeId.length > 0)

    const events = await collect(session.send('契约探测：请用一句话回复 ok。'))
    assert.ok(events.length > 0, 'send 至少产出一个事件')
    assert.ok(events.some((event) => event.kind === 'message.complete'), '必须产出 message.complete')
    assert.ok(events.every((event) => event.sessionId === session.sessionId))
    assert.ok(events.every((event) => typeof event.at === 'string' && event.at.length > 0))

    const listed = (await engine.listSessions()).find((s) => s.sessionId === session.sessionId)
    assert.equal(listed?.state, 'ready')
    assert.equal(listed?.workingDirectory, wd)

    await session.close()
    assert.equal((await engine.listSessions()).find((s) => s.sessionId === session.sessionId)?.state, 'closed')

    await engine.stop()
    assert.equal((await engine.health()).state, 'stopped')
    assert.equal((await engine.listSessions()).find((s) => s.sessionId === session.sessionId)?.state, 'closed')
    // stop 后不自动恢复（N6/N15/N16）：重启由上层显式重建 adapter。
    await assert.rejects(engine.start(), (error: unknown) => {
      assert.equal(codeOf(error), 'ENGINE_UNAVAILABLE')
      assertEngineErrorShape(error)
      return true
    })
  })

  t('workingDirectory set/get 往返', async (engine) => {
    await engine.start()
    const one = fixture.makeWorkDir('wd-one')
    const two = fixture.makeWorkDir('wd-two')
    const session = await engine.createSession({ workingDirectory: one })
    assert.equal(await session.getWorkingDirectory(), one)
    await session.setWorkingDirectory(two)
    assert.equal(await session.getWorkingDirectory(), two)
    assert.equal((await engine.listSessions()).find((s) => s.sessionId === session.sessionId)?.workingDirectory, two)
  })

  t('listSessions：产品台账摘要（EngineSessionSummary 形状；不依赖 SDK 枚举）', async (engine) => {
    await engine.start()
    assert.deepEqual(await engine.listSessions(), [])
    const a = await engine.createSession({ workingDirectory: fixture.makeWorkDir('ls-a') })
    const b = await engine.createSession({ workingDirectory: fixture.makeWorkDir('ls-b') })
    const listed = await engine.listSessions()
    assert.equal(listed.length, 2)
    for (const s of listed) {
      assert.equal(typeof s.sessionId, 'string')
      assert.equal(typeof s.runtimeId, 'string')
      assert.equal(typeof s.workingDirectory, 'string')
      assert.ok(['starting', 'ready', 'closed', 'failed'].includes(s.state))
      assert.equal(typeof s.createdAt, 'string')
      assert.equal(typeof s.updatedAt, 'string')
    }
    const ids = new Set(listed.map((s) => s.sessionId))
    assert.ok(ids.has(a.sessionId) && ids.has(b.sessionId))
  })

  t('resumeSession：台账内 ready 会话可恢复；缺失 → ENGINE_UNAVAILABLE(retryable=false)', async (engine) => {
    await engine.start()
    await assert.rejects(
      engine.resumeSession('contract-missing' as SessionId),
      (error: unknown) => {
        assert.equal(codeOf(error), 'ENGINE_UNAVAILABLE')
        assertEngineErrorShape(error)
        assert.equal((error as EngineError).retryable, false)
        return true
      },
    )
    const session = await engine.createSession({ workingDirectory: fixture.makeWorkDir('resume') })
    const resumed = await engine.resumeSession(session.sessionId)
    assert.equal(resumed.sessionId, session.sessionId)
    assert.equal(resumed.runtimeId, session.runtimeId)
    const listed = (await engine.listSessions()).find((s) => s.sessionId === session.sessionId)
    assert.equal(listed?.state, 'ready')
  })

  t('能力位逐项与 A1/S1-S5b 实测一致；compactionEvents 不得扩张', async (engine) => {
    assert.deepEqual(engine.capabilities(), EXPECTED_CAPABILITIES)
    assert.equal(engine.capabilities().compactionEvents, 'available')
  })

  t('未启动/已停止：TRANSPORT_CLOSED 显式错误（EngineError 形状）', async (engine) => {
    // 未启动
    await assert.rejects(engine.createSession({ workingDirectory: fixture.makeWorkDir('t6') }), isCode('TRANSPORT_CLOSED'))
    await assert.rejects(engine.resumeSession('contract-x' as SessionId), isCode('TRANSPORT_CLOSED'))
    let caught: unknown
    try {
      await engine.createSession({ workingDirectory: fixture.makeWorkDir('t6') })
    } catch (error) {
      caught = error
    }
    assertEngineErrorShape(caught)

    // 已停止
    await engine.start()
    const session = await engine.createSession({ workingDirectory: fixture.makeWorkDir('t6') })
    await engine.stop()
    // send 的失败可能是同步抛（fake）或迭代期拒绝（harness）——统一以 async 函数包装断言。
    const drain = async (): Promise<void> => {
      for await (const _event of session.send('x')) { /* 抽干即抛 */ }
    }
    await assert.rejects(drain, isCode('TRANSPORT_CLOSED'))
    await assert.rejects(session.setWorkingDirectory(fixture.makeWorkDir('t6-other')), isCode('TRANSPORT_CLOSED'))
    await assert.rejects(engine.createSession({ workingDirectory: fixture.makeWorkDir('t6') }), isCode('TRANSPORT_CLOSED'))
    await assert.rejects(engine.resumeSession(session.sessionId), isCode('TRANSPORT_CLOSED'))
  })

  t('双会话隔离：runtimeId 互异、事件 sessionId 各归各、无 crosstalk', async (engine) => {
    await engine.start()
    const a = await engine.createSession({ workingDirectory: fixture.makeWorkDir('iso-a') })
    const b = await engine.createSession({ workingDirectory: fixture.makeWorkDir('iso-b') })
    assert.notEqual(a.sessionId, b.sessionId)
    assert.notEqual(a.runtimeId, b.runtimeId)

    if (fixture.setSessionScript !== undefined) {
      fixture.setSessionScript(engine, a.sessionId, [
        { kind: 'message.delta', text: 'ISO-A1' },
        { kind: 'message.complete', text: 'ISO-A2' },
      ])
      fixture.setSessionScript(engine, b.sessionId, [
        { kind: 'message.delta', text: 'ISO-B1' },
        { kind: 'message.complete', text: 'ISO-B2' },
      ])
    }

    const [eventsA, eventsB] = await Promise.all([
      collect(a.send('契约隔离探测 A：请只回复 A-ok。')),
      collect(b.send('契约隔离探测 B：请只回复 B-ok。')),
    ])
    assert.ok(eventsA.length > 0 && eventsB.length > 0)
    assert.ok(eventsA.every((event) => event.sessionId === a.sessionId))
    assert.ok(eventsB.every((event) => event.sessionId === b.sessionId))
    assert.ok(eventsA.some((event) => event.kind === 'message.complete'))
    assert.ok(eventsB.some((event) => event.kind === 'message.complete'))
    if (fixture.setSessionScript !== undefined) {
      // fake 专有增强：脚本文本互异（harness 侧不适用，不参与断言）。
      const textOf = (events: EngineEvent[]): string[] =>
        events.map((e) => (e.kind === 'message.delta' || e.kind === 'message.complete' ? e.text : e.kind))
      assert.deepEqual(textOf(eventsA), ['ISO-A1', 'ISO-A2'])
      assert.deepEqual(textOf(eventsB), ['ISO-B1', 'ISO-B2'])
    }
  })
}

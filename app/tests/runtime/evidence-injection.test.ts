/** 证据卡注入接线：假事件流 + 内存台账 + 临时卡片目录（不调真实模型）。 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from 'node:test'
import {
  InMemoryTaskLedger,
  PrototypeOnlySupervisorResolver,
  type LedgerActor,
} from '../../src/collab/ledger/index.ts'
import {
  EVIDENCE_SCHEMA_VERSION,
  RECOVERY_MARKER,
  cardPath,
  readInjectionRecords,
  sealCard,
  writeEvidenceCard,
  type EvidenceCard,
  type EvidenceInjector,
} from '../../src/collab/evidence/index.ts'
import type {
  EngineEvent,
  EngineSession,
  SendOptions,
} from '../../src/ports/engine.ts'
import type {
  IdempotencyKey,
  IsoTimestamp,
  ProjectId,
  SessionId,
  TaskId,
} from '../../src/collab/protocol/index.ts'
import {
  EvidenceInjectionRuntime,
  extractionCompactionId,
  wrapSessionWithEvidenceInjection,
  type EvidenceInjectionDiagnostic,
} from '../../src/runtime/evidence-injection.ts'
import { makeProject, sourceFor, type ProjectFixture } from '../evidence/helpers.ts'

const PROJECT = 'project-inject' as ProjectId
const EMP = 'session-emp' as SessionId
const OTHER = 'session-other' as SessionId
const SUP = 'session-sup' as SessionId
const TASK_A = 'task-inject-a' as TaskId
const TASK_B = 'task-inject-b' as TaskId
const AT = '2026-10-21T00:00:00.000Z' as IsoTimestamp
const API_LINE = "export const API_VERSION = 'cadre-heihei/1'"

const ASSIGNEE: LedgerActor = { kind: 'session', sessionId: EMP, role: 'assignee' }
const SYSTEM: LedgerActor = { kind: 'system', onBehalfOf: EMP }

let keySeq = 0

function makeLedger(): InMemoryTaskLedger {
  let tick = 0
  return new InMemoryTaskLedger({
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, 0, tick++)).toISOString() as IsoTimestamp,
    newId: () => `event-${++keySeq}`,
    // prototypeOnly：仅测试用静态单主管桩。
    supervisorResolver: new PrototypeOnlySupervisorResolver([
      { projectId: PROJECT, sessionId: SUP },
    ]),
  })
}

function createTask(
  ledger: InMemoryTaskLedger,
  taskId: TaskId,
  assigneeSessionId: SessionId = EMP,
): void {
  const created = ledger.createTask({
    projectId: PROJECT,
    taskId,
    title: `任务 ${taskId}`,
    body: '正文',
    dispatcherSessionId: SUP,
    assigneeSessionId,
    idempotencyKey: `k-${taskId}-${++keySeq}` as IdempotencyKey,
  })
  assert.equal(created.ok, true)
  const actor: LedgerActor = { kind: 'session', sessionId: assigneeSessionId, role: 'assignee' }
  for (const to of ['accepted', 'in_progress'] as const) {
    const current = ledger.getTask(PROJECT, taskId)
    assert.equal(current.ok, true)
    if (!current.ok) return
    const moved = ledger.transition({
      projectId: PROJECT,
      taskId,
      from: current.value.status,
      to,
      actor,
      idempotencyKey: `k-${taskId}-${to}-${++keySeq}` as IdempotencyKey,
    })
    assert.equal(moved.ok, true)
  }
}

function advanceToDelivered(ledger: InMemoryTaskLedger, taskId: TaskId): void {
  const current = ledger.getTask(PROJECT, taskId)
  assert.equal(current.ok, true)
  if (!current.ok) return
  const moved = ledger.transition({
    projectId: PROJECT,
    taskId,
    from: current.value.status,
    to: 'delivered',
    actor: SYSTEM,
    idempotencyKey: `k-${taskId}-delivered-${++keySeq}` as IdempotencyKey,
  })
  assert.equal(moved.ok, true)
}

function makeEvidence(project: ProjectFixture, taskId: TaskId, revision = 0): EvidenceCard {
  return sealCard({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId,
    revision,
    currentTask: `续作 ${taskId}`,
    nextStep: '核对证据卡后继续',
    createdAt: AT,
    updatedAt: AT,
    pointer: { file: 'src/api.ts' },
    items: [
      {
        id: 'api-version',
        kind: 'exact',
        item: 'API 版本',
        value: "'cadre-heihei/1'",
        exactText: API_LINE,
        source: sourceFor(project.root, 'src/api.ts', 1),
        status: 'ok',
      },
    ],
  })
}

function writeCard(project: ProjectFixture, card: EvidenceCard): void {
  // 测试夹具单写者：显式放弃租约（并发下会绕过 fencing）。
  writeEvidenceCard(project.root, card, { allowUnsafeNoLease: true })
}

function summaryEvent(
  compactionId: string,
  rawStyle: 'nested' | 'direct' | 'missing' = 'nested',
): EngineEvent {
  const raw =
    rawStyle === 'nested'
      ? { data: { compactionId } }
      : rawStyle === 'direct'
        ? { compactionId }
        : { data: {} }
  return { kind: 'compaction.summary', sessionId: EMP, at: AT, raw }
}

class FakeSession implements EngineSession {
  readonly sessionId: SessionId
  readonly runtimeId = 'runtime-fake'
  readonly prompts: string[] = []
  scripts: EngineEvent[][]

  constructor(sessionId: SessionId, scripts: EngineEvent[][] = []) {
    this.sessionId = sessionId
    this.scripts = [...scripts]
  }

  send(prompt: string, _options?: SendOptions): AsyncIterable<EngineEvent> {
    this.prompts.push(prompt)
    const events = this.scripts.shift() ?? []
    return (async function* () {
      for (const event of events) yield event
    })()
  }

  async setWorkingDirectory(): Promise<void> {}
  async getWorkingDirectory(): Promise<string> {
    return '/work'
  }
  async close(): Promise<void> {}
}

async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function setScripts(session: FakeSession, scripts: EngineEvent[][]): void {
  session.scripts = scripts
}

function findDiagnostic(
  diagnostics: readonly EvidenceInjectionDiagnostic[],
  stage: EvidenceInjectionDiagnostic['stage'],
  outcome: EvidenceInjectionDiagnostic['outcome'],
): EvidenceInjectionDiagnostic | undefined {
  return diagnostics.find((diagnostic) => diagnostic.stage === stage && diagnostic.outcome === outcome)
}

function prepare(options: {
  readonly withCard?: boolean
  readonly taskId?: TaskId
  readonly sessionId?: SessionId
  readonly assignee?: SessionId
} = {}) {
  const project = makeProject()
  project.write('src/api.ts', `${API_LINE}\n`)
  const ledger = makeLedger()
  const taskId = options.taskId ?? TASK_A
  const assignee = options.assignee ?? EMP
  createTask(ledger, taskId, assignee)
  if (options.withCard !== false) writeCard(project, makeEvidence(project, taskId))
  const diagnostics: EvidenceInjectionDiagnostic[] = []
  const session = new FakeSession(options.sessionId ?? EMP)
  return { project, ledger, taskId, diagnostics, session }
}

test('compaction.summary 触发一次注入：user-role 恢复块含 marker/taskId/compactionId/revision', async () => {
  const { project, ledger, taskId, diagnostics, session } = prepare()
  try {
    setScripts(session, [
      [
        { kind: 'message.complete', sessionId: EMP, at: AT, text: 'before' } as never,
        summaryEvent('comp-1'),
        { kind: 'message.complete', sessionId: EMP, at: AT, text: 'after' } as never,
      ],
    ])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const forwarded = await collect(wrapped.send('继续'))
    assert.equal(forwarded.length, 3)
    assert.equal(session.prompts.length, 2, '一次原消息 + 一次 user-role 恢复块')
    const block = session.prompts[1] as string
    assert.ok(block.startsWith(RECOVERY_MARKER))
    assert.ok(block.includes(`task: ${taskId}`))
    assert.ok(block.includes('compaction: comp-1'))
    assert.ok(block.includes('rev 0'))
    assert.ok(block.includes('rule: 不得凭记忆补写'))

    const injected = findDiagnostic(diagnostics, 'inject', 'injected')
    assert.ok(injected !== undefined)
    assert.equal(injected.role, 'user')
    assert.equal(injected.taskId, taskId)
    assert.equal(injected.compactionId, 'comp-1')
    assert.equal(injected.revision, 0)
    const delivered = findDiagnostic(diagnostics, 'delivery', 'delivered')
    assert.ok(delivered !== undefined)
    assert.equal(delivered.role, 'user')
  } finally {
    project.cleanup()
  }
})

test('同 compactionId 重复事件：injector duplicate，不二次注入', async () => {
  const { project, ledger, diagnostics, session } = prepare()
  try {
    setScripts(session, [[summaryEvent('comp-dup'), summaryEvent('comp-dup')]])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    assert.equal(session.prompts.length, 2)
    const duplicate = findDiagnostic(diagnostics, 'inject', 'duplicate')
    assert.ok(duplicate !== undefined)
    assert.equal(duplicate.reason, 'same-key-already-injected')
    assert.equal(readInjectionRecords(project.root).length, 1)
  } finally {
    project.cleanup()
  }
})

test('无卡：跳过并产生诊断，事件流继续', async () => {
  const { project, ledger, taskId, diagnostics, session } = prepare({ withCard: false })
  try {
    setScripts(session, [
      [summaryEvent('comp-nocard'), { kind: 'message.complete', sessionId: EMP, at: AT } as never],
    ])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const forwarded = await collect(wrapped.send('继续'))
    assert.equal(forwarded.length, 2)
    assert.equal(session.prompts.length, 1)
    const skipped = findDiagnostic(diagnostics, 'card-read', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'card-not-found')
    assert.equal(skipped.taskId, taskId)
    assert.equal(skipped.compactionId, 'comp-nocard')
  } finally {
    project.cleanup()
  }
})

test('卡 stale：跳过，不注入过期证据', async () => {
  const { project, ledger, diagnostics, session } = prepare()
  try {
    writeFileSync(`${project.root}/src/api.ts`, `${API_LINE} // changed`, 'utf8')
    setScripts(session, [[summaryEvent('comp-stale')]])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    assert.equal(session.prompts.length, 1)
    const skipped = findDiagnostic(diagnostics, 'card-validation', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'card-stale')
  } finally {
    project.cleanup()
  }
})

test('卡损坏：跳过并诊断，不注入', async () => {
  const { project, ledger, diagnostics, session } = prepare({ withCard: false })
  try {
    const path = cardPath(project.root, TASK_A)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{not-json', 'utf8')
    setScripts(session, [[summaryEvent('comp-corrupt')]])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    assert.equal(session.prompts.length, 1)
    const skipped = findDiagnostic(diagnostics, 'card-read', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'card-corrupt')
  } finally {
    project.cleanup()
  }
})

test('任务不存在 / 非 assignee 会话：跳过并诊断', async () => {
  const project = makeProject()
  project.write('src/api.ts', `${API_LINE}\n`)
  const emptyLedger = makeLedger()
  const diagnostics: EvidenceInjectionDiagnostic[] = []
  const session = new FakeSession(EMP)
  try {
    setScripts(session, [[summaryEvent('comp-none')]])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger: emptyLedger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    const skipped = findDiagnostic(diagnostics, 'task-lookup', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'no-active-task')
  } finally {
    project.cleanup()
  }

  const other = prepare({ taskId: TASK_A, assignee: OTHER, sessionId: EMP })
  try {
    setScripts(other.session, [[summaryEvent('comp-other')]])
    const wrapped = wrapSessionWithEvidenceInjection(other.session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: other.project.root,
      ledger: other.ledger,
      onDiagnostic: (diagnostic) => other.diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    const skipped = findDiagnostic(other.diagnostics, 'task-lookup', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'no-active-task')
  } finally {
    other.project.cleanup()
  }
})

test('卡 taskId 与当前任务不匹配：跳过', async () => {
  const { project, ledger, diagnostics, session } = prepare({ withCard: false })
  try {
    // 故意把 B 的卡放到 A 的路径，触发 card-task-mismatch。
    const path = cardPath(project.root, TASK_A)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(makeEvidence(project, TASK_B)), 'utf8')
    setScripts(session, [[summaryEvent('comp-mismatch')]])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    assert.equal(session.prompts.length, 1)
    const skipped = findDiagnostic(diagnostics, 'card-validation', 'skipped')
    assert.ok(skipped !== undefined)
    assert.equal(skipped.reason, 'card-task-mismatch')
  } finally {
    project.cleanup()
  }
})

test('injector 抛错：诊断 failed，事件流继续且不抛出', async () => {
  const { project, ledger, diagnostics, session } = prepare()
  try {
    setScripts(session, [
      [summaryEvent('comp-boom'), { kind: 'message.complete', sessionId: EMP, at: AT } as never],
    ])
    const failing = {
      inject: () => {
        throw new Error('injector write failed')
      },
    } as unknown as EvidenceInjector
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      injector: failing,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const forwarded = await collect(wrapped.send('继续'))
    assert.equal(forwarded.length, 2)
    assert.equal(session.prompts.length, 1)
    const failed = findDiagnostic(diagnostics, 'inject', 'failed')
    assert.ok(failed !== undefined)
    assert.equal(failed.reason, 'injector-error')
    assert.equal(failed.taskId, TASK_A)
    assert.equal(failed.compactionId, 'comp-boom')
  } finally {
    project.cleanup()
  }
})

test('发送失败：诊断 delivery-failed，主事件流不抛出', async () => {
  const { project, ledger, diagnostics, session } = prepare()
  try {
    setScripts(session, [
      [summaryEvent('comp-send-fail'), { kind: 'message.complete', sessionId: EMP, at: AT } as never],
    ])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      deliver: () => {
        throw new Error('user-role send failed')
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const forwarded = await collect(wrapped.send('继续'))
    assert.equal(forwarded.length, 2)
    const failed = findDiagnostic(diagnostics, 'delivery', 'failed')
    assert.ok(failed !== undefined)
    assert.equal(failed.reason, 'delivery-failed')
    assert.equal(failed.role, 'user')
  } finally {
    project.cleanup()
  }
})

test('多条在办任务：取 updatedAt 最新并记录策略', async () => {
  const project = makeProject()
  project.write('src/api.ts', `${API_LINE}\n`)
  const ledger = makeLedger()
  try {
    createTask(ledger, TASK_A)
    createTask(ledger, TASK_B)
    advanceToDelivered(ledger, TASK_B) // B 更新更晚，应被选中
    writeCard(project, makeEvidence(project, TASK_B))
    const diagnostics: EvidenceInjectionDiagnostic[] = []
    const session = new FakeSession(EMP)
    setScripts(session, [[summaryEvent('comp-multi')]])
    const runtime = new EvidenceInjectionRuntime({
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(runtime.wrap(session).send('继续'))
    const injected = findDiagnostic(diagnostics, 'inject', 'injected')
    assert.ok(injected !== undefined)
    assert.equal(injected.taskId, TASK_B)
    assert.equal(injected.detail?.candidateCount, 2)
    assert.equal(injected.detail?.strategy, 'latest-updatedAt-then-seq')
    assert.equal(readInjectionRecords(project.root)[0]?.taskId, TASK_B)
  } finally {
    project.cleanup()
  }
})

test('缺 compactionId / 直接 raw.compactionId 形态', async () => {
  const { project, ledger, diagnostics, session } = prepare()
  try {
    setScripts(session, [
      [summaryEvent('', 'missing'), summaryEvent('comp-direct', 'direct')],
    ])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await collect(wrapped.send('继续'))
    const missing = findDiagnostic(diagnostics, 'event', 'skipped')
    assert.ok(missing !== undefined)
    assert.equal(missing.reason, 'missing-compaction-id')
    const injected = findDiagnostic(diagnostics, 'inject', 'injected')
    assert.ok(injected !== undefined)
    assert.equal(injected.compactionId, 'comp-direct')
    assert.equal(extractionCompactionId({ data: { compactionId: 'x' } }), 'x')
    assert.equal(extractionCompactionId({ compactionId: 'y' }), 'y')
    assert.equal(extractionCompactionId({}), undefined)
  } finally {
    project.cleanup()
  }
})

test('包装会话不改变事件流且委托其它方法', async () => {
  const { project, ledger, session } = prepare({ withCard: false })
  try {
    const events = [
      { kind: 'message.complete', sessionId: EMP, at: AT } as never,
      { kind: 'compaction.end', sessionId: EMP, at: AT, raw: {} } as never,
    ]
    setScripts(session, [events])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
    })
    assert.equal(wrapped.sessionId, session.sessionId)
    assert.equal(wrapped.runtimeId, session.runtimeId)
    assert.equal(await wrapped.getWorkingDirectory(), '/work')
    assert.deepEqual(await collect(wrapped.send('继续')), events)
  } finally {
    project.cleanup()
  }
})

test('onDiagnostic 抛错不打断事件流', async () => {
  const { project, ledger, session } = prepare({ withCard: false })
  try {
    setScripts(session, [
      [summaryEvent('comp-logger'), { kind: 'message.complete', sessionId: EMP, at: AT } as never],
    ])
    const wrapped = wrapSessionWithEvidenceInjection(session, {
      sessionId: EMP,
      projectId: PROJECT,
      projectRoot: project.root,
      ledger,
      onDiagnostic: () => {
        throw new Error('logger failed')
      },
    })
    const forwarded = await collect(wrapped.send('继续'))
    assert.equal(forwarded.length, 2)
  } finally {
    project.cleanup()
  }
})

/** 恢复块字段、user-role、预算与 (taskId, compactionId, revision) 幂等。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskId } from '../../src/collab/protocol/index.ts'
import {
  DEFAULT_MAX_TOKENS,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceError,
  EvidenceInjector,
  RECOVERY_MARKER,
  buildRecoveryBlock,
  injectionKey,
  readInjectionRecords,
  sealCard,
  type EvidenceItem,
} from '../../src/collab/evidence/index.ts'
import { AT, TASK_ID, makeProject, sourceFor } from './helpers.ts'

function items(projectRoot: string): EvidenceItem[] {
  return [
    {
      id: 'version',
      kind: 'exact',
      item: 'API 版本',
      value: "'cadre-heihei/1'",
      exactText: "export const API_VERSION = 'cadre-heihei/1'",
      source: sourceFor(projectRoot, 'src/api.ts', 1),
      status: 'ok',
    },
    {
      id: 'tests',
      kind: 'exact',
      item: '测试命令',
      value: 'npm test',
      source: { command: 'npm test', cwd: 'D:/proj', exitCode: 0 },
      status: 'ok',
    },
    {
      id: 'rule',
      kind: 'semantic',
      item: '约束',
      value: '不得改协议字段',
      source: { file: 'docs/spec.md', line: 3 },
      status: 'ok',
    },
    {
      id: 'pending',
      kind: 'semantic',
      item: '真机验证',
      value: '尚未验证',
      status: 'unverified',
      neededEvidence: '真机运行日志',
    },
  ]
}

function card(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return sealCard({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId: TASK_ID,
    revision: 0,
    currentTask: '实现证据卡核心',
    nextStep: '跑通注入器',
    createdAt: AT,
    updatedAt: AT,
    items: items(projectRoot),
    pointer: { file: 'docs/spec.md', selector: '§1' },
    ...overrides,
  })
}

function projectWithSources() {
  const project = makeProject()
  project.write('src/api.ts', "export const API_VERSION = 'cadre-heihei/1'\n")
  project.write('docs/spec.md', '# 规范\n\n不改协议字段。\n')
  return project
}

test('恢复块：必需字段、命令/数字/未验证项、字节与 token 量级', () => {
  const project = projectWithSources()
  try {
    const evidence = card(project.root)
    const block = buildRecoveryBlock(evidence, { compactionId: 'comp-1' })
    assert.ok(block.text.startsWith(RECOVERY_MARKER))
    for (const fragment of [
      `task: ${TASK_ID}`,
      'rev 0',
      'compaction: comp-1',
      'current: 实现证据卡核心',
      'next: 跑通注入器',
      'files: 2 referenced',
      "numbers: 'cadre-heihei/1' @ src/api.ts:1",
      'commands: npm test -> 0',
      'unverified: 真机验证 (need: 真机运行日志)',
      'full: docs/spec.md',
      'rule: 不得凭记忆补写',
    ]) {
      assert.ok(block.text.includes(fragment), `缺少片段：${fragment}\n${block.text}`)
    }
    assert.equal(block.bytes, Buffer.byteLength(block.text, 'utf8'))
    assert.equal(block.estimatedTokens, Math.ceil(block.bytes / 4))
    assert.ok(block.estimatedTokens <= DEFAULT_MAX_TOKENS)
  } finally {
    project.cleanup()
  }
})

test('注入器：记录 user-role，不出现 system 注入', () => {
  const project = projectWithSources()
  try {
    const injector = new EvidenceInjector({ projectRoot: project.root, now: () => AT })
    const outcome = injector.inject(card(project.root), { compactionId: 'comp-1', sessionId: 's-1' })
    assert.equal(outcome.status, 'injected')
    if (outcome.status !== 'injected') return
    assert.ok(outcome.text.startsWith(RECOVERY_MARKER))
    const records = readInjectionRecords(project.root)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.role, 'user')
    assert.equal(records[0]?.compactionId, 'comp-1')
    assert.equal(records[0]?.revision, 0)
    assert.ok((records[0]?.bytes ?? 0) > 0)
    assert.equal(records[0]?.estimatedTokens, Math.ceil((records[0]?.bytes ?? 0) / 4))
    assert.equal('system' in (records[0] as unknown as Record<string, unknown>), false)
  } finally {
    project.cleanup()
  }
})

test('幂等：同键重放跳过；异 revision/事件/任务放行', () => {
  const project = projectWithSources()
  try {
    const injector = new EvidenceInjector({ projectRoot: project.root, now: () => AT })
    const base = card(project.root)
    const first = injector.inject(base, { compactionId: 'comp-1' })
    assert.equal(first.status, 'injected')
    const replay = injector.inject(base, { compactionId: 'comp-1' })
    assert.equal(replay.status, 'duplicate')
    if (replay.status === 'duplicate') {
      assert.equal(replay.key, injectionKey(TASK_ID, 'comp-1', 0))
    }
    assert.equal(readInjectionRecords(project.root).length, 1)

    const revision = card(project.root, { revision: 1 })
    assert.equal(injector.inject(revision, { compactionId: 'comp-1' }).status, 'injected')

    const event = injector.inject(base, { compactionId: 'comp-2' })
    assert.equal(event.status, 'injected')

    const otherTask = card(project.root, { taskId: 'task-2' as TaskId })
    assert.equal(injector.inject(otherTask, { compactionId: 'comp-1' }).status, 'injected')

    assert.equal(readInjectionRecords(project.root).length, 4)
  } finally {
    project.cleanup()
  }
})

test('预算：超长内容被裁剪且标记 truncated，保留最小必需字段', () => {
  const project = projectWithSources()
  try {
    const long = 'x'.repeat(20_000)
    const evidence = card(project.root, {
      currentTask: long,
      nextStep: long,
      items: [
        ...items(project.root),
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `extra-${index}`,
          kind: 'semantic' as const,
          item: `结论 ${index}`,
          value: long,
          source: { file: 'docs/spec.md' },
          status: 'ok' as const,
        })),
      ],
    })
    const block = buildRecoveryBlock(evidence, { compactionId: 'comp-big' })
    assert.equal(block.truncated, true)
    assert.ok(block.estimatedTokens <= DEFAULT_MAX_TOKENS)
    for (const fragment of [RECOVERY_MARKER, 'task:', 'current:', 'next:', 'full:', 'rule:']) {
      assert.ok(block.text.includes(fragment), `裁剪后仍须保留：${fragment}`)
    }
  } finally {
    project.cleanup()
  }
})

test('compactionId 为空 → INVALID_CARD', () => {
  const project = projectWithSources()
  try {
    assert.throws(
      () => buildRecoveryBlock(card(project.root), { compactionId: '  ' }),
      (error: unknown) => error instanceof EvidenceError && error.code === 'INVALID_CARD',
    )
  } finally {
    project.cleanup()
  }
})

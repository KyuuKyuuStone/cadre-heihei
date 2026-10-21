/** 证据卡结构、完整性、精确串、伪造项、stale 与指针校验。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EvidenceError,
  acquireLease,
  computeIntegrity,
  deleteEvidenceCard,
  fingerprintFile,
  readEvidenceCard,
  sealCard,
  validateEvidenceCard,
  verifyCardIntegrity,
  writeEvidenceCard,
  type EvidenceItem,
} from '../../src/collab/evidence/index.ts'
import { TASK_ID, cardInput, makeCard, makeProject, nextRevision, sourceFor } from './helpers.ts'

const API_LINE = "export const API_VERSION = 'cadre-heihei/1'"

function exactItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: 'api-version',
    kind: 'exact',
    item: 'API 版本',
    value: "'cadre-heihei/1'",
    exactText: API_LINE,
    status: 'ok',
    ...overrides,
  }
}

function baseProject() {
  const project = makeProject()
  project.write('src/api.ts', `${API_LINE}\nexport const other = 1\n`)
  project.write('docs/spec.md', '# 规范\n\n不改协议字段。\n')
  return project
}

test('卡片 CRUD：seal/verify/write/read/update/delete', () => {
  const project = baseProject()
  try {
    const card = makeCard({
      items: [exactItem({ source: sourceFor(project.root, 'src/api.ts', 1) })],
    })
    assert.equal(verifyCardIntegrity(card), true)
    const acquired = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'crud-writer',
      sessionId: 'session-crud',
      ttlMs: 300_000,
    })
    if (!acquired.ok) assert.fail('租约获取失败')
    const lease = { ownerInstanceId: 'crud-writer', fencingToken: acquired.lease.fencingToken }
    writeEvidenceCard(project.root, card, { lease })
    const read = readEvidenceCard(project.root, TASK_ID)
    assert.equal(read.revision, 0)
    assert.equal(read.items.length, 1)
    assert.deepEqual(read.integrity, card.integrity)

    const updated = nextRevision(read, {
      items: [...read.items, { id: 'note', kind: 'semantic', item: '约束', value: '不改协议字段', status: 'unverified', neededEvidence: '协议评审记录' }],
    })
    writeEvidenceCard(project.root, updated, { lease })
    assert.equal(readEvidenceCard(project.root, TASK_ID).revision, 1)

    assert.equal(deleteEvidenceCard(project.root, TASK_ID), true)
    assert.equal(deleteEvidenceCard(project.root, TASK_ID), false)
    assert.throws(() => readEvidenceCard(project.root, TASK_ID), (error: unknown) =>
      error instanceof EvidenceError && error.code === 'CARD_NOT_FOUND')
  } finally {
    project.cleanup()
  }
})

test('完整性：篡改字段后 integrity 重算失败，写入被拒', () => {
  const project = baseProject()
  try {
    const card = makeCard({ items: [exactItem({ source: sourceFor(project.root, 'src/api.ts', 1) })] })
    const tampered = { ...card, currentTask: '被篡改' }
    assert.equal(verifyCardIntegrity(tampered), false)
    assert.notDeepEqual(computeIntegrity(tampered), card.integrity)
    assert.throws(() => writeEvidenceCard(project.root, tampered), (error: unknown) =>
      error instanceof EvidenceError && error.code === 'INTEGRITY_MISMATCH')
  } finally {
    project.cleanup()
  }
})

test('校验器：合法卡片全绿；语义项带 source / unverified 带所需证据', () => {
  const project = baseProject()
  try {
    const card = makeCard({
      items: [
        exactItem({ source: sourceFor(project.root, 'src/api.ts', 1) }),
        {
          id: 'constraint',
          kind: 'semantic',
          item: '协议约束',
          value: '不得改协议字段',
          source: { file: 'docs/spec.md', line: 3 },
          status: 'ok',
        },
        {
          id: 'command',
          kind: 'exact',
          item: '测试命令',
          value: 'npm test',
          exactText: 'npm test',
          source: { command: 'npm test', exitCode: 0 },
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
      ],
      pointer: { file: 'docs/spec.md', selector: '§1' },
    })
    const report = validateEvidenceCard(card, { projectRoot: project.root })
    assert.equal(report.ok, true)
    assert.equal(report.integrityOk, true)
    assert.equal(report.checkedItems, 4)
    assert.deepEqual(report.issues, [])

    const badCommand = makeCard({
      items: [
        {
          id: 'command',
          kind: 'exact',
          item: '测试命令',
          value: 'npm test',
          exactText: 'npm run test',
          source: { command: 'npm test', exitCode: 0 },
          status: 'ok',
        },
      ],
    })
    const badReport = validateEvidenceCard(badCommand, { projectRoot: project.root })
    assert.equal(badReport.ok, false)
    assert.ok(badReport.issues.some((issue) => issue.code === 'EXACT_TEXT_MISMATCH'))
  } finally {
    project.cleanup()
  }
})

test('阳性对照：伪造 file:line / 错误 exactText 必判红', () => {
  const project = baseProject()
  try {
    const fakeLine = makeCard({
      items: [exactItem({ source: { file: 'src/api.ts', line: 999 } })],
    })
    const fakeReport = validateEvidenceCard(fakeLine, { projectRoot: project.root })
    assert.equal(fakeReport.ok, false)
    assert.ok(fakeReport.issues.some((issue) => issue.code === 'EXACT_TEXT_MISMATCH'))

    const fakeText = makeCard({
      items: [exactItem({ exactText: '这段原文不存在', source: sourceFor(project.root, 'src/api.ts', 1) })],
    })
    const textReport = validateEvidenceCard(fakeText, { projectRoot: project.root })
    assert.equal(textReport.ok, false)
    assert.ok(textReport.issues.some((issue) => issue.code === 'EXACT_TEXT_MISMATCH'))

    const fakeFile = makeCard({
      items: [exactItem({ source: { file: 'src/nope.ts', line: 1 } })],
    })
    const fileReport = validateEvidenceCard(fakeFile, { projectRoot: project.root })
    assert.equal(fileReport.ok, false)
    assert.ok(fileReport.issues.some((issue) => issue.code === 'SOURCE_NOT_FOUND'))
  } finally {
    project.cleanup()
  }
})

test('stale 检测：文件内容/哈希变化 → 条目标 stale，续作前必须刷新', () => {
  const project = baseProject()
  try {
    const source = sourceFor(project.root, 'src/api.ts', 1)
    const card = makeCard({ items: [exactItem({ source })] })
    assert.equal(validateEvidenceCard(card, { projectRoot: project.root }).ok, true)

    writeFileSync(join(project.root, 'src/api.ts'), `${API_LINE} // changed\n`, 'utf8')
    const report = validateEvidenceCard(card, { projectRoot: project.root })
    assert.equal(report.ok, false)
    assert.ok(report.staleItemIds.includes('api-version'))
    assert.ok(report.issues.some((issue) => issue.code === 'STALE'))
    assert.notEqual(fingerprintFile(project.root, 'src/api.ts').sha256, source.fileSha256)
  } finally {
    project.cleanup()
  }
})

test('stale 检测：仅 mtime 不一致也标 stale', () => {
  const project = baseProject()
  try {
    const source = sourceFor(project.root, 'src/api.ts', 1)
    const card = makeCard({
      items: [exactItem({ source: { ...source, fileMtimeMs: (source.fileMtimeMs ?? 0) - 5000 } })],
    })
    const report = validateEvidenceCard(card, { projectRoot: project.root })
    assert.equal(report.ok, false)
    assert.ok(report.staleItemIds.includes('api-version'))
  } finally {
    project.cleanup()
  }
})

test('unverified 缺 neededEvidence、pointer 不可寻址、敏感串均判红', () => {
  const project = baseProject()
  try {
    const missingEvidence = makeCard({
      items: [
        {
          id: 'pending',
          kind: 'semantic',
          item: '待验证',
          value: '未知',
          status: 'unverified',
        },
      ],
    })
    const first = validateEvidenceCard(missingEvidence, { projectRoot: project.root })
    assert.equal(first.ok, false)
    assert.ok(first.issues.some((issue) => issue.code === 'UNVERIFIED_MISSING_EVIDENCE'))

    const badPointer = makeCard({ pointer: { file: 'missing/card.json' } })
    const second = validateEvidenceCard(badPointer, { projectRoot: project.root })
    assert.equal(second.ok, false)
    assert.ok(second.issues.some((issue) => issue.code === 'POINTER_UNRESOLVABLE'))

    const secret = makeCard({
      items: [exactItem({ value: 'sk-abcdefghijklmnopqrstuvwx', exactText: API_LINE, source: sourceFor(project.root, 'src/api.ts', 1) })],
    })
    const third = validateEvidenceCard(secret, { projectRoot: project.root })
    assert.equal(third.ok, false)
    assert.ok(third.issues.some((issue) => issue.code === 'SENSITIVE_CONTENT'))
  } finally {
    project.cleanup()
  }
})

test('路径安全：source.file 越界 → UNSAFE_PATH', () => {
  const project = baseProject()
  try {
    const card = makeCard({
      items: [exactItem({ source: { file: '../outside.ts', line: 1 } })],
    })
    const report = validateEvidenceCard(card, { projectRoot: project.root })
    assert.equal(report.ok, false)
    assert.ok(report.issues.some((issue) => issue.code === 'UNSAFE_PATH'))
  } finally {
    project.cleanup()
  }
})

test('schema：revision/时间戳/currentTask 校验', () => {
  const project = baseProject()
  try {
    const card = sealCard({
      ...cardInput({ revision: -1, currentTask: '', updatedAt: 'not-a-date' as never }),
    })
    const report = validateEvidenceCard(card, { projectRoot: project.root })
    assert.equal(report.ok, false)
    const codes = report.issues.map((issue) => issue.code)
    assert.ok(codes.includes('SCHEMA'))
  } finally {
    project.cleanup()
  }
})

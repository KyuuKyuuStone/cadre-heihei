/** 原子写失败注入、revision 单调、租约竞争/过期抢占/fencing。 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  EvidenceError,
  acquireLease,
  assertLeaseValid,
  cardPath,
  readEvidenceCard,
  readLease,
  releaseLease,
  writeEvidenceCard,
} from '../../src/collab/evidence/index.ts'
import { TASK_ID, makeCard, makeProject, nextRevision } from './helpers.ts'

const SESSION = 'session-evidence'

function isCode(code: string) {
  return (error: unknown) => error instanceof EvidenceError && error.code === code
}

test('原子写：临时文件 + rename；rename 失败不留半成品且旧卡不变', () => {
  const project = makeProject()
  try {
    const first = makeCard()
    writeEvidenceCard(project.root, first)
    const second = nextRevision(first)

    assert.throws(
      () =>
        writeEvidenceCard(project.root, second, {
          renameFile: () => {
            throw new Error('simulated rename failure')
          },
        }),
      isCode('WRITE_FAILED'),
    )
    assert.equal(readEvidenceCard(project.root, TASK_ID).revision, 0)
    const dir = join(project.root, '.cadre', 'evidence', 'tasks', TASK_ID)
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  } finally {
    project.cleanup()
  }
})

test('原子写：首次写入失败时不产生 card.json', () => {
  const project = makeProject()
  try {
    assert.throws(
      () =>
        writeEvidenceCard(project.root, makeCard(), {
          renameFile: () => {
            throw new Error('simulated rename failure')
          },
        }),
      isCode('WRITE_FAILED'),
    )
    assert.equal(existsSync(cardPath(project.root, TASK_ID)), false)
  } finally {
    project.cleanup()
  }
})

test('revision 必须严格递增', () => {
  const project = makeProject()
  try {
    const first = makeCard()
    writeEvidenceCard(project.root, first)
    assert.throws(() => writeEvidenceCard(project.root, first), isCode('REVISION_CONFLICT'))
    const next = nextRevision(first)
    writeEvidenceCard(project.root, next)
    assert.equal(readEvidenceCard(project.root, TASK_ID).revision, 1)
  } finally {
    project.cleanup()
  }
})

test('租约：并发两写者只有一人拿到，续租保持 token', () => {
  const project = makeProject()
  try {
    let now = 10_000
    const a = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-a',
      sessionId: SESSION,
      ttlMs: 30_000,
      nowMs: () => now,
    })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.lease.fencingToken, 1)
    assert.equal(a.status, 'acquired')

    const b = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-b',
      sessionId: SESSION,
      ttlMs: 30_000,
      nowMs: () => now,
    })
    assert.equal(b.ok, false)
    if (!b.ok) assert.equal(b.code, 'LEASE_HELD')

    now = 15_000
    const renewed = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-a',
      sessionId: SESSION,
      ttlMs: 30_000,
      nowMs: () => now,
    })
    assert.equal(renewed.ok, true)
    if (renewed.ok) {
      assert.equal(renewed.status, 'renewed')
      assert.equal(renewed.lease.fencingToken, 1)
      assert.equal(Date.parse(renewed.lease.expiresAt), now + 30_000)
    }
  } finally {
    project.cleanup()
  }
})

test('租约：过期可抢占，fencing token +1；旧写者写入被拒', () => {
  const project = makeProject()
  try {
    let now = 10_000
    const a = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-a',
      sessionId: SESSION,
      ttlMs: 1_000,
      nowMs: () => now,
    })
    assert.equal(a.ok, true)
    if (!a.ok) return

    now = 12_000
    const b = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-b',
      sessionId: SESSION,
      ttlMs: 5_000,
      nowMs: () => now,
    })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.status, 'takeover')
    assert.equal(b.lease.fencingToken, a.lease.fencingToken + 1)

    const card = makeCard()
    assert.throws(
      () =>
        writeEvidenceCard(project.root, card, {
          lease: { ownerInstanceId: 'writer-a', fencingToken: a.lease.fencingToken },
          nowMs: () => now,
        }),
      isCode('FENCING_REJECTED'),
    )
    writeEvidenceCard(project.root, card, {
      lease: { ownerInstanceId: 'writer-b', fencingToken: b.lease.fencingToken },
      nowMs: () => now,
    })
    assert.equal(readEvidenceCard(project.root, TASK_ID).revision, 0)

    assert.equal(releaseLease(project.root, TASK_ID, 'writer-a', a.lease.fencingToken), false)
    assert.equal(releaseLease(project.root, TASK_ID, 'writer-b', b.lease.fencingToken), true)
    assert.equal(readLease(project.root, TASK_ID), undefined)
  } finally {
    project.cleanup()
  }
})

test('租约：过期后未抢占的写者也必须被拒', () => {
  const project = makeProject()
  try {
    const a = acquireLease(project.root, TASK_ID, {
      ownerInstanceId: 'writer-a',
      sessionId: SESSION,
      ttlMs: 1_000,
      nowMs: () => 10_000,
    })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.throws(
      () =>
        writeEvidenceCard(project.root, makeCard(), {
          lease: { ownerInstanceId: 'writer-a', fencingToken: a.lease.fencingToken },
          nowMs: () => 20_000,
        }),
      isCode('LEASE_EXPIRED'),
    )
    assert.throws(
      () => assertLeaseValid(project.root, 'no-lock-task', {
        ownerInstanceId: 'writer-a',
        fencingToken: 1,
      }),
      isCode('LEASE_REQUIRED'),
    )
  } finally {
    project.cleanup()
  }
})

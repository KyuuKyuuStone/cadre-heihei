/** 身份加载优先级与台账成员校验（M4 §8.1）。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadIdentity,
  loadIdentityFromEnv,
  validateIdentityAgainstMembers,
} from '../../src/main/identity-config.ts'

function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'cadre-identity-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

test('env 完整时优先于 identity.json', () => {
  const dir = tempDir()
  try {
    const file = join(dir.path, 'identity.json')
    writeFileSync(file, JSON.stringify({ projectId: 'file-p', sessionId: 'file-s', role: 'worker' }))
    const loaded = loadIdentity(
      { CADRE_PROJECT_ID: 'env-p', CADRE_SESSION_ID: 'env-s', CADRE_ROLE: 'supervisor' },
      file,
    )
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      assert.deepEqual(
        { p: loaded.identity.projectId, s: loaded.identity.sessionId, r: loaded.identity.role },
        { p: 'env-p', s: 'env-s', r: 'supervisor' },
      )
      assert.equal(loaded.identity.source, 'env')
    }
  } finally {
    dir.cleanup()
  }
})

test('env 缺失时读取 identity.json', () => {
  const dir = tempDir()
  try {
    const file = join(dir.path, 'identity.json')
    writeFileSync(file, JSON.stringify({ projectId: 'p1', sessionId: 's1', role: 'worker' }))
    const loaded = loadIdentity({}, file)
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      assert.equal(loaded.identity.projectId, 'p1')
      assert.equal(loaded.identity.role, 'worker')
      assert.equal(loaded.identity.source, 'file')
    }
  } finally {
    dir.cleanup()
  }
})

test('两者都缺失 → missing；禁止匿名缺省', () => {
  const dir = tempDir()
  try {
    const loaded = loadIdentity({}, join(dir.path, 'absent.json'))
    assert.equal(loaded.ok, false)
    if (!loaded.ok) assert.equal(loaded.reason, 'missing')
  } finally {
    dir.cleanup()
  }
})

test('env 部分配置 → invalid-env，不回落文件', () => {
  const dir = tempDir()
  try {
    const file = join(dir.path, 'identity.json')
    writeFileSync(file, JSON.stringify({ projectId: 'p', sessionId: 's', role: 'worker' }))
    const loaded = loadIdentity({ CADRE_PROJECT_ID: 'only-project' }, file)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) assert.equal(loaded.reason, 'invalid-env')
    assert.equal(loadIdentityFromEnv({})?.ok, undefined)
  } finally {
    dir.cleanup()
  }
})

test('identity.json 非法/角色错 → invalid-file', () => {
  const dir = tempDir()
  try {
    const file = join(dir.path, 'identity.json')
    writeFileSync(file, '{not-json')
    const broken = loadIdentity({}, file)
    assert.equal(broken.ok, false)
    if (!broken.ok) assert.equal(broken.reason, 'invalid-file')

    writeFileSync(file, JSON.stringify({ projectId: 'p', sessionId: 's', role: 'admin' }))
    const badRole = loadIdentity({}, file)
    assert.equal(badRole.ok, false)
    if (!badRole.ok) assert.equal(badRole.reason, 'invalid-file')
  } finally {
    dir.cleanup()
  }
})

test('成员校验：存在且角色一致才通过', () => {
  const members = [
    { projectId: 'p', sessionId: 's', role: 'worker', state: 'available' },
  ] as never
  assert.deepEqual(
    validateIdentityAgainstMembers({ projectId: 'p', sessionId: 's', role: 'worker' } as never, members),
    { ok: true },
  )
  assert.deepEqual(
    validateIdentityAgainstMembers({ projectId: 'p', sessionId: 's', role: 'supervisor' } as never, members),
    { ok: false, reason: 'role-mismatch' },
  )
  assert.deepEqual(
    validateIdentityAgainstMembers({ projectId: 'p', sessionId: 'other', role: 'worker' } as never, members),
    { ok: false, reason: 'not-member' },
  )
})

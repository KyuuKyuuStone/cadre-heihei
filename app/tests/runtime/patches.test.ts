import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RuntimeRegistryError } from '../../src/runtime/errors.ts'
import {
  archiveSessionPatches,
  buildIdentityPatch,
  buildSupervisorPatch,
  writeSessionPatches,
} from '../../src/runtime/patches.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cadre-patches-'))
}

test('identity patch: insert semantics, args/env/db/server fields', () => {
  const root = tempRoot()
  try {
    const serverPath = join(root, 'server.ts')
    writeFileSync(serverPath, '// dummy\n', 'utf8')
    const databasePath = join(root, 'db', 'cadre.sqlite')
    const content = buildIdentityPatch({
      sessionId: 'session-a',
      projectId: 'project-a',
      databasePath,
      serverPath,
    })
    assert.match(content, /^- insert:$/m)
    assert.match(content, /@deepseek-ai\/dsh-mcp-client/)
    assert.match(content, /serverName: cadre/)
    assert.match(content, /command: "node"/)
    assert.match(content, /--session-id/)
    assert.match(content, /--project-id/)
    assert.match(content, /--database-path/)
    assert.match(content, /CADRE_SESSION_ID/)
    assert.match(content, /CADRE_PROJECT_ID/)
    assert.match(content, /CADRE_DB_PATH/)
    assert.match(content, /enabled: false/)
    assert.match(content, /failOnStartupError: true/)
    assert.ok(content.includes('session-a'))
    assert.ok(content.includes('project-a'))
    assert.ok(content.includes(JSON.stringify(databasePath)))
    assert.ok(content.includes(JSON.stringify(serverPath)))
    assert.equal(content.includes('\n- id: '), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('supervisor patch: overrides only, exact disabled rows, no insert', () => {
  const content = buildSupervisorPatch({ sessionId: 'session-sup', projectId: 'project-sup' })
  assert.match(content, /^# sessionId: session-sup$/m)
  assert.match(content, /^- id: tool-fs$/m)
  assert.match(content, /write: false/)
  assert.match(content, /edit: false/)
  for (const row of [
    'tool-pwsh',
    'tool-bash',
    'tool-jobs',
    'tool-subagent',
    'tool-subagent-fork',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-workflow',
    'ptc-runtime',
    'workflow-ptc',
  ]) {
    assert.match(content, new RegExp(`^- id: ${row}\\n  disabled: true$`, 'm'))
  }
  assert.equal(content.includes('- insert:'), false)
})

test('writeSessionPatches: per-runtime paths, content carries sessionId, supervisor gets two files', () => {
  const root = tempRoot()
  try {
    const serverPath = join(root, 'server.ts')
    writeFileSync(serverPath, '// dummy\n', 'utf8')
    const common = {
      patchDirBase: join(root, 'patches'),
      projectId: 'project-a',
      databasePath: join(root, 'db', 'cadre.sqlite'),
      serverPath,
    }
    const worker = writeSessionPatches({ ...common, runtimeId: 'runtime-worker', role: 'worker', sessionId: 'session-worker' })
    const supervisor = writeSessionPatches({ ...common, runtimeId: 'runtime-supervisor', role: 'supervisor', sessionId: 'session-supervisor' })
    assert.equal(worker.patchPaths.length, 1)
    assert.equal(supervisor.patchPaths.length, 2)
    assert.notEqual(worker.identityPath, supervisor.identityPath)
    assert.match(worker.identityPath, /runtime-worker/)
    assert.match(supervisor.supervisorPath ?? '', /runtime-supervisor/)
    assert.ok(readFileSync(worker.identityPath, 'utf8').includes('session-worker'))
    assert.ok(readFileSync(supervisor.identityPath, 'utf8').includes('session-supervisor'))
    assert.ok(readFileSync(supervisor.supervisorPath ?? '', 'utf8').includes('session-supervisor'))
    assert.equal(existsSync(join(root, 'patches', 'runtime-worker', 'identity.cordis.yml')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('patch generation fails closed for missing identity/db/server', () => {
  const root = tempRoot()
  try {
    const serverPath = join(root, 'server.ts')
    writeFileSync(serverPath, '// dummy\n', 'utf8')
    assert.throws(
      () => buildIdentityPatch({ sessionId: '', projectId: 'p', databasePath: 'd', serverPath }),
      (error: unknown) => error instanceof RuntimeRegistryError,
    )
    assert.throws(
      () => buildIdentityPatch({ sessionId: 's', projectId: '', databasePath: 'd', serverPath }),
      (error: unknown) => error instanceof RuntimeRegistryError,
    )
    assert.throws(
      () => buildIdentityPatch({ sessionId: 's', projectId: 'p', databasePath: '', serverPath }),
      (error: unknown) => error instanceof RuntimeRegistryError,
    )
    assert.throws(
      () => writeSessionPatches({
        runtimeId: 'runtime-missing-server',
        role: 'worker',
        patchDirBase: join(root, 'patches'),
        sessionId: 's',
        projectId: 'p',
        databasePath: join(root, 'db', 'cadre.sqlite'),
        serverPath: join(root, 'missing-server.ts'),
      }),
      (error: unknown) => error instanceof RuntimeRegistryError && error.rawCode === 'PATCH_MISSING_SERVER',
    )
    assert.equal(existsSync(join(root, 'patches', 'runtime-missing-server')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiveSessionPatches is idempotent and leaves only archive copies', () => {
  const root = tempRoot()
  try {
    const serverPath = join(root, 'server.ts')
    writeFileSync(serverPath, '// dummy\n', 'utf8')
    const patches = writeSessionPatches({
      runtimeId: 'runtime-archive',
      role: 'supervisor',
      patchDirBase: join(root, 'patches'),
      sessionId: 'session-archive',
      projectId: 'project-archive',
      databasePath: join(root, 'db', 'cadre.sqlite'),
      serverPath,
    })
    const archiveDir = join(root, 'archive', 'runtime-archive')
    const first = archiveSessionPatches(patches.patchPaths, archiveDir)
    assert.equal(first.archivedPaths.length, 2)
    assert.equal(first.missing.length, 0)
    for (const active of patches.patchPaths) assert.equal(existsSync(active), false)
    for (const archived of first.archivedPaths) {
      assert.equal(existsSync(archived), true)
      assert.ok(readFileSync(archived, 'utf8').includes('session-archive'))
    }
    const second = archiveSessionPatches(patches.patchPaths, archiveDir)
    assert.deepEqual([...second.archivedPaths].sort(), [...first.archivedPaths].sort())
    assert.equal(second.missing.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EmployeeStore,
  validateEmployeeInput,
  type EmployeeFailure,
  type EmployeeResult,
  type UpsertEmployeeInput,
} from '../src/employees-db.ts'

const NOW = '2026-10-23T00:00:00.000Z'
const LATER = '2026-10-23T00:05:00.000Z'

const directories: string[] = []

function storeAt(path?: string): { store: EmployeeStore; path: string; directory: string } {
  const directory = path === undefined ? mkdtempSync(join(tmpdir(), 'cadre-employees-')) : join(path, '..')
  if (path === undefined) directories.push(directory)
  const database = path ?? join(directory, 'cadre.sqlite')
  return { store: new EmployeeStore(database), path: database, directory }
}

function employee(overrides: Partial<UpsertEmployeeInput> = {}): UpsertEmployeeInput {
  return { sessionId: 'ses-1', projectId: 'proj-1', ...overrides }
}

function expectOk<T>(result: EmployeeResult<T>): Extract<EmployeeResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`)
  return result
}

function expectFailure(result: EmployeeResult<unknown>): EmployeeFailure {
  if (result.ok) throw new Error('expected a failure')
  return result
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('employee roster migration', () => {
  it('creates the table additively and survives a second open', () => {
    const first = storeAt()
    first.store.close()
    const second = new EmployeeStore(first.path)
    const saved = second.upsert(employee({ templateId: 'cadre-dev' }), NOW)
    expect(saved.ok).toBe(true)
    second.close()

    const raw = new DatabaseSync(first.path)
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
    expect(tables.map(table => table.name)).toContain('employees')
    const columns = raw.prepare('PRAGMA table_info(employees)').all() as unknown as { name: string }[]
    expect(columns.map(column => column.name)).toEqual([
      'session_id', 'project_id', 'display_name', 'template_id', 'persona_note',
      'preferred_provider_id', 'preferred_model', 'created_at', 'updated_at',
    ])
    raw.close()
  })

  it('shares the file with the provider tables without touching them', () => {
    const { store, path } = storeAt()
    store.close()
    // The provider catalogue migration runs in its own connection on the same file.
    const providers = new DatabaseSync(path)
    providers.exec('CREATE TABLE IF NOT EXISTS providers (provider_id TEXT PRIMARY KEY)')
    providers.close()
    const reopened = new EmployeeStore(path)
    expect(reopened.upsert(employee(), NOW).ok).toBe(true)
    const raw = new DatabaseSync(path)
    const tables = raw.prepare('PRAGMA table_info(providers)').all() as unknown as { name: string }[]
    expect(tables.map(column => column.name)).toEqual(['provider_id'])
    raw.close()
    reopened.close()
  })
})

describe('employee roster CRUD', () => {
  it('inserts, updates without losing optional columns, and lists per project', () => {
    const { store } = storeAt()
    const created = expectOk(store.upsert(employee({
      displayName: '小九',
      templateId: 'cadre-dev',
      personaNote: '先读后改',
      preferredProviderId: 'deepseek-official',
      preferredModel: 'deepseek-v4-pro',
    }), NOW))
    expect(created.employee).toMatchObject({
      sessionId: 'ses-1', projectId: 'proj-1', displayName: '小九', templateId: 'cadre-dev',
      personaNote: '先读后改', preferredProviderId: 'deepseek-official', preferredModel: 'deepseek-v4-pro',
      createdAt: NOW, updatedAt: NOW,
    })

    const updated = expectOk(store.upsert({ sessionId: 'ses-1', projectId: 'proj-1', displayName: '九号' }, LATER))
    expect(updated.employee.displayName).toBe('九号')
    expect(updated.employee.templateId).toBe('cadre-dev')
    expect(updated.employee.createdAt).toBe(NOW)
    expect(updated.employee.updatedAt).toBe(LATER)

    const cleared = expectOk(store.upsert({ sessionId: 'ses-1', projectId: 'proj-1', personaNote: null }, LATER))
    expect(cleared.employee.personaNote).toBeUndefined()

    store.upsert(employee({ sessionId: 'ses-2', projectId: 'proj-1' }), NOW)
    store.upsert(employee({ sessionId: 'ses-3', projectId: 'proj-2' }), NOW)
    expect(store.list('proj-1').map(row => row.sessionId)).toEqual(['ses-1', 'ses-2'])
    expect(store.list('proj-2').map(row => row.sessionId)).toEqual(['ses-3'])
    store.close()
  })

  it('rejects moving an existing session to another project', () => {
    const { store } = storeAt()
    expect(store.upsert(employee(), NOW).ok).toBe(true)
    const moved = expectFailure(store.upsert(employee({ projectId: 'proj-2' }), LATER))
    expect(moved.code).toBe('INVALID_ARGUMENT')
    expect(moved.field).toBe('projectId')
    store.close()
  })

  it('deletes only inside the owning project', () => {
    const { store } = storeAt()
    expect(store.upsert(employee(), NOW).ok).toBe(true)
    const foreign = expectFailure(store.delete('ses-1', 'proj-2'))
    expect(foreign.code).toBe('NOT_FOUND')
    expect(store.get('ses-1', 'proj-1')).toBeDefined()
    expect(store.delete('ses-1', 'proj-1').ok).toBe(true)
    expect(store.get('ses-1')).toBeUndefined()
    store.close()
  })

  it('returns undefined when reading across projects', () => {
    const { store } = storeAt()
    expect(store.upsert(employee(), NOW).ok).toBe(true)
    expect(store.get('ses-1', 'proj-2')).toBeUndefined()
    expect(store.get('ses-1', 'proj-1')?.sessionId).toBe('ses-1')
    store.close()
  })
})

describe('employee roster validation', () => {
  it('rejects an empty or malformed session id', () => {
    for (const sessionId of ['', ' ses-1', 'ses 1', 'x'.repeat(129)]) {
      const failure = validateEmployeeInput(employee({ sessionId }))
      expect(failure?.code).toBe('INVALID_ARGUMENT')
      expect(failure?.field).toBe('sessionId')
    }
  })

  it('rejects an over-long display name and persona note', () => {
    const name = validateEmployeeInput(employee({ displayName: '名'.repeat(81) }))
    expect(name?.field).toBe('displayName')
    const note = validateEmployeeInput(employee({ personaNote: '笔'.repeat(4_001) }))
    expect(note?.field).toBe('personaNote')
    expect(validateEmployeeInput(employee({ displayName: '名'.repeat(80) }))).toBeUndefined()
    expect(validateEmployeeInput(employee({ personaNote: '笔'.repeat(4_000) }))).toBeUndefined()
  })

  it('accepts only cadre-* templates or an empty value', () => {
    for (const templateId of ['dev', 'cadre', 'cadre-', 'cadre-Dev', 'other-dev', 'cadre-dev!']) {
      const failure = validateEmployeeInput(employee({ templateId }))
      expect(failure?.code).toBe('INVALID_ARGUMENT')
      expect(failure?.field).toBe('templateId')
    }
    // Surrounding whitespace is trimmed before the match, like every other text column.
    // An absent key and an explicit null/empty value are both accepted, so the
    // undefined case spreads no property (exactOptionalPropertyTypes).
    for (const templateId of [undefined, null, '', '  ', 'cadre-dev', 'cadre-roleplay', ' cadre-dev ']) {
      expect(validateEmployeeInput(employee(templateId === undefined ? {} : { templateId }))).toBeUndefined()
    }
  })

  it('rejects malformed provider or model preferences', () => {
    expect(validateEmployeeInput(employee({ preferredProviderId: 'Bad Provider' }))?.field).toBe('preferredProviderId')
    expect(validateEmployeeInput(employee({ preferredModel: 'bad model id' }))?.field).toBe('preferredModel')
    expect(validateEmployeeInput(employee({ preferredProviderId: '', preferredModel: '' }))).toBeUndefined()
  })

  it('rejects control characters but allows newlines in notes', () => {
    expect(validateEmployeeInput(employee({ displayName: '小\u0000九' }))?.field).toBe('displayName')
    expect(validateEmployeeInput(employee({ personaNote: '第一行\n第二行\t缩进' }))).toBeUndefined()
  })

  it('maps validation failures to structured results without writing', () => {
    const { store } = storeAt()
    const saved = expectFailure(store.upsert(employee({ templateId: 'nope' }), NOW))
    expect(saved).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'templateId' })
    expect(store.list('proj-1')).toEqual([])
    store.close()
  })
})

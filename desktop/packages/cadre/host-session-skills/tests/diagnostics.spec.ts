import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendSessionError, collectAdminDiagnostics, type PresetDiagnosticsPort } from '../src/diagnostics.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

function port(rows: Array<{ id: string; broken?: string }>): PresetDiagnosticsPort {
  return {
    list: async () => rows,
    resolve: async id => rows.find(row => row.id === id) ?? (() => { throw new Error('missing') })() as never,
  }
}

describe('skill admin diagnostics', () => {
  it('reports a missing preset', async () => {
    const result = await collectAdminDiagnostics({
      presetId: 'cadre-skill-admin', presets: port([]), sessionController: {}, adminService: {},
    })
    expect(result.preset).toMatchObject({ exists: false, available: false })
    expect(result.sessionController.available).toBe(true)
  })

  it('reports a broken preset', async () => {
    const result = await collectAdminDiagnostics({
      presetId: 'cadre-skill-admin',
      presets: port([{ id: 'cadre-skill-admin', broken: 'missing plugin' }]),
      sessionController: {}, adminService: {},
    })
    expect(result.preset).toMatchObject({ exists: true, available: false, broken: 'missing plugin' })
  })

  it('reports a missing session controller and writes a redacted log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cadre-diag-'))
    roots.push(root)
    const result = await collectAdminDiagnostics({
      presetId: 'cadre-skill-admin', presets: port([{ id: 'cadre-skill-admin' }]),
      sessionController: undefined, adminService: undefined,
    })
    expect(result.sessionController.available).toBe(false)
    expect(result.admin.serviceAvailable).toBe(false)
    const path = join(root, 'session-error.log')
    appendSessionError(path, new Error('boom'), result)
    const log = readFileSync(path, 'utf8')
    expect(log).toContain('"message":"boom"')
    expect(log).toContain('"sessionController":{"available":false}')
    expect(log).not.toContain('【主管任务】')
  })
})

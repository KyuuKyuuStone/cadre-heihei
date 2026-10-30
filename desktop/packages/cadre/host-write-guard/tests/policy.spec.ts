import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluatePolicy, parsePolicy, type WritePolicy } from '../src/policy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'write-guard-'))
  roots.push(root)
  return root
}

function policy(overrides: Partial<WritePolicy> = {}): WritePolicy {
  return {
    version: 1,
    roles: ['supervisor'],
    roots: ['project', 'reports'],
    reportDirName: 'reports',
    allowExtensions: ['.md', '.txt'],
    writeTools: {
      write: { path: 'file_path' },
      edit: { path: 'file_path' },
      str_replace_editor: { path: 'path', altPaths: ['file_path'] },
    },
    denyTools: { office_docx: 'office', bash: 'shell' },
    denyToolPrefixes: ['office_'],
    ...overrides,
  }
}

const identity = (path: string): string => path

describe('write policy', () => {
  it('allows .md/.txt under the project and reports roots', () => {
    const root = project()
    expect(evaluatePolicy(policy(), {
      tool: 'write', args: { file_path: join(root, 'notes', 'a.md') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: true, rule: 'allowed' })
    expect(evaluatePolicy(policy(), {
      tool: 'edit', args: { file_path: join(root, 'reports', 'a.txt') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: true })
  })

  it('denies other extensions and paths outside the roots', () => {
    const root = project()
    expect(evaluatePolicy(policy(), {
      tool: 'write', args: { file_path: join(root, 'a.py') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: false, code: 'WRITE_EXTENSION_DENIED' })
    expect(evaluatePolicy(policy(), {
      tool: 'write', args: { file_path: join(root, '..', 'evil.md') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: false, code: 'WRITE_PATH_DENIED' })
  })

  it('denies Office and shell tools explicitly, regardless of path/extension', () => {
    const root = project()
    expect(evaluatePolicy(policy(), { tool: 'office_docx', args: {}, projectRoot: root }, identity))
      .toMatchObject({ allow: false, code: 'WRITE_POLICY_DENIED', rule: 'deny:office' })
    expect(evaluatePolicy(policy(), { tool: 'bash', args: {}, projectRoot: root }, identity))
      .toMatchObject({ allow: false, code: 'WRITE_POLICY_DENIED', rule: 'deny:shell' })
    expect(evaluatePolicy(policy(), { tool: 'office_xlsx', args: {}, projectRoot: root }, identity))
      .toMatchObject({ allow: false, code: 'WRITE_POLICY_DENIED' })
  })

  it('rejects a registered write tool with a missing path argument', () => {
    expect(evaluatePolicy(policy(), { tool: 'write', args: {}, projectRoot: project() }, identity))
      .toMatchObject({ allow: false, code: 'WRITE_POLICY_TOOL_UNSUPPORTED' })
  })

  it('normalizes case and resolves symlinks outside the roots through the resolver', () => {
    const root = project()
    const outside = project()
    writeFileSync(join(root, 'ok.MD'), '# ok')
    symlinkSync(outside, join(root, 'escape'))
    expect(evaluatePolicy(policy(), {
      tool: 'write', args: { file_path: join(root, 'ok.MD') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: true })
    const resolved = (path: string): string => path.replace(join(root, 'escape'), outside)
    expect(evaluatePolicy(policy(), {
      tool: 'write', args: { file_path: join(root, 'escape', 'x.md') }, projectRoot: root,
    }, resolved)).toMatchObject({ allow: false, code: 'WRITE_PATH_DENIED' })
  })

  it('accepts the str_replace_editor alt path field', () => {
    const root = project()
    expect(evaluatePolicy(policy(), {
      tool: 'str_replace_editor', args: { file_path: join(root, 'a.md') }, projectRoot: root,
    }, identity)).toMatchObject({ allow: true })
  })

  it('rejects malformed policy documents', () => {
    expect(() => parsePolicy({ version: 1 })).toThrow()
    expect(() => parsePolicy({ version: 2 })).toThrow(/version/)
    expect(() => parsePolicy({
      version: 1, roots: ['elsewhere'], reportDirName: 'reports',
      allowExtensions: ['.md'], writeTools: {}, denyTools: {}, denyToolPrefixes: [],
    })).toThrow(/roots/)
  })
})

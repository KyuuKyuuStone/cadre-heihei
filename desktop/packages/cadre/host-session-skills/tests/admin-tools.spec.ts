import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/admin-plugin.ts'
import { adminSessionPort } from '../src/index.ts'
import { SkillAdminApi, type AdminMessage, type AdminSessionPort } from '../src/admin.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadre-admin-tools-'))
  roots.push(root)
  return root
}

function ledger(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'ledger.sqlite'))
  db.exec(`CREATE TABLE members (project_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    state TEXT NOT NULL, skills_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id))`)
  db.prepare(`INSERT INTO members (project_id, session_id, role, state, skills_json, created_at, updated_at)
    VALUES ('p1', 's1', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p1', 's2', 'supervisor', 'available', '[]', 'now', 'now'),
           ('p1', 'w1', 'worker', 'available', '[]', 'now', 'now')`).run()
  return db
}

interface Registered {
  readonly name: string
  readonly execute: (args: Record<string, unknown>, run: { agent?: { id: string } }) => Promise<unknown>
}

describe('skill admin model tools', () => {
  it('registers the five admin tools, sends messages, and installs by name/url', async () => {
    const root = workspace()
    const packs = join(root, 'installed')
    const setup = ledger(root)
    setup.close()
    const db = new DatabaseSync(join(root, 'ledger.sqlite'))
    const sessions: Array<{ sessionId: string; title: string; updatedAt: number }> = []
    const history: AdminMessage[] = []
    const port: AdminSessionPort = {
      create: async input => {
        const sessionId = `admin-${String(sessions.length + 1)}`
        sessions.push({ sessionId, title: input.title, updatedAt: 1 })
        return { sessionId }
      },
      list: async () => sessions,
      prompt: async ({ text }) => {
        const seq = history.length + 1
        history.push({ seq, role: 'user', text, time: seq })
        history.push({ seq: seq + 1, role: 'assistant', text: `回显：${text}`, time: seq + 1 })
      },
      messages: async ({ afterSeq }) => {
        const messages = history.filter(message => message.seq > afterSeq)
        return { messages, nextSeq: messages.at(-1)?.seq ?? afterSeq }
      },
    }
    const fetch = vi.fn(async (input: URL | string) => {
      const raw = String(input)
      const id = raw.includes('tool-url') ? 'tool-url' : 'tool-pack'
      return raw.endsWith('manifest.json')
        ? new Response(JSON.stringify({
          id, name: id, description: 'tool', roles: ['worker'],
          tokenEstimate: 1, tools: [], source: 'github:o/r', license: 'MIT',
        }), { status: 200 })
        : new Response(`# ${id} body`, { status: 200 })
    })
    const admin = new SkillAdminApi({
      db, ledgerPath: join(root, 'ledger.sqlite'), skillsDir: packs,
      sessions: port, auditDir: join(root, 'audit'), fetch: fetch as never,
      runPackageCommand: async args => {
        const name = args[5]!
        const parts = name.startsWith('@') ? name.split('/') : [name]
        const dir = join(packs, ...parts)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${parts.at(-1)}\ndescription: tool\n---\n# tool\n`)
        return { code: 0, stdout: 'installed', stderr: '' }
      },
    })
    const created = await admin.createSession({ projectId: 'p1', operatorSessionId: 's1', cwd: root })
    admin.bindSession({ sessionId: created.sessionId, projectId: 'p1', operatorSessionId: 's1' })

    const registered: Registered[] = []
    apply({
      tools: { register: tool => { registered.push(tool as unknown as Registered); return () => {} } },
      get: () => admin,
    })
    expect(registered.map(tool => tool.name))
      .toEqual(['skill_catalog', 'skill_preview', 'skill_install', 'skill_plan', 'skill_audit'])
    const run = { agent: { id: created.sessionId } }
    const find = (name: string): Registered => registered.find(tool => tool.name === name) as Registered

    const planned = await find('skill_plan').execute({
      url: 'https://raw.githubusercontent.com/o/r/main/packs/tool/SKILL.md',
    }, run) as { planId: string; confirmToken: string; kind: string; packId: string }
    expect(planned).toMatchObject({ kind: 'install', packId: 'tool-pack' })
    expect(planned.confirmToken).toBeTruthy()

    const applied = await admin.apply({
      projectId: 'p1', operatorSessionId: 's1', planId: planned.planId, token: planned.confirmToken,
    })
    expect(applied).toMatchObject({ status: 'applied', packId: 'tool-pack' })

    expect(await find('skill_catalog').execute({ query: 'tool' }, run)).toMatchObject({
      skills: [expect.objectContaining({ id: 'tool-pack' })],
    })
    expect(await find('skill_preview').execute({ packId: 'tool-pack' }, run)).toMatchObject({
      content: '# tool-pack body', license: 'MIT',
    })
    expect(await find('skill_audit').execute({}, run)).toMatchObject({
      items: [expect.objectContaining({ result: 'applied', packId: 'tool-pack' })],
    })

    await expect(find('skill_install').execute({ name: '@scope/tool-install' }, run)).resolves.toMatchObject({
      kind: 'package', target: '@scope/tool-install',
    })
    await expect(find('skill_install').execute({
      url: 'https://raw.githubusercontent.com/o/r/main/packs/tool-url/SKILL.md',
    }, run)).resolves.toMatchObject({ kind: 'url', target: expect.stringContaining('tool-url') })
    expect(await find('skill_audit').execute({}, run)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: 'tool-install', result: 'installed' })]),
    })
    await expect(find('skill_install').execute({ name: 'a-b', url: 'https://example.com' }, run))
      .rejects.toThrow(/必须且只能提供一个|SKILL_INVALID/)
    expect(readFileSync(join(root, 'audit', 'audit.jsonl'), 'utf8')).toContain('tool-install')

    await admin.sendMessage({
      projectId: 'p1', operatorSessionId: 's1', sessionId: created.sessionId, text: '有什么技能',
    })
    const page = await admin.messages({
      projectId: 'p1', operatorSessionId: 's1', sessionId: created.sessionId, afterSeq: 0,
    })
    expect(page.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(page.messages[0]).toMatchObject({ role: 'user', text: '有什么技能' })
    expect(await admin.messages({
      projectId: 'p1', operatorSessionId: 's1', sessionId: created.sessionId, afterSeq: page.messages[0]!.seq,
    })).toMatchObject({ messages: [expect.objectContaining({ role: 'assistant' })] })
    await expect(admin.sendMessage({
      projectId: 'p1', operatorSessionId: 's2', sessionId: created.sessionId, text: 'x',
    })).rejects.toMatchObject({ code: 'SKILL_ADMIN_SESSION_FORBIDDEN' })
    await expect(admin.messages({
      projectId: 'p2', operatorSessionId: 's1', sessionId: created.sessionId, afterSeq: 0,
    })).rejects.toMatchObject({ code: 'SKILL_FORBIDDEN' })
    await expect(admin.sendMessage({
      projectId: 'p1', operatorSessionId: 'w1', sessionId: created.sessionId, text: 'x',
    })).rejects.toMatchObject({ code: 'SKILL_FORBIDDEN' })

    await expect(find('skill_catalog').execute({}, { agent: { id: 'other' } }))
      .rejects.toThrow(/未绑定/)
    const unsupported = await find('skill_plan').execute({ url: 'https://example.com/README.md' }, run)
    expect(unsupported).toMatchObject({ kind: 'unsupported' })
    db.close()
  })

  it('resolves sessionController lazily so plugin load order does not disable admin sessions', async () => {
    let service: { create: (input: { cwd: string }) => Promise<{ sessionId: string }>; list: () => Promise<{ items: [] }> } | undefined
    const port = adminSessionPort({ get: () => service } as never)
    await expect(port.create({ preset: 'cadre-skill-admin', cwd: '.', title: 'x' }))
      .rejects.toMatchObject({ code: 'SKILL_ADMIN_UNAVAILABLE' })
    service = { create: async () => ({ sessionId: 'session-late' }), list: async () => ({ items: [] }) }
    await expect(port.create({ preset: 'cadre-skill-admin', cwd: '.', title: 'x' }))
      .resolves.toEqual({ sessionId: 'session-late' })
  })
})

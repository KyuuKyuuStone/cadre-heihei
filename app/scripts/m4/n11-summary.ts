#!/usr/bin/env node
/**
 * N11 取证汇总：读取代理抓到的请求头与 E2E summary，判定目标头是否缺失。
 * 用法：node scripts/m4/n11-summary.ts <runDir> <headers.jsonl>
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const TARGET_HEADERS = ['x-deepseek-harness-user-id', 'x-deepseek-harness-session-id']

const runDir = process.argv[2]
const headersPath = process.argv[3]
if (!runDir || !headersPath) {
  console.error('usage: n11-summary.ts <runDir> <headers.jsonl>')
  process.exit(2)
}

function readKey(): string {
  for (const line of readFileSync(SECRET_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match?.[1] === 'DEEPSEEK_API_KEY') return match[2]!.trim().replace(/^['"]|['"]$/g, '')
  }
  throw new Error('DEEPSEEK_API_KEY not found')
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function projectTasks(runDir: string): Array<Record<string, unknown>> {
  const path = join(runDir, 'userdata', 'cadre.sqlite')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path)
  try {
    return db
      .prepare(
        `SELECT task_id, project_id, title, status, dispatcher_session_id,
                assignee_session_id, created_at
         FROM tasks WHERE project_id = 'e2e-project' ORDER BY rowid ASC`,
      )
      .all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const rows = readFileSync(headersPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Record<string, unknown>)
const requests = rows.filter((row) => row.method !== undefined)
const responses = rows.filter((row) => row.response !== undefined)
const names = new Set<string>()
for (const request of requests) {
  for (const name of Object.keys((request.headers ?? {}) as Record<string, unknown>)) {
    names.add(name.toLowerCase())
  }
}
const present = TARGET_HEADERS.filter((name) => names.has(name))
const values = requests.map((request) => JSON.stringify(request.headers ?? {})).join(' ')
const identityLeak = ['e2e-project', 'e2e-session'].filter((value) => values.includes(value))

const runFiles = walk(runDir)
const key = readKey()
const scan = runFiles
  .filter((file) => !file.endsWith('.sqlite') && !file.endsWith('.sqlite-wal') && !file.endsWith('.sqlite-shm'))
  .map((file) => {
    const text = readFileSync(file, 'utf8')
    return {
      file: file.slice(runDir.length + 1),
      exact: text.split(key).length - 1,
      pattern: text.match(/sk-[A-Za-z0-9_-]{6,}/g)?.length ?? 0,
    }
  })

const e2eSummaryPath = join(runDir, 'summary.json')
const e2e = existsSync(e2eSummaryPath)
  ? (JSON.parse(readFileSync(e2eSummaryPath, 'utf8')) as Record<string, unknown>)
  : null

const probe = e2e?.probe as Record<string, unknown> | undefined
const events = Array.isArray(probe?.events)
  ? (probe!.events as Array<Record<string, unknown>>)
  : []
const toolCalls = events.filter((event) => event.kind === 'tool.call')
const toolResults = events.filter((event) => event.kind === 'tool.result')
const toolNames = [...new Set([...toolCalls, ...toolResults].map((event) => String(event.toolName ?? '')))]
const toolOk = toolResults.length > 0 && toolResults.every((event) => event.ok === true)
const tasks = projectTasks(runDir)
const dispatched = tasks.filter((task) => task.dispatcher_session_id === 'e2e-session')
const bodyShapes = requests
  .map((request) => request.bodyShape as Record<string, unknown> | null)
  .filter((shape): shape is Record<string, unknown> => shape !== null)
const tool = {
  eventToolCalls: toolCalls,
  eventToolResults: toolResults,
  toolNames,
  toolOk,
  dispatchTaskCalled: toolNames.some((name) => name.includes('dispatch_task')),
  dbTasksInProject: tasks,
  dispatchedByE2e: dispatched,
  dispatchSideEffectOk:
    dispatched.length >= 1 &&
    dispatched.some((task) => task.assignee_session_id === 'e2e-worker'),
  requestBodyShape: bodyShapes,
  reasoningParamsSeen: [
    ...new Set(
      bodyShapes.map((shape) =>
        JSON.stringify({
          reasoning_effort: shape.reasoningEffort,
          thinking: shape.thinking,
          reasoning: shape.reasoning,
        }),
      ),
    ),
  ],
  compaction: 'untested',
}

const summary = {
  scheme: 'A',
  schemeDetail:
    'patch 禁用 llm-deepseek（固定注入目标头、无开关），改用 base profile 的 llm-pi-ai deepseek 路由',
  provider: 'deepseek',
  model: 'deepseek-flash',
  capture: {
    headersFile: 'headers.jsonl',
    requestCount: requests.length,
    responseStatuses: responses.map((row) => row.response),
    headerNames: [...names].sort(),
    targetHeadersPresent: present,
    targetHeadersAbsent: present.length === 0,
    identityValuesInHeaders: identityLeak,
  },
  run: e2e === null
    ? null
    : {
        runCount: e2e.runCount,
        eventKinds: e2e.eventKinds,
        eventSeqs: e2e.eventSeqs,
        finalText: e2e.finalText,
        elapsedMs: e2e.elapsedMs,
        residualHarness: e2e.residualHarness,
      },
  tool,
  scan,
  scanClean: scan.every((entry) => entry.exact === 0 && entry.pattern === 0),
}
writeFileSync(join(runDir, 'n11-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
const hashes = {
  summary: sha256(join(runDir, 'n11-summary.json')),
  headers: sha256(join(runDir, 'headers.jsonl')),
  e2eSummary: existsSync(e2eSummaryPath) ? sha256(e2eSummaryPath) : null,
  scan: sha256(join(runDir, 'scan.json')),
}
writeFileSync(join(runDir, 'n11-hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')

const ok =
  present.length === 0 &&
  identityLeak.length === 0 &&
  requests.length >= 1 &&
  summary.scanClean &&
  e2e !== null &&
  e2e.probeOk === true &&
  tool.eventToolCalls.length >= 1 &&
  tool.eventToolResults.length >= 1 &&
  tool.toolOk &&
  tool.dispatchTaskCalled &&
  tool.dispatchSideEffectOk
console.log(JSON.stringify({ ok, runDir: resolve(runDir), ...summary, hashes }, null, 2))
process.exit(ok ? 0 : 1)

/**
 * M2 会话运行时注册表集成 soak（独立脚本，不进 node:test）。
 *
 * 3 个真实 harness 实例并发；默认 5 分钟。验证：
 * - 每会话身份 patch（MCP args/env）与 dshHome/patch 独立；
 * - working directory set/get 不串；
 * - 名单工具返回的项目身份不串；
 * - 显式 reclaim + rebuild（同一 dshHome、归档 patch）可恢复；
 * - stop 后 runtime/MCP 残留 0，patch 全部归档，注册表保留 closed 摘要。
 *
 * 用法：node scripts/m2-runtime-registry/soak.ts  （SOAK_MS 可覆盖，默认 300000）
 * 凭据只从 .secrets/deepseek.env 读入 env；不打印、不进 argv、不落日志。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { SqliteCollabStore } from '../../src/collab/dispatch/index.ts'
import type { ProjectId, SessionId } from '../../src/collab/protocol/ids.ts'
import type { EngineEvent, EngineSession } from '../../src/ports/engine.ts'
import {
  SessionRuntimeRegistry,
  type RuntimeSessionHandle,
} from '../../src/runtime/index.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(SCRIPT_DIR, '../..')
const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const OUT_ROOT = argValue('out-root') ?? process.env.OUT_ROOT ?? 'D:\\xxw_p\\cadre-spike-env\\s10-m2-soak'
const MCP_SERVER_PATH = join(APP_ROOT, 'src', 'mcp', 'server.ts')
const SOAK_MS = Number(argValue('soak-ms') ?? process.env.SOAK_MS ?? 300_000)
const ROUNDS_ARG = Number(argValue('rounds') ?? 0)
const ROUND_INTERVAL_MS = Number(argValue('round-interval-ms') ?? Math.max(5_000, Math.min(30_000, Math.floor(SOAK_MS / 10))))
const MODEL_ROSTER_EVERY = Number(argValue('model-roster-every') ?? 20)
const DIRECT_ROSTER_EVERY = Number(argValue('direct-roster-every') ?? 2)
const RSS_EVERY = Number(argValue('rss-every') ?? 10)
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const STARTED_AT = new Date().toISOString()
const RUN_DIR = join(OUT_ROOT, RUN_ID)
const RAW_DIR = join(RUN_DIR, 'raw')
const WORK_DIR = join(RUN_DIR, 'work')
const DB_DIR = join(RUN_DIR, 'dbs')
const HOMES_DIR = join(RUN_DIR, 'homes')
const PATCH_DIR = join(RUN_DIR, 'patches')
const ARCHIVE_DIR = join(RUN_DIR, 'patch-archive')
const SK_PATTERN = 'sk-[A-Za-z0-9_-]{6,}'

const runs: Array<Record<string, unknown>> = []
const runLog: string[] = []
const processChecks: Array<Record<string, unknown>> = []
const workdirRounds: Array<Record<string, unknown>> = []
const directRosterResults: Array<Record<string, unknown>> = []
const modelRosterResults: Array<Record<string, unknown>> = []
const rssSamples: Array<Record<string, unknown>> = []
let key = ''
let registry: SessionRuntimeRegistry | undefined
let registryStopped = false

interface SessionSpec {
  readonly projectId: string
  readonly sessionId: string
  readonly role: 'supervisor' | 'worker'
  readonly workingDirectory: string
  readonly forbiddenProjectId: string
  readonly databasePath: string
}

function readKey(file: string): string {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match?.[1] !== 'DEEPSEEK_API_KEY') continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (value.length < 10) throw new Error('DEEPSEEK_API_KEY too short')
    return value
  }
  throw new Error('DEEPSEEK_API_KEY not found')
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: key,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    NO_PROXY: '*',
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[name]
  }
  return env
}

function redact(value: unknown): string {
  let text = String(value ?? '')
  if (key.length > 0) text = text.split(key).join('[REDACTED]')
  return text.replace(new RegExp(SK_PATTERN, 'g'), '[REDACTED]')
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactDeep(item)]))
  }
  return value
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(redactDeep(value), null, 2)}\n`, 'utf8')
}

function log(line: string): void {
  const text = `${new Date().toISOString()} ${redact(line)}`
  runLog.push(text)
  console.log(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function now(): string {
  return new Date().toISOString()
}

async function seedProject(projectId: string, databasePath: string, members: readonly {
  readonly sessionId: string
  readonly role: 'supervisor' | 'worker'
}[]): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true })
  const store = new SqliteCollabStore({ databasePath })
  try {
    for (const member of members) {
      store.addMember({
        projectId: projectId as ProjectId,
        sessionId: member.sessionId as SessionId,
        role: member.role,
        state: 'available',
        displayName: member.sessionId,
      })
    }
  } finally {
    store.close()
  }
}

function eventToolCalls(events: readonly EngineEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event): event is Extract<EngineEvent, { kind: 'tool.call' }> => event.kind === 'tool.call')
    .map((event) => ({ toolName: event.toolName, callId: event.callId, summary: event.summary }))
}

function eventToolResults(events: readonly EngineEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event): event is Extract<EngineEvent, { kind: 'tool.result' }> => event.kind === 'tool.result')
    .map((event) => ({
      toolName: event.toolName,
      callId: event.callId,
      ok: event.ok,
      summary: event.summary,
    }))
}

async function runPrompt(session: EngineSession, label: string, prompt: string): Promise<{
  readonly events: readonly EngineEvent[]
  readonly toolCalls: Array<Record<string, unknown>>
  readonly toolResults: Array<Record<string, unknown>>
  readonly finalResponse: string
  readonly ms: number
  readonly timedOut: boolean
}> {
  const started = Date.now()
  const events: EngineEvent[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    for await (const event of session.send(prompt, { signal: controller.signal })) events.push(event)
  } finally {
    clearTimeout(timer)
  }
  const finalResponse = events
    .filter((event): event is Extract<EngineEvent, { kind: 'message.complete' }> => event.kind === 'message.complete')
    .map((event) => event.text)
    .join('')
  const record = {
    label,
    ms: Date.now() - started,
    timedOut: controller.signal.aborted,
    toolCalls: eventToolCalls(events),
    toolResults: eventToolResults(events),
    finalResponse: redact(finalResponse).slice(0, 2000),
  }
  runs.push(record)
  writeJson(join(RAW_DIR, `${label}.json`), record)
  log(`[${label}] ${record.ms}ms calls=${record.toolCalls.length} results=${record.toolResults.length} timeout=${record.timedOut}`)
  return { ...record, events }
}

async function rosterCheck(
  handle: RuntimeSessionHandle,
  expectedProjectId: string,
  forbiddenProjectId: string,
  label: string,
): Promise<{ readonly ok: boolean; readonly result: Record<string, unknown> | undefined }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = await runPrompt(
      handle.session,
      `${label}-${String(attempt)}`,
      'Call the MCP tool mcp__cadre__list_roster exactly once with arguments {"scope":"project"}. Do not use any other tool. After it returns, reply DONE.',
    )
    const result = run.toolResults.find((item) => item.toolName === 'mcp__cadre__list_roster')
    if (result !== undefined) {
      const summary = String(result.summary ?? '')
      const ok = result.ok === true &&
        summary.includes(expectedProjectId) &&
        !summary.includes(forbiddenProjectId)
      return { ok, result }
    }
    if (run.timedOut) break
  }
  return { ok: false, result: undefined }
}

async function checkWorkdir(handle: RuntimeSessionHandle, round: number): Promise<boolean> {
  const target = join(WORK_DIR, String(handle.session.sessionId), `round-${String(round)}`)
  mkdirSync(target, { recursive: true })
  await handle.session.setWorkingDirectory(target)
  const actual = await handle.session.getWorkingDirectory()
  const ok = resolve(actual).toLowerCase() === resolve(target).toLowerCase()
  workdirRounds.push({ round, sessionId: handle.session.sessionId, target, actual, ok })
  if (!ok) log(`[workdir] MISMATCH session=${handle.session.sessionId} target=${target} actual=${actual}`)
  return ok
}

function directRosterCheck(spec: SessionSpec, round: number): Promise<Record<string, unknown>> {
  const started = Date.now()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CADRE_PROJECT_ID: spec.projectId,
    CADRE_SESSION_ID: spec.sessionId,
    CADRE_DB_PATH: spec.databasePath,
  }
  delete env.DEEPSEEK_API_KEY
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
  const child = spawn(
    process.execPath,
    [
      MCP_SERVER_PATH,
      '--project-id', spec.projectId,
      '--session-id', spec.sessionId,
      '--database-path', spec.databasePath,
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  let buffer = ''
  let stderr = ''
  const responses = new Map<number, Record<string, unknown>>()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const done = new Promise<void>((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error('direct MCP roster timeout')), 10_000)
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          if (typeof message.id === 'number') responses.set(message.id, message)
          if (message.id === 3) {
            clearTimeout(timer)
            resolveDone()
          }
        } catch {
          // direct server 可能输出非 JSON 诊断；仅保留 stderr。
        }
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectDone(error)
    })
    child.on('exit', () => {
      if (!responses.has(3)) {
        clearTimeout(timer)
        rejectDone(new Error('direct MCP exited before roster response'))
      }
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's10-direct-roster', version: '0.0.1' } } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_roster', arguments: { scope: 'project' } } })}\n`)

  return done
    .then(() => {
      const response = responses.get(3)
      const content = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content
      const text = content?.[0]?.text ?? ''
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        parsed = undefined
      }
      const projects = Array.isArray(parsed?.projects) ? parsed.projects as Array<Record<string, unknown>> : []
      const members = Array.isArray(parsed?.members) ? parsed.members as Array<Record<string, unknown>> : []
      const projectOk = parsed?.ok === true &&
        projects.length > 0 &&
        projects.every((project) => project.projectId === spec.projectId) &&
        members.every((member) => member.projectId === spec.projectId)
      const result = {
        round,
        sessionId: spec.sessionId,
        expectedProjectId: spec.projectId,
        ok: projectOk,
        ms: Date.now() - started,
        pid: child.pid,
        projectIds: projects.map((project) => project.projectId),
        memberSessionIds: members.map((member) => member.sessionId),
        summary: redact(text).slice(0, 1000),
        stderr: redact(stderr).slice(0, 500),
        error: null as string | null,
      }
      directRosterResults.push(result)
      if (!projectOk) log(`[direct-roster] MISMATCH ${spec.sessionId} round=${round} project=${String(projects[0]?.projectId)}`)
      return result
    })
    .catch((error: unknown) => {
      const result = {
        round,
        sessionId: spec.sessionId,
        expectedProjectId: spec.projectId,
        ok: false,
        ms: Date.now() - started,
        pid: child.pid,
        projectIds: [],
        memberSessionIds: [],
        summary: '',
        stderr: redact(stderr).slice(0, 500),
        error: redact(error instanceof Error ? error.message : String(error)).slice(0, 500),
      }
      directRosterResults.push(result)
      log(`[direct-roster] FAILED ${spec.sessionId} round=${round}: ${String(result.error)}`)
      return result
    })
    .finally(() => {
      try { child.stdin.end() } catch { /* already closed */ }
      setTimeout(() => { try { child.kill() } catch { /* already exited */ } }, 200)
    })
}

function dbSnapshot(path: string): Record<string, unknown> {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    const tables = ['projects', 'members', 'tasks', 'messages', 'task_events', 'idempotency']
    const counts: Record<string, unknown> = {}
    const projectIds: Record<string, unknown> = {}
    for (const table of tables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown }
        counts[table] = Number(row.n ?? 0)
        const rows = db.prepare(`SELECT DISTINCT project_id FROM ${table}`).all() as Array<{ project_id?: unknown }>
        projectIds[table] = rows.map((item) => String(item.project_id)).sort()
      } catch {
        counts[table] = 'missing'
        projectIds[table] = []
      }
    }
    return { path, at: now(), counts, projectIds }
  } finally {
    db.close()
  }
}

function assertDbSnapshot(snapshot: Record<string, unknown>, label: string): void {
  const counts = snapshot.counts as Record<string, unknown>
  const projectIds = snapshot.projectIds as Record<string, unknown>
  for (const table of ['tasks', 'messages', 'task_events', 'idempotency']) {
    assert.equal(counts[table], 0, `${label}: unexpected ${table} rows in ${String(snapshot.path)}`)
  }
  const expectedProject = String(snapshot.path).includes('proj-p1') ? 'proj-p1' : 'proj-p2'
  assert.deepEqual(projectIds.members, [expectedProject], `${label}: cross-project members in ${String(snapshot.path)}`)
}

function patchSnapshot(label: string): Record<string, unknown> {
  const describe = (root: string): Array<Record<string, unknown>> => {
    if (!existsSync(root)) return []
    return walk(root).map((full) => ({
      path: relative(root, full).split('\\').join('/'),
      sha256: sha256(full),
      bytes: readFileSync(full).byteLength,
    }))
  }
  return {
    label,
    at: now(),
    active: describe(PATCH_DIR),
    archived: describe(ARCHIVE_DIR),
  }
}

function summarizeRss(label: string, round: number, processes: readonly Record<string, unknown>[]): Record<string, unknown> {
  const described = processes.map(describeProcess)
  const sum = (items: readonly Record<string, unknown>[]): number =>
    items.reduce((total, item) => total + Number(item.rssBytes ?? 0), 0)
  const mcp = described.filter((item) => String(item.commandTail ?? '').includes('mcp') && String(item.commandTail ?? '').includes('server.ts'))
  const runtime = described.filter((item) => !mcp.includes(item))
  return {
    label,
    round,
    at: now(),
    count: described.length,
    totalRssBytes: sum(described),
    runtimeRssBytes: sum(runtime),
    mcpRssBytes: sum(mcp),
    processes: described,
  }
}

function snapshotProcesses(): Array<Record<string, unknown>> {
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress"
  const output = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }).trim()
  if (output.length === 0) return []
  const parsed = JSON.parse(output) as unknown
  return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [parsed as Record<string, unknown>]
}

function descendants(rootPid: number, all: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  const byParent = new Map<number, Array<Record<string, unknown>>>()
  for (const processInfo of all) {
    const parent = Number(processInfo.ParentProcessId)
    const list = byParent.get(parent) ?? []
    list.push(processInfo)
    byParent.set(parent, list)
  }
  const out: Array<Record<string, unknown>> = []
  const queue = [...(byParent.get(rootPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const processInfo = queue.shift()
    if (processInfo === undefined) break
    const pid = Number(processInfo.ProcessId)
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(processInfo)
    queue.push(...(byParent.get(pid) ?? []))
  }
  return out
}

function relevantProcesses(): Array<Record<string, unknown>> {
  const runMarker = RUN_DIR
  const mcpMarker = join('src', 'mcp', 'server.ts')
  return descendants(process.pid, snapshotProcesses()).filter((processInfo) => {
    const command = String(processInfo.CommandLine ?? '')
    return command.includes(runMarker) ||
      command.includes(runMarker.split('\\').join('/')) ||
      command.includes(mcpMarker) ||
      command.includes(mcpMarker.split('\\').join('/')) ||
      command.includes('deepseek-harness')
  })
}

function describeProcess(processInfo: Record<string, unknown>): Record<string, unknown> {
  return {
    pid: Number(processInfo.ProcessId),
    ppid: Number(processInfo.ParentProcessId),
    name: processInfo.Name,
    rssBytes: Number(processInfo.WorkingSetSize ?? 0),
    commandTail: redact(String(processInfo.CommandLine ?? '')).slice(-320),
  }
}

function captureProcesses(label: string): Array<Record<string, unknown>> {
  const processes = relevantProcesses()
  const record = {
    label,
    at: now(),
    count: processes.length,
    processes: processes.map(describeProcess),
  }
  processChecks.push(record)
  return processes
}

function argFromCommand(command: string, name: string): string | undefined {
  const match = command.match(new RegExp(`--${name}(?:\\s+|=)("?)([^"\\s]+)\\1`))
  return match?.[2]
}

function validateProcessIdentities(processes: readonly Record<string, unknown>[], specs: readonly SessionSpec[]): {
  readonly mcpIdentities: readonly string[]
  readonly runtimePatches: readonly string[]
  readonly ok: boolean
} {
  const mcpIdentities = new Set<string>()
  const runtimePatches = new Set<string>()
  for (const processInfo of processes.map(describeProcess)) {
    const command = String(processInfo.commandTail ?? '')
    if (command.includes('mcp') && command.includes('server.ts')) {
      const sessionId = argFromCommand(command, 'session-id')
      const projectId = argFromCommand(command, 'project-id')
      if (sessionId !== undefined && projectId !== undefined) mcpIdentities.add(`${projectId}/${sessionId}`)
    }
    if (command.includes('--patch')) {
      const patch = argFromCommand(command, 'patch')
      if (patch !== undefined) runtimePatches.add(patch)
    }
  }
  const expected = specs.map((spec) => `${spec.projectId}/${spec.sessionId}`).sort()
  const actual = [...mcpIdentities].sort()
  const patchesOk = [...runtimePatches].every((patch) => existsSync(patch))
  return {
    mcpIdentities: actual,
    runtimePatches: [...runtimePatches],
    ok: JSON.stringify(actual) === JSON.stringify(expected) && runtimePatches.size === specs.length && patchesOk,
  }
}

async function waitForNoRelevant(timeoutMs = 15_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs
  let processes = relevantProcesses()
  while (processes.length > 0 && Date.now() < deadline) {
    await sleep(500)
    processes = relevantProcesses()
  }
  return processes
}

function walk(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  visit(root)
  return files
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function securityScanAndHashes(): Record<string, unknown> {
  const excluded = new Set(['hashes.json', 'security-scan.json'])
  const files = walk(RUN_DIR)
  const scanned: string[] = []
  const exactFiles: string[] = []
  const patternFiles: string[] = []
  let exactHits = 0
  let patternHits = 0
  let scannedBytes = 0
  let zstdFiles = 0
  let zstdDecompressed = 0
  const readErrors: string[] = []
  const decompressionErrors: string[] = []
  for (const full of files) {
    const rel = relative(RUN_DIR, full).split('\\').join('/')
    if (excluded.has(rel)) continue
    let bytes: Buffer
    try {
      bytes = readFileSync(full)
    } catch {
      readErrors.push(rel)
      continue
    }
    scannedBytes += bytes.byteLength
    let text = bytes.toString('utf8')
    if (rel.endsWith('.zstd')) {
      zstdFiles += 1
      try {
        text = zstdDecompressSync(bytes).toString('utf8')
        zstdDecompressed += 1
      } catch {
        decompressionErrors.push(rel)
      }
    }
    const exact = key.length > 0 ? text.split(key).length - 1 : 0
    const pattern = text.match(new RegExp(SK_PATTERN, 'g'))?.length ?? 0
    if (exact > 0) {
      exactHits += exact
      exactFiles.push(rel)
    }
    if (pattern > 0) {
      patternHits += pattern
      patternFiles.push(rel)
    }
    scanned.push(rel)
  }
  const generatedAt = now()
  const command = `node scripts/m2-runtime-registry/soak.ts (security scan over ${RUN_DIR})`
  const report = {
    generatedAt,
    command,
    scannedFileCount: scanned.length,
    scannedBytes,
    zstdFiles,
    zstdDecompressed,
    exactKey: { description: 'DEEPSEEK_API_KEY exact value (value not recorded)', hits: exactHits, files: exactFiles },
    skPattern: { pattern: SK_PATTERN, hits: patternHits, files: patternFiles },
    readErrors,
    decompressionErrors,
    scannedFiles: scanned,
    excluded: [...excluded],
  }
  writeFileSync(join(RUN_DIR, 'security-scan.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const hashes: Record<string, string> = {}
  for (const rel of [...scanned, 'security-scan.json'].sort()) hashes[rel] = sha256(join(RUN_DIR, rel))
  const manifest = {
    runId: RUN_ID,
    generatedAt,
    command,
    algorithm: 'sha256',
    note: 'hashes.json itself is not self-hashed',
    files: hashes,
  }
  writeFileSync(join(RUN_DIR, 'hashes.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return report
}

async function main(): Promise<number> {
  mkdirSync(RUN_DIR, { recursive: true })
  mkdirSync(RAW_DIR, { recursive: true })
  mkdirSync(WORK_DIR, { recursive: true })
  mkdirSync(DB_DIR, { recursive: true })
  mkdirSync(HOMES_DIR, { recursive: true })
  mkdirSync(PATCH_DIR, { recursive: true })
  mkdirSync(ARCHIVE_DIR, { recursive: true })

  key = readKey(SECRET_FILE)
  const specs: SessionSpec[] = [
    {
      projectId: 'proj-p1',
      sessionId: 'session-sup-1',
      role: 'supervisor',
      workingDirectory: join(WORK_DIR, 'session-sup-1'),
      forbiddenProjectId: 'proj-p2',
      databasePath: join(DB_DIR, 'proj-p1', 'cadre.sqlite'),
    },
    {
      projectId: 'proj-p1',
      sessionId: 'session-worker-1',
      role: 'worker',
      workingDirectory: join(WORK_DIR, 'session-worker-1'),
      forbiddenProjectId: 'proj-p2',
      databasePath: join(DB_DIR, 'proj-p1', 'cadre.sqlite'),
    },
    {
      projectId: 'proj-p2',
      sessionId: 'session-worker-2',
      role: 'worker',
      workingDirectory: join(WORK_DIR, 'session-worker-2'),
      forbiddenProjectId: 'proj-p1',
      databasePath: join(DB_DIR, 'proj-p2', 'cadre.sqlite'),
    },
  ]
  for (const spec of specs) mkdirSync(spec.workingDirectory, { recursive: true })

  const dbFor = (projectId: ProjectId): string => join(DB_DIR, String(projectId), 'cadre.sqlite')
  await seedProject('proj-p1', dbFor('proj-p1' as ProjectId), [
    { sessionId: 'session-sup-1', role: 'supervisor' },
    { sessionId: 'session-worker-1', role: 'worker' },
  ])
  await seedProject('proj-p2', dbFor('proj-p2' as ProjectId), [
    { sessionId: 'session-worker-2', role: 'worker' },
  ])

  registry = new SessionRuntimeRegistry({
    dshHomeBase: HOMES_DIR,
    patchDirBase: PATCH_DIR,
    patchArchiveBase: ARCHIVE_DIR,
    mcpServerPath: MCP_SERVER_PATH,
    databasePathFor: (projectId) => dbFor(projectId),
    adapterOptions: {
      env: cleanEnv(),
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      maxTokens: 512,
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: 180_000,
    },
  })
  await registry.start()

  const handles: RuntimeSessionHandle[] = []
  try {
    for (const spec of specs) {
      handles.push(await registry.createSession({
        projectId: spec.projectId as ProjectId,
        sessionId: spec.sessionId as SessionId,
        role: spec.role,
        workingDirectory: spec.workingDirectory,
      }))
    }
    log(`created ${handles.length} runtimes; soakMs=${SOAK_MS}`)

    const initialRoster: Array<Record<string, unknown>> = []
    for (const [index, handle] of handles.entries()) {
      const spec = specs[index] as SessionSpec
      const result = await rosterCheck(handle, spec.projectId, spec.forbiddenProjectId, `roster-initial-${spec.sessionId}`)
      const record = { round: 0, sessionId: spec.sessionId, projectId: spec.projectId, ok: result.ok, result: result.result }
      initialRoster.push(record)
      modelRosterResults.push(record)
      assert.equal(result.ok, true, `initial roster identity mismatch for ${spec.sessionId}`)
    }

    const initialProcesses = captureProcesses('after-initial-roster')
    const identityCheck = validateProcessIdentities(initialProcesses, specs)
    assert.equal(identityCheck.ok, true, `initial process identity mismatch: ${JSON.stringify(identityCheck)}`)
    rssSamples.push(summarizeRss('initial', 0, initialProcesses))
    const patchStart = patchSnapshot('after-create')
    const dbPaths = [...new Set(specs.map((spec) => spec.databasePath))]
    const dbStart = dbPaths.map((path) => dbSnapshot(path))
    for (const snapshot of dbStart) assertDbSnapshot(snapshot, 'start')

    const totalRounds = Number.isFinite(ROUNDS_ARG) && ROUNDS_ARG > 0
      ? Math.floor(ROUNDS_ARG)
      : Math.max(1, Math.ceil(SOAK_MS / ROUND_INTERVAL_MS))
    const midRound = Math.ceil(totalRounds / 2)
    log(`soak start rounds=${totalRounds} interval=${ROUND_INTERVAL_MS}ms directEvery=${DIRECT_ROSTER_EVERY} modelEvery=${MODEL_ROSTER_EVERY} rssEvery=${RSS_EVERY}`)
    const soakStarted = Date.now()
    let midProcesses: Array<Record<string, unknown>> = []
    let midIdentity: Record<string, unknown> = {}
    for (let round = 1; round <= totalRounds; round += 1) {
      for (const handle of handles) {
        assert.equal(await checkWorkdir(handle, round), true, `workdir mismatch round ${round}`)
      }

      if (round % DIRECT_ROSTER_EVERY === 0) {
        for (const spec of specs) {
          const result = await directRosterCheck(spec, round)
          assert.equal(result.ok, true, `direct roster identity mismatch round ${round} for ${spec.sessionId}`)
        }
      }

      if (round % MODEL_ROSTER_EVERY === 0 && round !== totalRounds) {
        for (const [index, handle] of handles.entries()) {
          const spec = specs[index] as SessionSpec
          const result = await rosterCheck(handle, spec.projectId, spec.forbiddenProjectId, `roster-mid-${spec.sessionId}-r${round}`)
          const record = { round, sessionId: spec.sessionId, projectId: spec.projectId, ok: result.ok, result: result.result }
          modelRosterResults.push(record)
          assert.equal(result.ok, true, `model roster identity mismatch round ${round} for ${spec.sessionId}`)
        }
      }

      const shouldMid = round === midRound
      if (shouldMid || round % RSS_EVERY === 0) {
        const processes = captureProcesses(shouldMid ? 'mid-soak' : `rss-round-${round}`)
        rssSamples.push(summarizeRss(shouldMid ? 'mid' : `round-${round}`, round, processes))
        const processIdentity = validateProcessIdentities(processes, specs)
        assert.equal(processIdentity.ok, true, `process identity mismatch round ${round}: ${JSON.stringify(processIdentity)}`)
        if (shouldMid) {
          midProcesses = processes
          midIdentity = processIdentity as unknown as Record<string, unknown>
        }
      }

      await sleep(ROUND_INTERVAL_MS)
    }
    const soakEnded = Date.now()
    log(`soak ended after ${soakEnded - soakStarted}ms, rounds=${totalRounds}`)

    const finalRoster: Array<Record<string, unknown>> = []
    for (const [index, handle] of handles.entries()) {
      const spec = specs[index] as SessionSpec
      const result = await rosterCheck(handle, spec.projectId, spec.forbiddenProjectId, `roster-final-${spec.sessionId}`)
      const record = { round: totalRounds, sessionId: spec.sessionId, projectId: spec.projectId, ok: result.ok, result: result.result }
      finalRoster.push(record)
      modelRosterResults.push(record)
      assert.equal(result.ok, true, `final roster identity mismatch for ${spec.sessionId}`)
    }

    const patchAfterSoak = patchSnapshot('after-soak')
    const dbEnd = dbPaths.map((path) => dbSnapshot(path))
    for (const snapshot of dbEnd) assertDbSnapshot(snapshot, 'after-soak')

    const rebuiltSessionId = 'session-worker-2' as SessionId
    const beforeRebuild = registry.getRuntime(rebuiltSessionId)
    assert.ok(beforeRebuild !== undefined)
    await registry.reclaimSession(rebuiltSessionId)
    const reclaimed = registry.getRuntime(rebuiltSessionId)
    assert.equal(reclaimed?.state, 'closed')
    assert.equal(reclaimed?.archivedPatchPaths.length, 1)
    const rebuilt = await registry.rebuildSession(rebuiltSessionId)
    const rebuiltRecord = registry.getRuntime(rebuiltSessionId)
    assert.ok(rebuiltRecord !== undefined)
    const rebuildHandle: RuntimeSessionHandle = { session: rebuilt, record: rebuiltRecord as never }
    const rebuildRoster = await rosterCheck(rebuildHandle, 'proj-p2', 'proj-p1', 'roster-after-rebuild')
    assert.equal(rebuildRoster.ok, true, 'roster identity mismatch after rebuild')
    const rebuiltAfter = registry.getRuntime(rebuiltSessionId)

    const beforeStop = registry.listRuntimes()
    const patchSamples = beforeStop.map((record) => ({
      sessionId: record.sessionId,
      role: record.role,
      patchPaths: record.patchPaths,
      identity: existsSync(record.patchPaths[0] ?? '') ? readFileSync(record.patchPaths[0] ?? '', 'utf8') : null,
      supervisor: record.patchPaths[1] !== undefined && existsSync(record.patchPaths[1])
        ? readFileSync(record.patchPaths[1], 'utf8')
        : null,
    }))

    await registry.stop()
    registryStopped = true
    const afterStop = registry.listRuntimes()
    assert.equal(afterStop.length, 3)
    assert.equal(afterStop.every((record) => record.state === 'closed'), true)
    for (const record of afterStop) {
      assert.ok(record.archivedPatchPaths.length >= 1, `no archived patch for ${record.sessionId}`)
      for (const archived of record.archivedPatchPaths) assert.equal(existsSync(archived), true)
      if (existsSync(record.patchDir)) {
        for (const name of readdirSync(record.patchDir)) {
          assert.equal(name.endsWith('.cordis.yml'), false, `active patch survived stop: ${join(record.patchDir, name)}`)
        }
      }
    }

    const patchAfterStop = patchSnapshot('after-stop')
    const dbAfterStop = dbPaths.map((path) => dbSnapshot(path))
    for (const snapshot of dbAfterStop) assertDbSnapshot(snapshot, 'after-stop')

    let residual = await waitForNoRelevant(15_000)
    const killedResidualPids: number[] = []
    if (residual.length > 0) {
      for (const processInfo of residual) {
        try {
          execFileSync('taskkill', ['/PID', String(processInfo.ProcessId), '/T', '/F'], { windowsHide: true, timeout: 15_000 })
          killedResidualPids.push(Number(processInfo.ProcessId))
        } catch {
          // 记录后继续。
        }
      }
      await sleep(1_000)
      residual = relevantProcesses()
    }
    captureProcesses('final')
    assert.equal(residual.length, 0, `residual processes: ${JSON.stringify(residual.map(describeProcess))}`)

    const rssNonZero = rssSamples.filter((item) => Number(item.count ?? 0) > 0)
    const summary = {
      runId: RUN_ID,
      startedAt: STARTED_AT,
      finishedAt: now(),
      node: process.version,
      model: 'deepseek-flash',
      requestedRounds: totalRounds,
      roundIntervalMs: ROUND_INTERVAL_MS,
      directRosterEvery: DIRECT_ROSTER_EVERY,
      modelRosterEvery: MODEL_ROSTER_EVERY,
      rssEvery: RSS_EVERY,
      soakMs: soakEnded - soakStarted,
      soakRounds: totalRounds,
      specs,
      initialProcessIdentity: identityCheck,
      midProcessIdentity: midIdentity,
      midProcessCount: midProcesses.length,
      initialRoster,
      finalRoster,
      modelRoster: {
        count: modelRosterResults.length,
        okCount: modelRosterResults.filter((item) => item.ok === true).length,
        results: modelRosterResults,
      },
      directRoster: {
        count: directRosterResults.length,
        okCount: directRosterResults.filter((item) => item.ok === true).length,
        failures: directRosterResults.filter((item) => item.ok !== true),
      },
      rebuild: {
        sessionId: 'session-worker-2',
        before: beforeRebuild,
        reclaimed,
        after: rebuiltAfter,
        rosterOk: rebuildRoster.ok,
        roster: rebuildRoster.result,
      },
      patchSamples,
      beforeStop,
      afterStop,
      processChecks,
      processTimeline: 'process-timeline.json',
      db: {
        start: dbStart,
        afterSoak: dbEnd,
        afterStop: dbAfterStop,
        note: 'direct/tool startup may write schema_meta; project tables tasks/messages/task_events/idempotency must stay 0 and members must stay project-local',
      },
      patchSnapshots: { start: patchStart, afterSoak: patchAfterSoak, afterStop: patchAfterStop },
      rss: {
        samples: rssSamples,
        initialTotalRssBytes: rssNonZero[0]?.totalRssBytes ?? 0,
        lastRunningTotalRssBytes: rssNonZero[rssNonZero.length - 1]?.totalRssBytes ?? 0,
        peakTotalRssBytes: rssNonZero.reduce((peak, item) => Math.max(peak, Number(item.totalRssBytes ?? 0)), 0),
      },
      runs: { count: runs.length, totalMs: runs.reduce((sum, item) => sum + Number(item.ms ?? 0), 0), details: runs },
      workdir: { rounds: workdirRounds, allOk: workdirRounds.every((item) => item.ok === true) },
      residual: { count: residual.length, killedResidualPids },
      evidence: {
        raw: 'raw/',
        patches: 'patches/',
        patchArchive: 'patch-archive/',
        dbs: 'dbs/',
        homes: 'homes/',
        directRoster: 'direct-roster.json',
        modelRoster: 'model-roster.json',
        processTimeline: 'process-timeline.json',
        dbChecks: 'db-checks.json',
        patchSnapshots: 'patch-snapshots.json',
        rss: 'rss.json',
        securityScan: 'security-scan.json',
        hashes: 'hashes.json',
      },
      unverified: [
        'patch 高频并发回收压测未做（本单仅 3 实例并发 stop）。',
        'MCP 真崩溃/自动重连由 P2 单独脚本验证；本 soak 未做。',
        'supervisor patch 的写/执行拦截沿用 S8 行为证据，本 soak 未重复尝试 write/shell。',
        '只测 Windows + sdk profile。',
      ],
    }
    writeJson(join(RUN_DIR, 'direct-roster.json'), { results: directRosterResults })
    writeJson(join(RUN_DIR, 'model-roster.json'), { results: modelRosterResults })
    writeJson(join(RUN_DIR, 'process-timeline.json'), { checks: processChecks })
    writeJson(join(RUN_DIR, 'db-checks.json'), { start: dbStart, afterSoak: dbEnd, afterStop: dbAfterStop })
    writeJson(join(RUN_DIR, 'patch-snapshots.json'), { start: patchStart, afterSoak: patchAfterSoak, afterStop: patchAfterStop })
    writeJson(join(RUN_DIR, 'rss.json'), { samples: rssSamples })
    writeJson(join(RUN_DIR, 'direct-roster.json'), { results: directRosterResults })
    writeJson(join(RUN_DIR, 'model-roster.json'), { results: modelRosterResults })
    writeJson(join(RUN_DIR, 'process-timeline.json'), { checks: processChecks })
    writeJson(join(RUN_DIR, 'rss.json'), { samples: rssSamples })
    writeFileSync(join(RUN_DIR, 'run.log'), `${redact(runLog.join('\n'))}\n`, 'utf8')
    writeJson(join(RUN_DIR, 'summary.json'), summary)
    const security = securityScanAndHashes() as {
      exactKey: { hits: number }; skPattern: { hits: number }; scannedFileCount: number
    }
    log(`security exact=${security.exactKey.hits} pattern=${security.skPattern.hits} files=${security.scannedFileCount}`)
    console.log(JSON.stringify({
      runId: RUN_ID,
      runDir: RUN_DIR,
      soakMs: summary.soakMs,
      soakRounds: summary.soakRounds,
      runs: summary.runs.count,
      directRoster: { count: summary.directRoster.count, okCount: summary.directRoster.okCount, failures: summary.directRoster.failures.length },
      modelRoster: { count: summary.modelRoster.count, okCount: summary.modelRoster.okCount },
      workdirAllOk: summary.workdir.allOk,
      db: {
        startZero: summary.db.start.every((item) => {
          const counts = item.counts as Record<string, unknown>
          return ['tasks', 'messages', 'task_events', 'idempotency'].every((table) => counts[table] === 0)
        }),
        afterStopZero: summary.db.afterStop.every((item) => {
          const counts = item.counts as Record<string, unknown>
          return ['tasks', 'messages', 'task_events', 'idempotency'].every((table) => counts[table] === 0)
        }),
      },
      rss: { initial: summary.rss.initialTotalRssBytes, last: summary.rss.lastRunningTotalRssBytes, peak: summary.rss.peakTotalRssBytes },
      identities: {
        initial: identityCheck.mcpIdentities,
        mid: midIdentity.mcpIdentities,
        runtimes: identityCheck.runtimePatches,
      },
      roster: { initial: initialRoster.map((item) => item.ok), final: finalRoster.map((item) => item.ok) },
      rebuild: summary.rebuild.rosterOk,
      residual: residual.length,
      patchesArchived: afterStop.map((record) => [record.sessionId, record.archivedPatchPaths.length]),
      security: { exact: security.exactKey.hits, pattern: security.skPattern.hits, files: security.scannedFileCount },
    }, null, 2))
    return 0
  } catch (error) {
    log(`FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    try {
      if (registry !== undefined && !registryStopped) {
        await registry.stop()
        registryStopped = true
      }
    } catch (stopError) {
      log(`stop after failure also failed: ${String(stopError)}`)
    }
    writeFileSync(join(RUN_DIR, 'run.log'), `${redact(runLog.join('\n'))}\n`, 'utf8')
    writeJson(join(RUN_DIR, 'summary.json'), {
      runId: RUN_ID,
      failed: true,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      specs,
      runs: { count: runs.length, totalMs: runs.reduce((sum, item) => sum + Number(item.ms ?? 0), 0), details: runs },
      processChecks,
      workdirRounds,
      evidence: { securityScan: 'security-scan.json', hashes: 'hashes.json' },
    })
    const security = securityScanAndHashes() as {
      exactKey: { hits: number }; skPattern: { hits: number }; scannedFileCount: number
    }
    console.error(JSON.stringify({ failed: true, error: String(error), runDir: RUN_DIR, security }))
    return 1
  }
}

process.exitCode = await main()

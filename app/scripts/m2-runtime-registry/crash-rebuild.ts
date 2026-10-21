/**
 * P2：MCP server 真崩溃 → 显式失败 → 注册表 rebuild 恢复。
 *
 * 独立脚本，不进 node:test。流程：
 * 1. 单会话（worker）启动，基线 roster/workdir；
 * 2. 按命令行 `mcp/server.ts` + 本会话 sessionId 定位 MCP PID，taskkill /T /F；
 * 3. 等待并检查是否自动重启（reconnect.enabled=false，若出现新 PID 即设计不符并停止）；
 * 4. 通过会话模型调用工具，要求出现结构化失败（tool.result ok=false 或 session.error）；
 * 5. 调用 registry.rebuildSession；若因 state=ready 早退未恢复，则记录并按显式 reclaim+rebuild 完成恢复验证；
 * 6. 重建后 roster/workdir/身份；stop 后残留、patch 归档、DB/密钥证据。
 *
 * 凭据只从 .secrets/deepseek.env 读入 env；不打印、不进 argv、不落日志。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import type { EngineError, EngineEvent, EngineSession } from '../../src/ports/engine.ts'
import {
  SessionRuntimeRegistry,
  type RuntimeSessionHandle,
} from '../../src/runtime/session-runtime-registry.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = resolve(SCRIPT_DIR, '../..')
const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const OUT_ROOT = 'D:\\xxw_p\\cadre-spike-env\\s10-m2-soak'
const MCP_SERVER_PATH = join(APP_ROOT, 'src', 'mcp', 'server.ts')
const RUN_ID = `crash-${new Date().toISOString().replace(/[:.]/g, '-')}`
const RUN_DIR = join(OUT_ROOT, RUN_ID)
const RAW_DIR = join(RUN_DIR, 'raw')
const DB_DIR = join(RUN_DIR, 'dbs')
const HOMES_DIR = join(RUN_DIR, 'homes')
const PATCH_DIR = join(RUN_DIR, 'patches')
const ARCHIVE_DIR = join(RUN_DIR, 'patch-archive')
const WORK_DIR = join(RUN_DIR, 'work')
const SESSION_ID = 'session-crash' as SessionId
const PROJECT_ID = 'proj-crash' as ProjectId
const DB_PATH = join(DB_DIR, String(PROJECT_ID), 'cadre.sqlite')
const SK_PATTERN = 'sk-[A-Za-z0-9_-]{6,}'

const timeline: Array<Record<string, unknown>> = []
const runs: Array<Record<string, unknown>> = []
const runLog: string[] = []
let key = ''
let registry: SessionRuntimeRegistry | undefined
let registryStopped = false

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
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
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

function event(label: string, extra: Record<string, unknown> = {}): void {
  const record = { at: new Date().toISOString(), label, ...extra }
  timeline.push(record)
  log(`[${label}] ${JSON.stringify(redactDeep(extra)).slice(0, 900)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function now(): string {
  return new Date().toISOString()
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

function describeProcess(processInfo: Record<string, unknown>): Record<string, unknown> {
  return {
    pid: Number(processInfo.ProcessId),
    ppid: Number(processInfo.ParentProcessId),
    name: processInfo.Name,
    rssBytes: Number(processInfo.WorkingSetSize ?? 0),
    commandTail: redact(String(processInfo.CommandLine ?? '')).slice(-400),
  }
}

function crashProcesses(): Array<Record<string, unknown>> {
  const marker = join('src', 'mcp', 'server.ts')
  return descendants(process.pid, snapshotProcesses()).filter((processInfo) => {
    const command = String(processInfo.CommandLine ?? '')
    return command.includes(RUN_DIR) ||
      command.includes(RUN_DIR.split('\\').join('/')) ||
      command.includes(marker) ||
      command.includes(marker.split('\\').join('/')) ||
      command.includes('deepseek-harness')
  })
}

function captureProcesses(label: string): Array<Record<string, unknown>> {
  const processes = crashProcesses()
  const record = {
    at: now(),
    label,
    count: processes.length,
    mcpPids: processes.filter((item) => String(item.CommandLine ?? '').includes('mcp/server.ts') || String(item.CommandLine ?? '').includes('mcp\\server.ts')).map((item) => Number(item.ProcessId)),
    processes: processes.map(describeProcess),
  }
  timeline.push(record)
  return processes
}

function currentMcpPids(): number[] {
  return crashProcesses()
    .filter((processInfo) => {
      const command = String(processInfo.CommandLine ?? '')
      return (command.includes('mcp/server.ts') || command.includes('mcp\\server.ts')) &&
        command.includes(`--session-id ${String(SESSION_ID)}`)
    })
    .map((processInfo) => Number(processInfo.ProcessId))
}

function runtimePids(): number[] {
  return crashProcesses()
    .filter((processInfo) => String(processInfo.CommandLine ?? '').includes('deepseek-harness'))
    .map((processInfo) => Number(processInfo.ProcessId))
}

function eventToolCalls(events: readonly EngineEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((item): item is Extract<EngineEvent, { kind: 'tool.call' }> => item.kind === 'tool.call')
    .map((item) => ({ toolName: item.toolName, callId: item.callId, summary: item.summary }))
}

function eventToolResults(events: readonly EngineEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((item): item is Extract<EngineEvent, { kind: 'tool.result' }> => item.kind === 'tool.result')
    .map((item) => ({ toolName: item.toolName, callId: item.callId, ok: item.ok, summary: item.summary }))
}

async function runPrompt(session: EngineSession, label: string, prompt: string): Promise<{
  readonly events: readonly EngineEvent[]
  readonly toolCalls: Array<Record<string, unknown>>
  readonly toolResults: Array<Record<string, unknown>>
  readonly sessionErrors: readonly EngineError[]
  readonly finalResponse: string
  readonly ms: number
  readonly timedOut: boolean
}> {
  const started = Date.now()
  const events: EngineEvent[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    for await (const item of session.send(prompt, { signal: controller.signal })) events.push(item)
  } finally {
    clearTimeout(timer)
  }
  const finalResponse = events
    .filter((item): item is Extract<EngineEvent, { kind: 'message.complete' }> => item.kind === 'message.complete')
    .map((item) => item.text)
    .join('')
  const record = {
    label,
    ms: Date.now() - started,
    timedOut: controller.signal.aborted,
    toolCalls: eventToolCalls(events),
    toolResults: eventToolResults(events),
    sessionErrors: events.filter((item) => item.kind === 'session.error').map((item) => item.error),
    finalResponse: redact(finalResponse).slice(0, 2000),
  }
  runs.push(record)
  writeJson(join(RAW_DIR, `${label}.json`), record)
  log(`[${label}] ${record.ms}ms calls=${record.toolCalls.length} results=${record.toolResults.length} errors=${record.sessionErrors.length} timeout=${record.timedOut}`)
  return { ...record, events }
}

async function rosterCheck(handle: RuntimeSessionHandle, label: string): Promise<{
  readonly ok: boolean
  readonly result: Record<string, unknown> | undefined
}> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = await runPrompt(
      handle.session,
      `${label}-${String(attempt)}`,
      'Call the MCP tool mcp__cadre__list_roster exactly once with arguments {"scope":"project"}. Do not use any other tool. After it returns, reply DONE.',
    )
    const result = run.toolResults.find((item) => item.toolName === 'mcp__cadre__list_roster')
    if (result !== undefined) {
      const summary = String(result.summary ?? '')
      const ok = result.ok === true && summary.includes(String(PROJECT_ID))
      return { ok, result }
    }
    if (run.timedOut) break
  }
  return { ok: false, result: undefined }
}

function killPids(pids: readonly number[]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []
  for (const pid of pids) {
    const started = Date.now()
    try {
      const output = execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      })
      results.push({ pid, method: 'taskkill /T /F', signal: 'SIGKILL (TerminateProcess)', exitCode: 0, ms: Date.now() - started, output: redact(output).trim().slice(0, 500) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      let fallback: string | undefined
      try {
        process.kill(pid, 'SIGKILL')
        fallback = 'process.kill(SIGKILL) ok'
      } catch (fallbackError) {
        fallback = redact(fallbackError).slice(0, 300)
      }
      results.push({ pid, method: 'taskkill /T /F', signal: 'SIGKILL (TerminateProcess)', exitCode: -1, ms: Date.now() - started, error: redact(message).slice(0, 500), fallback })
    }
  }
  return results
}

function dbSnapshot(): Record<string, unknown> {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    const tables = ['projects', 'members', 'tasks', 'messages', 'task_events', 'idempotency']
    const counts: Record<string, unknown> = {}
    const projectIds: Record<string, unknown> = {}
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown }
      counts[table] = Number(row.n ?? 0)
      const rows = db.prepare(`SELECT DISTINCT project_id FROM ${table}`).all() as Array<{ project_id?: unknown }>
      projectIds[table] = rows.map((item) => String(item.project_id)).sort()
    }
    return { path: DB_PATH, at: now(), counts, projectIds }
  } finally {
    db.close()
  }
}

function assertDb(snapshot: Record<string, unknown>, label: string): void {
  const counts = snapshot.counts as Record<string, unknown>
  for (const table of ['tasks', 'messages', 'task_events', 'idempotency']) {
    assert.equal(counts[table], 0, `${label}: unexpected ${table} rows`)
  }
  assert.deepEqual((snapshot.projectIds as Record<string, unknown>).members, [String(PROJECT_ID)])
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

function patchSnapshot(label: string): Record<string, unknown> {
  const describe = (root: string): Array<Record<string, unknown>> => {
    if (!existsSync(root)) return []
    return walk(root).map((full) => ({
      path: relative(root, full).split('\\').join('/'),
      sha256: sha256(full),
      bytes: readFileSync(full).byteLength,
    }))
  }
  return { label, at: now(), active: describe(PATCH_DIR), archived: describe(ARCHIVE_DIR) }
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
  const report = {
    generatedAt,
    command: `node scripts/m2-runtime-registry/crash-rebuild.ts (security scan over ${RUN_DIR})`,
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
  writeFileSync(join(RUN_DIR, 'hashes.json'), `${JSON.stringify({
    runId: RUN_ID,
    generatedAt,
    algorithm: 'sha256',
    note: 'hashes.json itself is not self-hashed',
    files: hashes,
  }, null, 2)}\n`, 'utf8')
  return report
}

async function waitForNoMcp(timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let pids = currentMcpPids()
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(250)
    pids = currentMcpPids()
  }
  return pids
}

async function main(): Promise<number> {
  for (const dir of [RUN_DIR, RAW_DIR, DB_DIR, HOMES_DIR, PATCH_DIR, ARCHIVE_DIR, WORK_DIR]) mkdirSync(dir, { recursive: true })
  key = readKey(SECRET_FILE)
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const store = new SqliteCollabStore({ databasePath: DB_PATH })
  try {
    store.addMember({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      role: 'worker',
      state: 'available',
      displayName: 'crash-worker',
    })
  } finally {
    store.close()
  }
  mkdirSync(join(WORK_DIR, String(SESSION_ID)), { recursive: true })
  const dbStart = dbSnapshot()
  assertDb(dbStart, 'start')

  registry = new SessionRuntimeRegistry({
    dshHomeBase: HOMES_DIR,
    patchDirBase: PATCH_DIR,
    patchArchiveBase: ARCHIVE_DIR,
    mcpServerPath: MCP_SERVER_PATH,
    databasePathFor: () => DB_PATH,
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
  const handle = await registry.createSession({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    role: 'worker',
    workingDirectory: join(WORK_DIR, String(SESSION_ID)),
  })
  const patchStart = patchSnapshot('after-create')
  const baselineProcesses = captureProcesses('baseline')
  const baselineMcpPids = currentMcpPids()
  const baselineRuntimePids = runtimePids()
  if (baselineMcpPids.length === 0) throw new Error('baseline MCP server PID not found')
  event('baseline', { mcpPids: baselineMcpPids, runtimePids: baselineRuntimePids })

  const baselineRoster = await rosterCheck(handle, 'baseline-roster')
  assert.equal(baselineRoster.ok, true, 'baseline roster failed')
  const baselineWorkdir = await handle.session.getWorkingDirectory()
  event('baseline-ok', { rosterOk: baselineRoster.ok, workingDirectory: baselineWorkdir })

  event('kill-start', { pids: baselineMcpPids, method: 'taskkill /T /F', signal: 'SIGKILL/TerminateProcess' })
  const killResults = killPids(baselineMcpPids)
  event('kill-end', { results: killResults })
  const killed = new Set(baselineMcpPids)
  await sleep(1_000)
  captureProcesses('after-kill-1s')
  const afterKill1 = currentMcpPids()
  const autoRestart1 = afterKill1.filter((pid) => !killed.has(pid))
  await sleep(4_000)
  captureProcesses('after-kill-5s')
  const afterKill5 = currentMcpPids()
  const autoRestart5 = afterKill5.filter((pid) => !killed.has(pid))
  const killLingering = afterKill5.filter((pid) => killed.has(pid))
  event('auto-restart-check', {
    after1s: afterKill1,
    after5s: afterKill5,
    newPids: [...autoRestart1, ...autoRestart5],
    lingeringPids: killLingering,
    autoRestart: autoRestart1.length > 0 || autoRestart5.length > 0,
  })

  const postKillRun = await runPrompt(
    handle.session,
    'post-kill-tool',
    'Call the MCP tool mcp__cadre__list_roster exactly once with arguments {"scope":"project"}. If the tool is unavailable or fails, report the exact error text. Do not use any other tool.',
  )
  const postKillMcp = currentMcpPids()
  const autoRestartAfterTool = postKillMcp.filter((pid) => !killed.has(pid))
  const postKillStructured = postKillRun.sessionErrors.length > 0 ||
    postKillRun.toolResults.some((item) => String(item.toolName ?? '').includes('list_roster') && item.ok === false)
  const postKillSilentSuccess = postKillRun.toolResults.some((item) => String(item.toolName ?? '').includes('list_roster') && item.ok === true)
  event('post-kill-tool', {
    structuredFailure: postKillStructured,
    silentSuccess: postKillSilentSuccess,
    sessionErrors: postKillRun.sessionErrors,
    toolResults: postKillRun.toolResults,
    finalResponse: postKillRun.finalResponse,
    mcpPids: postKillMcp,
    newPids: autoRestartAfterTool,
  })
  if (autoRestart1.length > 0 || autoRestart5.length > 0 || autoRestartAfterTool.length > 0) {
    log('DESIGN MISMATCH: MCP restarted despite reconnect.enabled=false; stopping per task instruction')
    await registry.stop()
    registryStopped = true
    return writeAndExit(true, {
      autoRestart: [...afterKill1, ...afterKill5, ...autoRestartAfterTool],
      killResults,
      postKillRun,
      postKillStructured,
      postKillSilentSuccess,
    })
  }

  const workdirAfterKill = await handle.session.getWorkingDirectory()
  const stateBeforeRebuild = registry.getRuntime(SESSION_ID)
  const sessionBeforeRebuild = registry.getSession(SESSION_ID)
  event('before-rebuild', { state: stateBeforeRebuild?.state, workdir: workdirAfterKill, mcpPids: currentMcpPids() })

  let recoveredSession: EngineSession | undefined
  let singleRebuild: Record<string, unknown> | undefined
  let forcedRecovery: Record<string, unknown> | undefined
  try {
    const singleStart = Date.now()
    const singleSession = await registry.rebuildSession(SESSION_ID)
    const singleMs = Date.now() - singleStart
    const singleMcp = currentMcpPids()
    singleRebuild = {
      ms: singleMs,
      reusedExisting: singleSession === sessionBeforeRebuild,
      mcpPids: singleMcp,
      state: registry.getRuntime(SESSION_ID)?.state,
    }
    event('rebuild-single', singleRebuild)
    if (singleSession !== sessionBeforeRebuild && singleMcp.length > 0) {
      recoveredSession = singleSession
    }
  } catch (error) {
    singleRebuild = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    event('rebuild-single-error', singleRebuild)
  }

  if (recoveredSession === undefined) {
    try {
      const reclaimStart = Date.now()
      await registry.reclaimSession(SESSION_ID)
      const reclaimMs = Date.now() - reclaimStart
      const forcedStart = Date.now()
      const forcedSession = await registry.rebuildSession(SESSION_ID)
      const forcedMs = Date.now() - forcedStart
      const forcedMcp = currentMcpPids()
      forcedRecovery = { reclaimMs, rebuildMs: forcedMs, mcpPids: forcedMcp, state: registry.getRuntime(SESSION_ID)?.state }
      event('rebuild-reclaim-then-rebuild', forcedRecovery)
      if (forcedMcp.length > 0) recoveredSession = forcedSession
    } catch (error) {
      forcedRecovery = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
      event('rebuild-forced-error', forcedRecovery)
    }
  }
  if (recoveredSession === undefined) throw new Error('rebuild did not recover an MCP-backed session')
  const handleAfter: RuntimeSessionHandle = {
    session: recoveredSession,
    record: registry.getRuntime(SESSION_ID) as never,
  }
  const rebuiltRoster = await rosterCheck(handleAfter, 'after-rebuild-roster')
  const rebuiltWorkdir = await handleAfter.session.getWorkingDirectory()
  const rebuiltSetDir = join(WORK_DIR, String(SESSION_ID), 'after-rebuild')
  mkdirSync(rebuiltSetDir, { recursive: true })
  await handleAfter.session.setWorkingDirectory(rebuiltSetDir)
  const rebuiltSetActual = await handleAfter.session.getWorkingDirectory()
  const rebuiltProcesses = captureProcesses('after-rebuild')
  event('after-rebuild-ok', {
    rosterOk: rebuiltRoster.ok,
    roster: rebuiltRoster.result,
    workdirBefore: rebuiltWorkdir,
    workdirSet: rebuiltSetActual,
    mcpPids: currentMcpPids(),
    runtimePids: runtimePids(),
  })
  assert.equal(rebuiltRoster.ok, true, 'roster failed after rebuild')
  assert.equal(resolve(rebuiltSetActual).toLowerCase(), resolve(rebuiltSetDir).toLowerCase(), 'workdir set/get failed after rebuild')

  await registry.stop()
  registryStopped = true
  const afterStop = registry.listRuntimes()
  const patchAfterStop = patchSnapshot('after-stop')
  const dbAfterStop = dbSnapshot()
  assertDb(dbAfterStop, 'after-stop')
  const residual = await waitForNoMcp(15_000)
  captureProcesses('final')
  const finalProcesses = crashProcesses()
  const states = afterStop.map((record) => ({ sessionId: record.sessionId, state: record.state, archived: record.archivedPatchPaths, patchDir: record.patchDir }))
  const patchActive = (patchAfterStop.active as Array<Record<string, unknown>> | undefined) ?? []
  const activeSurvivors = patchActive.filter((item) => String(item.path).endsWith('.cordis.yml'))
  return writeAndExit(
    residual.length > 0 || !postKillStructured || postKillSilentSuccess || killLingering.length > 0 ||
      activeSurvivors.length > 0 || finalProcesses.length > 0,
    {
      killResults,
      killLingering,
      baselineRoster,
      baselineWorkdir,
      postKillRun,
      postKillStructured,
      postKillSilentSuccess,
      singleRebuild,
      forcedRecovery,
      rebuiltRoster,
      rebuiltWorkdir,
      rebuiltSetActual,
      rebuiltProcesses,
      afterStop,
      states,
      patchStart,
      patchAfterStop,
      dbStart,
      dbAfterStop,
      residual,
      finalProcesses,
    },
  )
}

async function writeAndExit(failed: boolean, details: Record<string, unknown>): Promise<number> {
  const single = details.singleRebuild as Record<string, unknown> | undefined
  const singleMcp = Array.isArray(single?.mcpPids) ? single.mcpPids as unknown[] : []
  const singleRebuildRestored = singleMcp.length > 0 && single?.reusedExisting !== true
  const recoveryPath = details.forcedRecovery === undefined ? 'single' : 'reclaim+rebuild'
  const summary = {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    databasePath: DB_PATH,
    startedAt: timeline[0]?.at ?? now(),
    finishedAt: now(),
    node: process.version,
    model: 'deepseek-flash',
    failed,
    requirementMetBySingleRebuild: singleRebuildRestored,
    recoveryPath,
    finding: singleRebuildRestored
      ? null
      : 'single rebuildSession early-returned with state=ready and did not restart MCP; explicit reclaim+rebuild was required',
    autoRestart: (details.autoRestart as unknown[] | undefined)?.length ? details.autoRestart : [],
    kill: { results: details.killResults, lingeringPids: details.killLingering ?? [] },
    baseline: { roster: details.baselineRoster, workingDirectory: details.baselineWorkdir },
    postKill: {
      structuredFailure: details.postKillStructured,
      silentSuccess: details.postKillSilentSuccess,
      run: details.postKillRun,
    },
    rebuild: {
      single: details.singleRebuild,
      singleRebuildRestored,
      recoveryPath,
      finding: singleRebuildRestored ? null : 'single rebuildSession early-returned; reclaim+rebuild used',
      forcedRecovery: details.forcedRecovery,
      roster: details.rebuiltRoster,
      workdirBefore: details.rebuiltWorkdir,
      workdirAfter: details.rebuiltSetActual,
    },
    stop: {
      states: details.states,
      residual: details.residual,
      finalProcessCount: (details.finalProcesses as unknown[] | undefined)?.length ?? 0,
    },
    patches: {
      start: details.patchStart,
      afterStop: details.patchAfterStop,
    },
    db: { start: details.dbStart, afterStop: details.dbAfterStop },
    timeline,
    runs: { count: runs.length, totalMs: runs.reduce((sum, item) => sum + Number(item.ms ?? 0), 0), details: runs },
    evidence: {
      raw: 'raw/',
      processTimeline: 'timeline.json',
      patches: 'patches/',
      patchArchive: 'patch-archive/',
      dbs: 'dbs/',
      homes: 'homes/',
      securityScan: 'security-scan.json',
      hashes: 'hashes.json',
    },
    unverified: [
      '只测单个 worker 会话 + Windows + sdk profile。',
      'reconnect.enabled=false；未测配置改为 true 的行为。',
      '未做 30min 崩溃后长时间稳定性；重建后只做一次 roster/workdir 验证。',
    ],
  }
  writeFileSync(join(RUN_DIR, 'run.log'), `${redact(runLog.join('\n'))}\n`, 'utf8')
  writeJson(join(RUN_DIR, 'timeline.json'), timeline)
  writeJson(join(RUN_DIR, 'summary.json'), summary)
  const security = securityScanAndHashes() as { exactKey: { hits: number }; skPattern: { hits: number }; scannedFileCount: number }
  log(`security exact=${security.exactKey.hits} pattern=${security.skPattern.hits} files=${security.scannedFileCount}`)
  console.log(JSON.stringify({
    runId: RUN_ID,
    runDir: RUN_DIR,
    failed,
    requirementMetBySingleRebuild: summary.requirementMetBySingleRebuild,
    recoveryPath: summary.recoveryPath,
    postKillStructured: details.postKillStructured,
    postKillSilentSuccess: details.postKillSilentSuccess,
    autoRestart: summary.autoRestart,
    rebuild: summary.rebuild,
    stop: summary.stop,
    runs: summary.runs,
    security: { exact: security.exactKey.hits, pattern: security.skPattern.hits, files: security.scannedFileCount },
  }, null, 2))
  return failed ? 1 : 0
}

process.exitCode = await main().catch(async (error: unknown) => {
  log(`FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  if (registry !== undefined && !registryStopped) {
    try {
      await registry.stop()
      registryStopped = true
    } catch (stopError) {
      log(`stop after failure also failed: ${String(stopError)}`)
    }
  }
  try {
    return await writeAndExit(true, {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  } catch (writeError) {
    console.error(String(writeError))
    return 1
  }
})

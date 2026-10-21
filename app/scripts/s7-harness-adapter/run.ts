/**
 * S7 HarnessAdapter 独立冒烟（不进入 node --test，不进 CI 常规测试）。
 *
 * 凭据只从 D:\xxw_p\cadre-spike-env\.secrets\deepseek.env 读入子进程环境；
 * 不打印、不进 argv、不写入产物。模型调用最多 1 次。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessAdapter } from '../../src/adapters/engine/harness/index.ts'
import type { EngineError, EngineEvent } from '../../src/ports/engine.ts'

const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const OUT_ROOT = 'D:\\xxw_p\\cadre-spike-env\\s7-harness-adapter'
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const OUT_DIR = join(OUT_ROOT, RUN_ID)
const HOMES = join(OUT_DIR, 'homes')
const WORK = join(OUT_DIR, 'work')

interface ProcessInfo {
  ProcessId: number
  ParentProcessId: number
  Name: string
  CommandLine?: string
  WorkingSetSize?: number
}

function readKey(file: string): string {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match?.[1] !== 'DEEPSEEK_API_KEY') continue
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (value.length < 10) throw new Error('DEEPSEEK_API_KEY too short')
    return value
  }
  throw new Error('DEEPSEEK_API_KEY not found in secret file')
}

function cleanEnv(key: string): NodeJS.ProcessEnv {
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

function redact(value: string, key: string): string {
  let text = value
  if (key.length > 0) text = text.split(key).join('[REDACTED]')
  return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
}

function redactDeep(value: unknown, key: string): unknown {
  if (typeof value === 'string') return redact(value, key)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, key)]))
  }
  return value
}

function writeJson(file: string, value: unknown, key: string): void {
  writeFileSync(file, `${JSON.stringify(redactDeep(value, key), null, 2)}\n`, 'utf8')
}

function snapshotProcesses(): ProcessInfo[] {
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress"
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }).trim()
  if (raw.length === 0) return []
  const parsed = JSON.parse(raw) as ProcessInfo | ProcessInfo[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function descendantsOf(rootPid: number, all: ProcessInfo[]): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>()
  for (const process of all) {
    const parent = Number(process.ParentProcessId)
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push(process)
  }
  const out: ProcessInfo[] = []
  const queue = [...(byParent.get(rootPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const process = queue.shift()!
    if (seen.has(process.ProcessId)) continue
    seen.add(process.ProcessId)
    out.push(process)
    queue.push(...(byParent.get(process.ProcessId) ?? []))
  }
  return out
}

function runtimeProcesses(rootPid: number, all: ProcessInfo[]): ProcessInfo[] {
  return descendantsOf(rootPid, all).filter(
    (process) => /node(\.exe)?$/i.test(String(process.Name)) && /dsh|deepseek-harness/i.test(String(process.CommandLine ?? '')),
  )
}

function describe(process: ProcessInfo): Record<string, unknown> {
  return {
    pid: Number(process.ProcessId),
    ppid: Number(process.ParentProcessId),
    name: process.Name,
    workingSetMB: Math.round(Number(process.WorkingSetSize ?? 0) / 1048576 * 10) / 10,
    cmdTail: String(process.CommandLine ?? '').slice(-220),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function collect(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function eventTexts(events: EngineEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'message.delta' || event.kind === 'message.complete')
    .map((event) => event.kind === 'message.complete' ? event.text : '')
    .filter((text) => text.length > 0)
}

function errorInfo(error: unknown, key: string): { name: string; code: string | null; message: string } {
  const record = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown; message?: unknown } : undefined
  return {
    name: typeof record?.name === 'string' ? record.name : 'Error',
    code: typeof record?.code === 'string' ? record.code : null,
    message: redact(typeof record?.message === 'string' ? record.message : String(error), key),
  }
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(HOMES, { recursive: true })
  mkdirSync(WORK, { recursive: true })

  const startedAt = new Date().toISOString()
  const log: string[] = []
  const diagnostics: unknown[] = []
  const sessionResults: Array<Record<string, unknown>> = []
  let key = ''
  let lifecycleOk = false
  let stopError: string | null = null
  let preStop: ProcessInfo[] = []
  let postStop: ProcessInfo[] = []
  let sendResult: Record<string, unknown> = { attempted: false }
  let healthAfterStop: unknown = null
  let listAfterStop: unknown = null
  let failure: ReturnType<typeof errorInfo> | null = null
  let adapter: HarnessAdapter | undefined

  try {
    key = readKey(SECRET_FILE)
    const env = cleanEnv(key)
    adapter = new HarnessAdapter({
      dshHomeBase: HOMES,
      env,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      maxTokens: 64,
      initializeTimeoutMs: 60_000,
      requestTimeoutMs: 180_000,
      logger: (diagnostic) => {
        diagnostics.push(diagnostic)
        log.push(`diagnostic ${diagnostic.kind} ${diagnostic.eventType}${diagnostic.seq === undefined ? '' : `#${diagnostic.seq}`}: ${diagnostic.detail}`)
      },
    })

    const startBegin = Date.now()
    await adapter.start()
    log.push(`started in ${Date.now() - startBegin}ms`)

    const sessions = []
    for (let index = 0; index < 3; index += 1) {
      const dirA = join(WORK, `s${index + 1}-a`)
      const dirB = join(WORK, `s${index + 1}-b`)
      mkdirSync(dirA, { recursive: true })
      mkdirSync(dirB, { recursive: true })
      const createBegin = Date.now()
      const session = await adapter.createSession({ workingDirectory: dirA, title: `s${index + 1}` })
      const createMs = Date.now() - createBegin
      sessions.push(session)

      const actualA = await session.getWorkingDirectory()
      await session.setWorkingDirectory(dirB)
      const actualB = await session.getWorkingDirectory()
      sessionResults.push({
        index: index + 1,
        sessionId: session.sessionId,
        runtimeId: session.runtimeId,
        createMs,
        round1: { expected: dirA, actual: actualA, ok: actualA === dirA },
        round2: { expected: dirB, actual: actualB, ok: actualB === dirB },
      })
      log.push(`session ${index + 1} created ${session.sessionId} (${createMs}ms); workdir ${actualA === dirA && actualB === dirB ? '2/2' : 'FAIL'}`)
    }

    preStop = runtimeProcesses(process.pid, snapshotProcesses())
    log.push(`pre-stop runtime processes: ${preStop.length}`)

    const sendBegin = Date.now()
    try {
      const events = await collect(sessions[0]!.send('Reply with exactly the word OK and nothing else.'))
      sendResult = {
        attempted: true,
        ok: events.some((event) => event.kind === 'message.complete'),
        latencyMs: Date.now() - sendBegin,
        eventCount: events.length,
        kinds: events.map((event) => event.kind),
        texts: eventTexts(events),
        diagnostics: diagnostics.length,
      }
      log.push(`send: ${String(sendResult.ok)} in ${String(sendResult.latencyMs)}ms, ${events.length} events`)
    } catch (error) {
      const info = errorInfo(error, key)
      sendResult = {
        attempted: true,
        ok: false,
        latencyMs: Date.now() - sendBegin,
        error: info,
      }
      log.push(`send failed: ${info.name} ${info.code ?? ''} ${info.message}`)
    }

    try {
      await adapter.stop()
      lifecycleOk = true
      log.push('stop completed')
    } catch (error) {
      const info = errorInfo(error, key)
      stopError = `${info.name} ${info.code ?? ''} ${info.message}`
      log.push(`stop error: ${stopError}`)
    }

    const deadline = Date.now() + 15_000
    do {
      postStop = runtimeProcesses(process.pid, snapshotProcesses())
      if (postStop.length === 0) break
      await sleep(500)
    } while (Date.now() < deadline)

    healthAfterStop = await adapter.health().catch(() => null)
    listAfterStop = await adapter.listSessions().catch(() => null)
  } catch (error) {
    failure = errorInfo(error, key)
    log.push(`failure: ${failure.name} ${failure.code ?? ''} ${failure.message}`)
    if (adapter !== undefined) {
      try {
        await adapter.stop()
      } catch (stopFailure) {
        const info = errorInfo(stopFailure, key)
        stopError = `${info.name} ${info.code ?? ''} ${info.message}`
        log.push(`stop after failure: ${stopError}`)
      }
    }
    postStop = runtimeProcesses(process.pid, snapshotProcesses())
  }

  const finishedAt = new Date().toISOString()
  const allRounds = sessionResults.flatMap((result) => {
    const round1 = result.round1 as { ok: boolean }
    const round2 = result.round2 as { ok: boolean }
    return [round1.ok, round2.ok]
  })
  const roundsPassed = allRounds.filter(Boolean).length
  const lifecyclePass = lifecycleOk && postStop.length === 0 && roundsPassed === 6 && sessionResults.length === 3
  const exitCode = lifecyclePass ? 0 : 1

  const summary = {
    runId: RUN_ID,
    startedAt,
    finishedAt,
    node: process.version,
    runs: sendResult.attempted === true ? 1 : 0,
    sessions: sessionResults,
    workingDirectory: { rounds: allRounds.length, passed: roundsPassed, ok: roundsPassed === 6 },
    send: sendResult,
    stop: {
      lifecycleOk,
      error: stopError,
      preStopCount: preStop.length,
      preStop: preStop.map(describe),
      residualCount: postStop.length,
      residual: postStop.map(describe),
    },
    healthAfterStop,
    listAfterStop,
    capability: adapter?.capabilities() ?? null,
    diagnosticsCount: diagnostics.length,
    diagnostics: diagnostics.slice(0, 100),
    failure,
    exitCode,
  }

  const logText = `${log.join('\n')}\n`
  writeFileSync(join(OUT_DIR, 'run.log'), redact(logText, key), 'utf8')
  writeJson(join(OUT_DIR, 'summary.json'), summary, key)
  writeJson(join(OUT_DIR, 'events.json'), { send: sendResult, diagnostics }, key)
  writeJson(join(OUT_DIR, 'processes.json'), { preStop: preStop.map(describe), postStop: postStop.map(describe) }, key)

  const hashFiles = ['summary.json', 'events.json', 'processes.json', 'run.log']
  const hashes: Record<string, string> = {}
  for (const file of hashFiles) {
    hashes[file] = createHash('sha256').update(readFileSync(join(OUT_DIR, file))).digest('hex')
  }
  writeJson(join(OUT_DIR, 'hashes.json'), { runId: RUN_ID, finishedAt, files: hashes }, key)

  console.log(JSON.stringify(redactDeep({
    runId: RUN_ID,
    outDir: OUT_DIR,
    runs: summary.runs,
    sessions: summary.sessions.length,
    workingDirectory: summary.workingDirectory,
    send: summary.send,
    stop: { lifecycleOk, preStopCount: summary.stop.preStopCount, residualCount: summary.stop.residualCount },
    exitCode,
  }, key), null, 2))
  return exitCode
}

process.exitCode = await main()

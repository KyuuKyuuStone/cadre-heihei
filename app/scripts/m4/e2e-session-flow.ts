#!/usr/bin/env node
/**
 * E2E-02：Electron + 真实 harness 一次 send → pump → renderer 回读。
 *
 * 运行前需 npm run build:all。凭据只从 s15 指定的 secrets 文件读入子进程环境，
 * 不打印、不写 argv；产物统一脱敏后再落盘。
 * 输出目录：D:\xxw_p\cadre-spike-env\s15-session-flow\<runId>\
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const OUT_ROOT = process.env.CADRE_E2E_OUT_ROOT ?? 'D:\\xxw_p\\cadre-spike-env\\s15-session-flow'
const RUN_ID =
  new Date().toISOString().replace(/[:.]/g, '-') + (process.env.CADRE_E2E_RUN_SUFFIX ?? '')
const OUT_DIR = join(OUT_ROOT, RUN_ID)
const USER_DATA = join(OUT_DIR, 'userdata')
const WORK = join(OUT_DIR, 'work')
const ELECTRON = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function readKey(): string {
  const text = readFileSync(SECRET_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match?.[1] !== 'DEEPSEEK_API_KEY') continue
    const value = match[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (value.length < 10) throw new Error('DEEPSEEK_API_KEY too short')
    return value
  }
  throw new Error('DEEPSEEK_API_KEY not found')
}

function redact(text: string, key: string): string {
  return text.split(key).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
}

interface ProcessRow {
  Name?: unknown
  CommandLine?: unknown
}

function processRows(): ProcessRow[] {
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | " +
    'Select-Object Name,CommandLine | ConvertTo-Json -Compress'
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
    if (raw === '') return []
    const parsed = JSON.parse(raw) as ProcessRow | ProcessRow[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function harnessCount(rows: ProcessRow[]): number {
  return rows.filter((row) => {
    const name = String(row.Name ?? '')
    const command = String(row.CommandLine ?? '')
    return /^node(\.exe)?$/i.test(name) && /dsh|deepseek-harness/i.test(command)
  }).length
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function dbCheck(databasePath: string): Record<string, unknown> {
  const requireFromApp = createRequire(join(APP_ROOT, 'package.json'))
  try {
    const { DatabaseSync } = requireFromApp('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(databasePath)
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }
      const members = db.prepare('SELECT project_id, COUNT(*) AS n FROM members GROUP BY project_id').all()
      const tasks = db.prepare('SELECT project_id, COUNT(*) AS n FROM tasks GROUP BY project_id').all()
      const taskRows = db
        .prepare(
          `SELECT task_id, project_id, title, status, dispatcher_session_id,
                  assignee_session_id, created_at
           FROM tasks ORDER BY rowid ASC`,
        )
        .all()
      return {
        path: databasePath,
        integrity: integrity?.integrity_check ?? 'unknown',
        journal: journal?.journal_mode ?? 'unknown',
        members,
        tasks,
        taskRows,
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return { path: databasePath, error: String(error) }
  }
}

function patchDbRefs(root: string): { scanned: number; withDbPath: number; files: string[] } {
  if (!existsSync(root)) return { scanned: 0, withDbPath: 0, files: [] }
  const files: string[] = []
  let scanned = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        scanned += 1
        if (readFileSync(path, 'utf8').includes('cadre.sqlite')) files.push(path)
      }
    }
  }
  walk(root)
  return { scanned, withDbPath: files.length, files: files.map((file) => file.replace(OUT_DIR, '<out>')) }
}

function run(): Promise<{ code: number | null; signal: string | null; timedOut: boolean }> {
  const key = readKey()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CADRE_MODE: 'prod',
    CADRE_E2E: '1',
    CADRE_USER_DATA: USER_DATA,
    CADRE_WORKDIR: WORK,
    CADRE_TEST_SEED_MEMBERS: '1',
    CADRE_E2E_PROMPT: process.env.CADRE_E2E_PROMPT ?? 'Reply with exactly: pong',
    CADRE_E2E_OTHER_PROJECT: 'e2e-other-project',
    CADRE_PROVIDER: process.env.CADRE_PROVIDER ?? 'deepseek',
    CADRE_MODEL: 'deepseek-flash',
    CADRE_MAX_TOKENS: process.env.CADRE_E2E_MAX_TOKENS ?? '64',
    ...(process.env.CADRE_SEED_MEMBERS_JSON === undefined
      ? {}
      : { CADRE_SEED_MEMBERS_JSON: process.env.CADRE_SEED_MEMBERS_JSON }),
    ...(process.env.CADRE_PROVIDER_BASE_URL === undefined
      ? {}
      : { CADRE_PROVIDER_BASE_URL: process.env.CADRE_PROVIDER_BASE_URL }),
    ...(process.env.CADRE_DSH_BIN === undefined ? {} : { CADRE_DSH_BIN: process.env.CADRE_DSH_BIN }),
    ...(process.env.CADRE_SDK_ENTRY === undefined
      ? {}
      : { CADRE_SDK_ENTRY: process.env.CADRE_SDK_ENTRY }),
    DEEPSEEK_API_KEY: key,
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    NO_PROXY: '*',
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[name]
  }

  return new Promise((resolveRun) => {
    const child = spawn(ELECTRON, ['dist/main/index.cjs'], {
      cwd: APP_ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }, 240_000)
    child.on('error', (error) => {
      err += `\nspawn error: ${error.message}`
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      writeFileSync(join(OUT_DIR, 'stdout.log'), redact(out, key), 'utf8')
      writeFileSync(join(OUT_DIR, 'stderr.log'), redact(err, key), 'utf8')
      resolveRun({ code, signal, timedOut })
    })
  })
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(
    join(USER_DATA, 'identity.json'),
    `${JSON.stringify(
      {
        projectId: 'e2e-project',
        sessionId: 'e2e-session',
        role: process.env.CADRE_E2E_ROLE ?? 'worker',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const key = readKey()
  const before = harnessCount(processRows())
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const result = await run()
  const elapsedMs = Date.now() - started
  const after = harnessCount(processRows())

  const stdoutPath = join(OUT_DIR, 'stdout.log')
  const stderrPath = join(OUT_DIR, 'stderr.log')
  const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : ''
  const match = stdout.match(/\[m4\] e2e result=(.+)/)
  const probe = match ? (JSON.parse(match[1]!) as Record<string, unknown>) : null
  const databasePath = join(USER_DATA, 'cadre.sqlite')
  const db = dbCheck(databasePath)
  const patchRefs = patchDbRefs(join(USER_DATA, 'patches'))

  const events = Array.isArray(probe?.events) ? (probe!.events as Array<Record<string, unknown>>) : []
  const taskRows = Array.isArray(db.taskRows) ? (db.taskRows as Array<Record<string, unknown>>) : []
  const toolCheck = {
    required: process.env.CADRE_E2E_REQUIRE_TOOL === '1',
    hasCall: events.some((event) => event.kind === 'tool.call'),
    hasResult: events.some((event) => event.kind === 'tool.result'),
    resultOk: events.some((event) => event.kind === 'tool.result' && event.ok === true),
    ledgerRow: taskRows.find((row) => row.dispatcher_session_id === 'e2e-session') ?? null,
  }
  const summary = {
    runId: RUN_ID,
    startedAt,
    elapsedMs,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    probe,
    probeOk: probe?.ok === true,
    runCount: probe === null ? 0 : 1,
    eventCount: events.length,
    eventKinds: events.map((event) => event.kind),
    eventSeqs: events.map((event) => event.seq),
    seqMonotonic: events.every(
      (event, index) => index === 0 || Number(event.seq) > Number(events[index - 1]!.seq),
    ),
    finalText: probe?.finalText ?? null,
    isolation: probe?.isolation ?? null,
    residualHarness: { before, after },
    dshBin: process.env.CADRE_DSH_BIN ?? null,
    sdkEntry: process.env.CADRE_SDK_ENTRY ?? null,
    runtimeLogs: stdout
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.includes('dsh-bin') || line.includes('sdk-entry') || line.includes('harness-sdk'),
      ),
    toolEvents: events.filter(
      (event) => event.kind === 'tool.call' || event.kind === 'tool.result',
    ),
    toolCheck,
    db,
    patchDbRefs: patchRefs,
    logs: {
      stdout: { path: stdoutPath, sha256: sha256(stdoutPath) },
      stderr: { path: stderrPath, sha256: sha256(stderrPath) },
    },
  }

  const scanTargets = existsSync(OUT_DIR)
    ? readdirSync(OUT_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(OUT_DIR, entry.name))
    : []
  const scan = scanTargets.map((file) => {
    const text = readFileSync(file, 'utf8')
    const exact = text.split(key).length - 1
    const pattern = text.match(/sk-[A-Za-z0-9_-]{6,}/g)?.length ?? 0
    return { file: file.replace(OUT_DIR, '<out>'), exact, pattern }
  })
  const scanPath = join(OUT_DIR, 'scan.json')
  const summaryPath = join(OUT_DIR, 'summary.json')
  writeFileSync(scanPath, `${JSON.stringify(scan, null, 2)}\n`, 'utf8')
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(OUT_DIR, 'hashes.json'),
    `${JSON.stringify(
      {
        summary: sha256(summaryPath),
        scan: sha256(scanPath),
        stdout: sha256(stdoutPath),
        stderr: sha256(stderrPath),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const isolationCode =
    probe && typeof probe.isolation === 'object' && probe.isolation !== null
      ? String((probe.isolation as { error?: { code?: unknown } }).error?.code ?? 'none')
      : 'none'
  const ok =
    result.code === 0 &&
    !result.timedOut &&
    probe !== null &&
    probe.ok === true &&
    events.some((event) => event.kind === 'message.complete') &&
    after === 0 &&
    scan.every((entry) => entry.exact === 0 && entry.pattern === 0) &&
    (isolationCode === 'CROSS_PROJECT_DENIED' || isolationCode === 'none') &&
    (!toolCheck.required ||
      (toolCheck.hasCall && toolCheck.hasResult && toolCheck.resultOk && toolCheck.ledgerRow !== null))

  console.log(
    JSON.stringify(
      {
        ok,
        outDir: OUT_DIR,
        exitCode: result.code,
        timedOut: result.timedOut,
        runCount: summary.runCount,
        elapsedMs,
        eventKinds: summary.eventKinds,
        eventSeqs: summary.eventSeqs,
        seqMonotonic: summary.seqMonotonic,
        finalText: summary.finalText,
        isolationCode,
        residual: { before, after },
        db: summary.db,
        patchDbRefs: { scanned: patchRefs.scanned, withDbPath: patchRefs.withDbPath },
        scanClean: scan.every((entry) => entry.exact === 0 && entry.pattern === 0),
      },
      null,
      2,
    ),
  )
  return ok ? 0 : 1
}

void main().then((code) => {
  process.exitCode = code
})

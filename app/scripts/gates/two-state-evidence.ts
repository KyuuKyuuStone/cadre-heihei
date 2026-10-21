#!/usr/bin/env node
/**
 * two-state-evidence.ts —— ADR-0011 三步判别力自证：
 * 每个门禁执行「注入坏样本必红 → 复原必绿」，两态原始输出与退出码落盘。
 *
 * 用法：node app/scripts/gates/two-state-evidence.ts
 * 退出码：0=四门禁两态均符合预期；1=任一态不符合。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_DIR = join(APP_ROOT, 'scripts/gates/evidence')
mkdirSync(EVIDENCE_DIR, { recursive: true })

type GateCase = {
  name: string
  gate: string
  fixture: string
  target: string
  description: string
  /** 红态输出必须指名的注入文件 */
  expectRedIncludes?: string
}

const CASES: GateCase[] = [
  {
    name: 'file-size',
    gate: 'scripts/gates/check-file-size.ts',
    fixture: 'scripts/gates/fixtures/file-size/oversize.fixture',
    target: 'src/__gate_fixture_oversize.ts',
    description: '2501 行 > 2500 上限',
  },
  {
    name: 'import-semantics',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-semantics/bad-fs-import.fixture',
    target: 'src/__gate_fixture_import_semantics.ts',
    description: 'node:fs 命名空间混用 await readFile',
  },
  {
    name: 'tsc-baseline',
    gate: 'scripts/gates/check-tsc-baseline.ts',
    fixture: 'scripts/gates/fixtures/tsc/bad-type.fixture',
    target: 'src/__gate_fixture_tsc_error.ts',
    description: '新增 TS2322 类型签名',
  },
  {
    name: 'smoke',
    gate: 'scripts/gates/smoke.ts',
    fixture: 'scripts/gates/fixtures/smoke/failing.test.fixture',
    target: 'tests/__gate_fixture_failing.test.ts',
    description: '注入 1 个失败用例',
  },
  {
    name: 'import-boundaries-ports',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/ports-harness.fixture',
    target: 'src/ports/__gate_fixture_ports_harness.ts',
    description: 'R2 ports 层 harness import + 类型 re-export',
    expectRedIncludes: '__gate_fixture_ports_harness.ts',
  },
  {
    name: 'import-boundaries-collab',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/collab-harness.fixture',
    target: 'src/collab/__gate_fixture_collab_harness.ts',
    description: 'R3 collab 层 harness 源码路径 import',
    expectRedIncludes: '__gate_fixture_collab_harness.ts',
  },
  {
    name: 'import-boundaries-renderer',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-harness.fixture',
    target: 'src/renderer/__gate_fixture_renderer_harness.ts',
    description: 'R3 renderer 层 harness 包 import',
    expectRedIncludes: '__gate_fixture_renderer_harness.ts',
  },
  {
    name: 'import-boundaries-reverse',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/ports-to-adapters.fixture',
    target: 'src/ports/__gate_fixture_ports_adapters.ts',
    description: 'ports 反向 import adapters',
    expectRedIncludes: '__gate_fixture_ports_adapters.ts',
  },
]

function run(gate: string) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [gate], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    exitCode: r.status ?? -1,
    elapsedMs: Date.now() - started,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

function format(name: string, phase: string, gate: string, result: ReturnType<typeof run>) {
  return [
    `gate=${name} phase=${phase}`,
    `command=node ${gate}`,
    `exitCode=${result.exitCode}`,
    `elapsedMs=${result.elapsedMs}`,
    '--- stdout ---',
    result.stdout.trimEnd(),
    '--- stderr ---',
    result.stderr.trimEnd(),
    '',
  ].join('\n')
}

const summary: Array<{
  name: string
  description: string
  redExit: number
  greenExit: number
  redExpected: boolean
  greenExpected: boolean
  redNamedFile: boolean
  redElapsedMs: number
  greenElapsedMs: number
  redEvidence: string
  greenEvidence: string
}> = []
let failed = 0

for (const c of CASES) {
  const fixturePath = join(APP_ROOT, c.fixture)
  const targetPath = join(APP_ROOT, c.target)
  if (!existsSync(fixturePath)) {
    console.error(`[evidence] FAIL ${c.name}: fixture 不存在 ${fixturePath}`)
    failed++
    continue
  }
  if (existsSync(targetPath)) {
    console.error(`[evidence] FAIL ${c.name}: 注入目标已存在，拒绝覆盖 ${targetPath}`)
    failed++
    continue
  }

  let red!: ReturnType<typeof run>
  let green!: ReturnType<typeof run>
  try {
    copyFileSync(fixturePath, targetPath)
    red = run(c.gate)
    rmSync(targetPath, { force: true })
    green = run(c.gate)
  } finally {
    rmSync(targetPath, { force: true })
  }

  const redOutput = `${red.stdout}\n${red.stderr}`
  const redNamedFile = c.expectRedIncludes === undefined || redOutput.includes(c.expectRedIncludes)
  const redExpected = red.exitCode !== 0 && redNamedFile
  const greenExpected = green.exitCode === 0
  if (!redExpected) failed++
  if (!greenExpected) failed++

  const redPath = join(EVIDENCE_DIR, `${c.name}-red.txt`)
  const greenPath = join(EVIDENCE_DIR, `${c.name}-green.txt`)
  writeFileSync(redPath, format(c.name, 'red', c.gate, red), 'utf8')
  writeFileSync(greenPath, format(c.name, 'green', c.gate, green), 'utf8')

  console.log(`[evidence] ${c.name}: red exit=${red.exitCode} ${redExpected ? 'OK' : 'UNEXPECTED'}; green exit=${green.exitCode} ${greenExpected ? 'OK' : 'UNEXPECTED'} (${c.description})`)
  summary.push({
    name: c.name,
    description: c.description,
    redExit: red.exitCode,
    greenExit: green.exitCode,
    redExpected,
    greenExpected,
    redNamedFile,
    redElapsedMs: red.elapsedMs,
    greenElapsedMs: green.elapsedMs,
    redEvidence: redPath,
    greenEvidence: greenPath,
  })
}

const payload = {
  capturedAt: new Date().toISOString(),
  method: '注入坏样本必红 → 复原必绿（ADR-0011 三步）',
  cases: summary,
  verdict: failed === 0 ? 'PASS' : 'FAIL',
}
writeFileSync(join(EVIDENCE_DIR, 'two-state-summary.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
const passedGates = summary.filter((s) => s.redExpected && s.greenExpected).length
console.log(`\n[evidence] ${passedGates}/${CASES.length} gates two-state PASS -> ${join(EVIDENCE_DIR, 'two-state-summary.json')}`)
process.exit(failed === 0 ? 0 : 1)

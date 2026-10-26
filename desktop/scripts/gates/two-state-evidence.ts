#!/usr/bin/env node
/**
 * two-state-evidence.ts —— ADR-0011 三步判别力自证（从 app/scripts/gates 迁移到 desktop）。
 * 每个门禁执行「注入坏样本必红 → 复原必绿」，两态原始输出与退出码落盘。
 *
 * 迁移改动：
 *   - 路径落到 desktop；坏样本目标改为 desktop 源码树内可被对应门禁扫到的位置
 *   - 旧的 ports/adapters/renderer 边界样本不再适用，改为 UI-ISO / COLLAB-ISO 两条坏样本
 *   - smoke 通过 GATE_SMOKE_EXTRA 注入临时失败用例
 *
 * 用法：node desktop/scripts/gates/two-state-evidence.ts
 * 退出码：0=全部门禁两态均符合预期；1=任一态不符合。
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
  /** 注入用例需要的额外环境变量（如 smoke 的临时测试文件）。 */
  env?: Record<string, string>
  /** 允许样本：注入后门禁必须保持绿（不产生红态）。 */
  expectGreenOnly?: boolean
}

const CASES: GateCase[] = [
  {
    name: 'file-size',
    gate: 'scripts/gates/check-file-size.ts',
    fixture: 'scripts/gates/fixtures/file-size/oversize.fixture',
    target: 'packages/client/ui-sidebar/src/__gate_fixture_oversize.ts',
    description: '2501 行 > 2500 上限',
    expectRedIncludes: '__gate_fixture_oversize.ts',
  },
  {
    name: 'import-semantics-l2',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-semantics/bad-fs-import.fixture',
    target: 'packages/client/ui-sidebar/src/__gate_fixture_import_semantics.ts',
    description: 'node:fs 命名空间混用 await readFile',
    expectRedIncludes: '__gate_fixture_import_semantics.ts',
  },
  {
    name: 'tsc-baseline',
    gate: 'scripts/gates/check-tsc-baseline.ts',
    fixture: 'scripts/gates/fixtures/tsc/bad-type.fixture',
    target: 'scripts/__gate_fixture_tsc_error.ts',
    description: '新增 TS2322 类型签名',
    expectRedIncludes: '__gate_fixture_tsc_error.ts',
  },
  {
    name: 'smoke',
    gate: 'scripts/gates/smoke.ts',
    fixture: 'scripts/gates/fixtures/smoke/failing.spec.fixture',
    target: 'apps/desktop/tests/__gate_fixture_failing.spec.ts',
    description: '注入 1 个失败用例',
    env: { GATE_SMOKE_EXTRA: 'apps/desktop/tests/__gate_fixture_failing.spec.ts' },
  },
  {
    name: 'ui-iso-electron',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-semantics/ui-electron.fixture',
    target: 'packages/client/ui-sidebar/src/__gate_fixture_ui_electron.ts',
    description: 'UI 层 import electron',
    expectRedIncludes: '__gate_fixture_ui_electron.ts',
  },
  {
    name: 'collab-iso-package',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-semantics/collab-package.fixture',
    target: 'cadre-collab/__gate_fixture_collab_package.ts',
    description: '协作状态机 import 产品包',
    expectRedIncludes: '__gate_fixture_collab_package.ts',
  },
]

function run(gate: string, extraEnv: Record<string, string> = {}) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [gate], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  })
  return {
    exitCode: r.status ?? -1,
    elapsedMs: Date.now() - started,
    stdout: r.stdout,
    stderr: r.stderr,
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
  kind: 'red-green' | 'allow'
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

  // 允许样本：只验证「注入后门禁保持绿」，不制造红态。
  if (c.expectGreenOnly) {
    let allow!: ReturnType<typeof run>
    try {
      copyFileSync(fixturePath, targetPath)
      allow = run(c.gate, c.env)
    } finally {
      rmSync(targetPath, { force: true })
    }
    const greenExpected = allow.exitCode === 0
    if (!greenExpected) failed++
    const allowPath = join(EVIDENCE_DIR, `${c.name}-allow.txt`)
    writeFileSync(allowPath, format(c.name, 'allow', c.gate, allow), 'utf8')
    console.log(`[evidence] ${c.name}: allow exit=${allow.exitCode} ${greenExpected ? 'OK' : 'UNEXPECTED'} (${c.description})`)
    summary.push({
      name: c.name,
      description: c.description,
      kind: 'allow',
      redExit: -1,
      greenExit: allow.exitCode,
      redExpected: true,
      greenExpected,
      redNamedFile: true,
      redElapsedMs: 0,
      greenElapsedMs: allow.elapsedMs,
      redEvidence: '',
      greenEvidence: allowPath,
    })
    continue
  }

  let red!: ReturnType<typeof run>
  let green!: ReturnType<typeof run>
  try {
    copyFileSync(fixturePath, targetPath)
    red = run(c.gate, c.env)
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
    kind: 'red-green',
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
const passedGates = summary.filter(s => s.redExpected && s.greenExpected).length
console.log(`\n[evidence] ${passedGates}/${CASES.length} gates two-state PASS -> ${join(EVIDENCE_DIR, 'two-state-summary.json')}`)
process.exit(failed === 0 ? 0 : 1)

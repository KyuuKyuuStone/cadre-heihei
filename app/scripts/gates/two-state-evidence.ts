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
  /** 允许样本：注入后门禁必须保持绿（不产生红态）。 */
  expectGreenOnly?: boolean
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
  {
    name: 'import-boundaries-side-effect-package',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/side-effect-package.fixture',
    target: 'src/renderer/__gate_fixture_renderer_side_effect_package.ts',
    description: 'R3 无 from 副作用 import（harness 包）',
    expectRedIncludes: '__gate_fixture_renderer_side_effect_package.ts',
  },
  {
    name: 'import-boundaries-side-effect-vendor',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/side-effect-vendor.fixture',
    target: 'src/collab/__gate_fixture_collab_side_effect_vendor.ts',
    description: 'R3 无 from 副作用 import（vendor 源码）',
    expectRedIncludes: '__gate_fixture_collab_side_effect_vendor.ts',
  },
  {
    name: 'import-boundaries-require',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/require.fixture',
    target: 'src/renderer/__gate_fixture_renderer_require.ts',
    description: 'R3 require() 绕过静态 import',
    expectRedIncludes: '__gate_fixture_renderer_require.ts',
  },
  {
    name: 'import-boundaries-import-equals',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/import-equals.fixture',
    target: 'src/ports/__gate_fixture_ports_import_equals.ts',
    description: 'R2 TS import x = require()',
    expectRedIncludes: '__gate_fixture_ports_import_equals.ts',
  },
  {
    name: 'import-boundaries-src-test',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/src-test.fixture',
    target: 'src/ports/__gate_fixture_ports_test.test.ts',
    description: 'R2 src 下 .test.ts 不豁免',
    expectRedIncludes: '__gate_fixture_ports_test.test.ts',
  },
  {
    name: 'renderer-node-import',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-node-import.fixture',
    target: 'src/renderer/__gate_fixture_renderer_node_import.ts',
    description: 'RENDERER-NODE 禁 node:*',
    expectRedIncludes: '__gate_fixture_renderer_node_import.ts',
  },
  {
    name: 'renderer-electron',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-electron.fixture',
    target: 'src/renderer/__gate_fixture_renderer_electron.ts',
    description: 'RENDERER-NODE 禁 electron',
    expectRedIncludes: '__gate_fixture_renderer_electron.ts',
  },
  {
    name: 'renderer-adapters',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-adapters.fixture',
    target: 'src/renderer/__gate_fixture_renderer_adapters.ts',
    description: 'RENDERER-NODE 禁 src/adapters/**',
    expectRedIncludes: '__gate_fixture_renderer_adapters.ts',
  },
  {
    name: 'renderer-collab-impl',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-collab-impl.fixture',
    target: 'src/renderer/__gate_fixture_renderer_collab_impl.ts',
    description: 'RENDERER-NODE 禁协作层实现',
    expectRedIncludes: '__gate_fixture_renderer_collab_impl.ts',
  },
  {
    name: 'renderer-protocol-value',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-protocol-value.fixture',
    target: 'src/renderer/__gate_fixture_renderer_protocol_value.ts',
    description: 'RENDERER-NODE protocol 值导入越界（只许 type）',
    expectRedIncludes: '__gate_fixture_renderer_protocol_value.ts',
  },
  {
    name: 'renderer-vendor',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-vendor.fixture',
    target: 'src/renderer/__gate_fixture_renderer_vendor.ts',
    description: 'RENDERER-NODE 禁 vendor/**',
    expectRedIncludes: '__gate_fixture_renderer_vendor.ts',
  },
  {
    name: 'renderer-protocol-type-allow',
    gate: 'scripts/gates/check-import-semantics.ts',
    fixture: 'scripts/gates/fixtures/import-boundaries/renderer-protocol-type-allow.fixture',
    target: 'src/renderer/__gate_fixture_renderer_protocol_type_allow.ts',
    description: 'RENDERER-NODE 允许 protocol 类型 + shared 类型导入',
    expectGreenOnly: true,
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
      allow = run(c.gate)
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
const passedGates = summary.filter((s) => s.redExpected && s.greenExpected).length
console.log(`\n[evidence] ${passedGates}/${CASES.length} gates two-state PASS -> ${join(EVIDENCE_DIR, 'two-state-summary.json')}`)
process.exit(failed === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * check-token-budget.ts —— token 三项指标回归门禁（可红可绿；样本为 KB 级合成 JSONL）
 *
 * 阈值与口径来源：质量-Token用量解剖与优化方案.md §五「目标值与验证方法」：
 *   1) 每步 ≤120k   → 判据原文 `steps>120k 比例 <5%`
 *   2) 单任务 ≤30M  → 判据原文 `usage 总和 ≤30M`
 *   3) 新增输入 ≤1M → 判据原文 `ΣinputTokens ≤1M`；`重复读 Top1 次数 ≤3`
 *   （三项指标 → 四条判据：指标 3 含「新增输入」与「重复读 Top1」两个判定面。）
 * 质量红线（同文档 §四）：本门禁只判「是否超标」；门禁变绿不等于压缩已修好，
 * 压缩效果仍以方案 §五 的复跑对照表为准。
 *
 * 解析口径 = logs/zframes.cjs 解容器后的 v4 会话事件 JSONL，与 logs/analyze3.cjs /
 * analyze4.cjs 一致：
 *   assistant/message: data.usage.{cacheReadTokens,inputTokens,outputTokens}
 *   tool/call:         data.{callId,name,arguments}（arguments 为 JSON 字符串）
 *   tool/result:       data.message.{toolCallId,content[].text}
 *
 * 两态样本（KB 级合成，真实大日志绝不入库）：
 *   scripts/gates/fixtures/token/sample-green.jsonl  四项判据全达标（默认样本）
 *   scripts/gates/fixtures/token/sample-red.jsonl    四项判据全超标（两态注入）
 *   判别力自证：two-state-evidence.ts 以 GATE_TOKEN_SAMPLE 注入红样本必红，
 *   复原后默认绿样本必绿（与 smoke 的 GATE_SMOKE_EXTRA 同构）。
 *
 * 真实会话复跑（工作区根 C:\AI_P\cadre-heihei 下执行；logs/zframes.cjs 为仓库外留档工具）：
 *   node logs\zframes.cjs "<会话目录>\session.v4.jsonl.zstd" logs\session.jsonl
 *   node repo\cadre-heihei\desktop\scripts\gates\check-token-budget.ts logs\session.jsonl
 *   退出码 0=三项达标；1=超标（逐项列实测 vs 阈值）。
 *
 * 用法：node scripts/gates/check-token-budget.ts [sample.jsonl] [选项]
 *   --max-step-ctx <n>         每步上下文上限 tokens（默认 120000）
 *   --max-step-over-ratio <r>  超限步占比上限，判定为严格小于（默认 0.05）
 *   --max-total-usage <n>      总用量上限 tokens（默认 30000000）
 *   --max-input-tokens <n>     新增输入上限 tokens（默认 1000000）
 *   --max-repeat-reads <n>     同一路径 read 次数上限（默认 3）
 * 样本选择优先级：位置参数 > 环境变量 GATE_TOKEN_SAMPLE > 默认绿样本
 * 退出码：0=三项指标全部达标；1=任一判据不达标或真空（0 步）；2=样本不可用/参数非法
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_SAMPLE = join(APP_ROOT, 'scripts/gates/fixtures/token/sample-green.jsonl')

/** 默认阈值 = 方案 §五 原文数值；全部可用 CLI 选项覆盖（不许写死）。 */
const DEFAULT_MAX_STEP_CTX = 120_000
const DEFAULT_MAX_STEP_OVER_RATIO = 0.05
const DEFAULT_MAX_TOTAL_USAGE = 30_000_000
const DEFAULT_MAX_INPUT_TOKENS = 1_000_000
const DEFAULT_MAX_REPEAT_READS = 3

interface Thresholds {
  maxStepCtx: number
  maxStepOverRatio: number
  maxTotalUsage: number
  maxInputTokens: number
  maxRepeatReads: number
}

/** read 工具的目标路径字段（与 analyze3.cjs 的取参次序一致）。 */
interface CallArgs {
  path?: string
  file_path?: string
  relative?: string
}

interface ToolCall {
  name: string
  args: CallArgs
}

interface ParsedSample {
  /** assistant/message 带 usage 的步数。 */
  steps: number
  /** 每步 cacheReadTokens（判据 1 按阈值在此之上计数）。 */
  stepCtx: number[]
  crSum: number
  inpSum: number
  outSum: number
  /** read 目标路径 → 次数。 */
  readCounts: Map<string, number>
  skippedLines: number
}

/** v4 会话事件（zframes.cjs 解容器后的 JSONL 行）；只声明门禁用到的字段。 */
interface V4Event {
  type?: string
  data?: {
    usage?: { cacheReadTokens?: number; inputTokens?: number; outputTokens?: number }
    callId?: string
    name?: string
    arguments?: string
    message?: { toolCallId?: string }
  }
}

function usageError(message: string): never {
  console.error(`[token-budget] ${message}`)
  console.error('[token-budget] 用法与选项：node scripts/gates/check-token-budget.ts --help')
  process.exit(2)
}

function printHelp(): void {
  console.log(`token 三项指标回归门禁：node scripts/gates/check-token-budget.ts [sample.jsonl] [选项]
  --max-step-ctx <n>         每步上下文上限 tokens（默认 ${DEFAULT_MAX_STEP_CTX}）
  --max-step-over-ratio <r>  超限步占比上限，判定为严格小于（默认 ${DEFAULT_MAX_STEP_OVER_RATIO}）
  --max-total-usage <n>      总用量上限 tokens（默认 ${DEFAULT_MAX_TOTAL_USAGE}）
  --max-input-tokens <n>     新增输入上限 tokens（默认 ${DEFAULT_MAX_INPUT_TOKENS}）
  --max-repeat-reads <n>     同一路径 read 次数上限（默认 ${DEFAULT_MAX_REPEAT_READS}）
  样本优先级：位置参数 > 环境变量 GATE_TOKEN_SAMPLE > 默认绿样本
  退出码：0=全部达标；1=任一判据不达标或 0 步；2=样本不可用/参数非法`)
}

function parseArgs(argv: string[]): { sample: string | undefined; th: Thresholds } {
  const th: Thresholds = {
    maxStepCtx: DEFAULT_MAX_STEP_CTX,
    maxStepOverRatio: DEFAULT_MAX_STEP_OVER_RATIO,
    maxTotalUsage: DEFAULT_MAX_TOTAL_USAGE,
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    maxRepeatReads: DEFAULT_MAX_REPEAT_READS,
  }
  const numberFlags: Record<string, keyof Thresholds> = {
    '--max-step-ctx': 'maxStepCtx',
    '--max-step-over-ratio': 'maxStepOverRatio',
    '--max-total-usage': 'maxTotalUsage',
    '--max-input-tokens': 'maxInputTokens',
    '--max-repeat-reads': 'maxRepeatReads',
  }
  let sample: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    const key = numberFlags[arg]
    if (key !== undefined) {
      const raw = argv[i + 1]
      const n = Number(raw)
      if (raw === undefined || !Number.isFinite(n) || n < 0) {
        usageError(`${arg} 需要非负数值，收到：${String(raw)}`)
      }
      th[key] = n
      i++
      continue
    }
    if (arg.startsWith('--')) usageError(`未知选项：${arg}`)
    if (sample !== undefined) usageError(`多余的位置参数：${arg}（样本已指定为 ${sample}）`)
    sample = arg
  }
  return { sample, th }
}

/** 样本路径按「cwd → APP_ROOT」次序解析；都不存在则原样返回，由存在性检查报错。 */
function resolveSamplePath(sample: string): string {
  if (existsSync(sample)) return sample
  const underRoot = join(APP_ROOT, sample)
  if (existsSync(underRoot)) return underRoot
  return sample
}

function parseSample(text: string): ParsedSample {
  const calls = new Map<string, ToolCall>()
  const readCounts = new Map<string, number>()
  const parsed: ParsedSample = {
    steps: 0,
    stepCtx: [],
    crSum: 0,
    inpSum: 0,
    outSum: 0,
    readCounts,
    skippedLines: 0,
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let event: V4Event
    try {
      event = JSON.parse(line) as V4Event
    } catch {
      parsed.skippedLines++
      continue
    }
    const data = event.data
    if (event.type === 'assistant/message' && data?.usage !== undefined) {
      const cr = Number(data.usage.cacheReadTokens) || 0
      const inp = Number(data.usage.inputTokens) || 0
      const out = Number(data.usage.outputTokens) || 0
      parsed.steps++
      parsed.stepCtx.push(cr)
      parsed.crSum += cr
      parsed.inpSum += inp
      parsed.outSum += out
      continue
    }
    if (event.type === 'tool/call' && data?.callId !== undefined) {
      let args: CallArgs = {}
      try {
        args = JSON.parse(data.arguments ?? '{}') as CallArgs
      } catch {
        args = {}
      }
      calls.set(data.callId, { name: data.name ?? '', args })
      continue
    }
    if (event.type === 'tool/result' && data?.message?.toolCallId !== undefined) {
      const call = calls.get(data.message.toolCallId)
      if (call === undefined || call.name !== 'read') continue
      const target = call.args.path ?? call.args.file_path ?? call.args.relative
      if (target === undefined || target === '') continue
      readCounts.set(target, (readCounts.get(target) ?? 0) + 1)
    }
  }
  return parsed
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** 汇总行里的样本路径：库内相对化（两态红态输出据此点名注入文件），库外原样。 */
function displayPath(path: string): string {
  const rel = relative(APP_ROOT, path)
  if (rel === '' || rel.startsWith('..')) return path
  return rel.split(sep).join('/')
}

function main(): void {
  const { sample: sampleArg, th } = parseArgs(process.argv.slice(2))
  const chosen = sampleArg ?? process.env.GATE_TOKEN_SAMPLE ?? DEFAULT_SAMPLE
  const samplePath = resolveSamplePath(chosen)
  if (!existsSync(samplePath)) usageError(`样本不存在：${chosen}`)

  const parsed = parseSample(readFileSync(samplePath, 'utf8'))
  if (parsed.steps === 0) {
    console.error(
      `[token-budget] FAIL 真空自毁：解析到 0 个 assistant/message usage 样本（${displayPath(samplePath)} 为空或 schema 不符）——空跑不算通过`,
    )
    process.exit(1)
  }

  const totalUsage = parsed.crSum + parsed.inpSum + parsed.outSum
  const overSteps = parsed.stepCtx.filter((cr) => cr > th.maxStepCtx).length
  const overRatio = overSteps / parsed.steps
  let topPath = ''
  let topReads = 0
  for (const [path, count] of parsed.readCounts) {
    if (count > topReads) {
      topReads = count
      topPath = path
    }
  }

  const judgments: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: '1 每步上下文（≤120k，原文 steps>120k 比例 <5%）',
      ok: overRatio < th.maxStepOverRatio,
      detail: `${overSteps}/${parsed.steps} 步 > ${fmtTokens(th.maxStepCtx)}（占比 ${(overRatio * 100).toFixed(1)}%，阈值 <${(th.maxStepOverRatio * 100).toFixed(1)}%）`,
    },
    {
      name: '2 单任务总用量（≤30M，原文 usage 总和 ≤30M）',
      ok: totalUsage <= th.maxTotalUsage,
      detail: `${fmtTokens(totalUsage)} tokens（cacheRead ${fmtTokens(parsed.crSum)} + input ${fmtTokens(parsed.inpSum)} + output ${fmtTokens(parsed.outSum)}），阈值 ≤${fmtTokens(th.maxTotalUsage)}`,
    },
    {
      name: '3 新增输入（≤1M，原文 ΣinputTokens ≤1M）',
      ok: parsed.inpSum <= th.maxInputTokens,
      detail: `${fmtTokens(parsed.inpSum)} tokens，阈值 ≤${fmtTokens(th.maxInputTokens)}`,
    },
    {
      name: '4 重复读 Top1（≤3，原文 重复读 Top1 次数 ≤3）',
      ok: topReads <= th.maxRepeatReads,
      detail:
        topPath === ''
          ? '样本内无 read 调用（阈值 ≤3）'
          : `${topReads} 次（阈值 ≤${th.maxRepeatReads}）：${topPath}`,
    },
  ]

  let failed = 0
  for (const j of judgments) {
    if (!j.ok) failed++
    console.log(`[token-budget] ${j.ok ? 'PASS' : 'FAIL'} ${j.name}: ${j.detail}`)
  }
  if (parsed.skippedLines > 0) {
    console.log(`[token-budget] NOTE 跳过非 JSON 行 ${parsed.skippedLines} 条`)
  }
  console.log(
    `[token-budget] ${failed === 0 ? 'PASS' : 'FAIL'}: ${judgments.length - failed}/${judgments.length} 判据达标（sample=${displayPath(samplePath)}, steps=${parsed.steps}）`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main()

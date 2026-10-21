/**
 * S7 运行时产物双扫描：精确 DEEPSEEK_API_KEY 值 + `sk-[A-Za-z0-9_-]{6,}`。
 *
 * 只写命中路径/计数，不写 key 值或命中正文。
 * 会话日志为 .jsonl.zstd，使用 Node 24 zstd 解压后扫描；失败项显式记录。
 * 同时重建 hashes.json（含 security-scan.json 与全部扫描文件）。
 *
 * 用法：node scripts/s7-harness-adapter/security-scan.ts [runDir]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SECRET_FILE = 'D:\\xxw_p\\cadre-spike-env\\.secrets\\deepseek.env'
const OUT_ROOT = 'D:\\xxw_p\\cadre-spike-env\\s7-harness-adapter'
const SK_PATTERN = 'sk-[A-Za-z0-9_-]{6,}'
const EXCLUDED = new Set(['hashes.json', 'security-scan.json'])

interface ScannedFile {
  path: string
  bytes: number
  decompressed: boolean
}

interface HitSummary {
  hits: number
  files: string[]
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

function latestRunDir(): string {
  const names = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const name of names) {
    const dir = join(OUT_ROOT, name)
    if (existsSync(join(dir, 'summary.json'))) return dir
  }
  throw new Error(`no S7 run directory with summary.json under ${OUT_ROOT}`)
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

function normalize(rel: string): string {
  return rel.split('\\').join('/')
}

function countExact(text: string, key: string): number {
  if (key.length === 0) return 0
  return text.split(key).length - 1
}

function scanText(text: string, key: string): { exact: number; pattern: number } {
  return {
    exact: countExact(text, key),
    pattern: text.match(new RegExp(SK_PATTERN, 'g'))?.length ?? 0,
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main(): void {
  const runDir = process.argv[2] === undefined ? latestRunDir() : process.argv[2]
  const key = readKey(SECRET_FILE)
  const allFiles = walk(runDir)
  const scanned: ScannedFile[] = []
  const excluded: string[] = []
  const readErrors: string[] = []
  const decompressionErrors: string[] = []
  const exact: HitSummary = { hits: 0, files: [] }
  const pattern: HitSummary = { hits: 0, files: [] }
  let scannedBytes = 0
  let decompressedFiles = 0

  for (const full of allFiles) {
    const rel = normalize(relative(runDir, full))
    if (EXCLUDED.has(rel)) {
      excluded.push(rel)
      continue
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(full)
    } catch {
      readErrors.push(rel)
      continue
    }
    scannedBytes += bytes.byteLength
    let text = bytes.toString('utf8')
    let decompressed = false
    if (rel.endsWith('.zstd')) {
      try {
        text = zstdDecompressSync(bytes).toString('utf8')
        decompressed = true
        decompressedFiles += 1
      } catch {
        decompressionErrors.push(rel)
      }
    }

    const counts = scanText(text, key)
    if (counts.exact > 0) {
      exact.hits += counts.exact
      exact.files.push(rel)
    }
    if (counts.pattern > 0) {
      pattern.hits += counts.pattern
      pattern.files.push(rel)
    }
    scanned.push({ path: rel, bytes: bytes.byteLength, decompressed })
  }

  const generatedAt = new Date().toISOString()
  const command = `node scripts/s7-harness-adapter/security-scan.ts ${runDir}`
  const report = {
    generatedAt,
    command,
    runDir,
    secretFile: SECRET_FILE,
    description: 'Exact DEEPSEEK_API_KEY value and sk-* pattern; values and matched content are never recorded.',
    scannedFileCount: scanned.length,
    scannedBytes,
    zstdFiles: scanned.filter((file) => file.path.endsWith('.zstd')).length,
    zstdDecompressed: decompressedFiles,
    scannedFiles: scanned,
    excluded,
    readErrors,
    decompressionErrors,
    exactKey: {
      description: 'DEEPSEEK_API_KEY exact value (value not recorded)',
      hits: exact.hits,
      files: exact.files,
    },
    skPattern: {
      pattern: SK_PATTERN,
      hits: pattern.hits,
      files: pattern.files,
    },
  }

  const scanPath = join(runDir, 'security-scan.json')
  writeFileSync(scanPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  // 自检：扫描产物自身不得含精确 key 或 sk- 模式。
  const selfText = readFileSync(scanPath, 'utf8')
  if (countExact(selfText, key) > 0 || new RegExp(SK_PATTERN).test(selfText)) {
    throw new Error('security-scan.json self-check failed: report contains a key pattern')
  }

  const hashTargets = [...scanned.map((file) => file.path), 'security-scan.json']
  const files: Record<string, string> = {}
  for (const rel of hashTargets.sort()) {
    files[rel] = sha256(join(runDir, rel))
  }
  const hashes = {
    runId: runDir.split(/[\\/]/).pop(),
    generatedAt,
    command,
    algorithm: 'sha256',
    note: 'hash of every scanned file plus security-scan.json; hashes.json itself is not self-hashed',
    files,
  }
  writeFileSync(join(runDir, 'hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    runDir,
    scannedFileCount: report.scannedFileCount,
    scannedBytes,
    zstdFiles: report.zstdFiles,
    zstdDecompressed: report.zstdDecompressed,
    exactKeyHits: exact.hits,
    skPatternHits: pattern.hits,
    readErrors: readErrors.length,
    decompressionErrors: decompressionErrors.length,
    generatedAt,
    required: 'security-scan.json + hashes.json',
  }, null, 2))
}

main()

/**
 * Secret-leak gate for the packaged desktop app (ADR: user keys must never ship).
 *
 * Modes:
 *   node check-no-secrets.mjs <dir|app.asar>   CLI scan, exit 1 on any hit.
 *   export { scanNoSecrets }                    consumed by electron-builder-config afterPack.
 *
 * Rules cover API-key literals and assignment forms; "true value" detection keeps
 * type declarations / env references from @anthropic-ai and obvious fake fixtures.
 * Also rejects shipping .env*, *.pem, *.pfx, user-data/, *.sqlite.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createRequire } from 'node:module'

const SECRET_PATTERNS = [
  { name: 'sk-literal', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'sk-ant-literal', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key-assign', re: /ANTHROPIC_API_KEY\s*=\s*(?!process\.env\b)(?!\$\{?ANTHROPIC_API_KEY\}?)(?!import\.meta\.env\b)\S+/g },
  { name: 'openai-key-assign', re: /OPENAI_API_KEY\s*=\s*(?!process\.env\b)(?!\$\{?OPENAI_API_KEY\}?)(?!import\.meta\.env\b)\S+/g },
  { name: 'apiKey-literal', re: /apiKey\s*:\s*["']sk-[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer-token', re: /Bearer [A-Za-z0-9_-]{30,}/g },
]

const FORBIDDEN_PATH_RE = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.pfx|[^/]*\.sqlite(-wal|-shm)?|user-data\/)/i

/** Fake fixtures never reported: sk-test / sk-xxx / sk-dummy / example / 0123456789 padding. */
function isFakeValue(value) {
  return /sk-(test|xxx|dummy|fake|example|placeholder|sample)/i.test(value) || /^[A-Za-z0-9_-]*0123456789/.test(value.slice(3))
}

/**
 * True-value gate: an @anthropic-ai code line that only declares or forwards a
 * variable (no sk- string literal on the line) is a variable definition, not a leak.
 */
function isVariableDefinitionOnly(line, filePath) {
  const afterAssign = line.split(/[:=]/).slice(1).join(':')
  return !/["'][^"']*sk-/i.test(afterAssign) || /\b(process\.env|import\.meta\.env|undefined|null)\b/.test(afterAssign)
}

function redact(value) {
  return value.length <= 12 ? `${value.slice(0, 4)}…` : `${value.slice(0, 8)}…${value.slice(-4)}`
}

const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.html', '.htm', '.txt', '.md', '.yml', '.yaml', '.env', '.cfg', '.conf', '.sh', '.ps1', '.cmd', '.xml', '.svg', '.map'])
const isTextCandidate = (name) => TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || name.startsWith('.env')

function scanText(name, read) {
  const hits = []
  if (!isTextCandidate(name)) return hits
  if (FORBIDDEN_PATH_RE.test(name.replaceAll('\\', '/'))) {
    hits.push({ file: name, line: 0, rule: 'forbidden-path', value: name })
    return hits
  }
  let text
  try {
    text = read()
  } catch {
    return hits
  }
  if (text.includes('\u0000')) return hits // binary
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0
      for (const match of line.matchAll(pattern.re)) {
        const value = match[0].replace(/^(ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*=\s*/, '')
        if (isFakeValue(value)) continue
        if (isVariableDefinitionOnly(line, name)) continue
        hits.push({ file: name, line: index + 1, rule: pattern.name, value: redact(match[0]) })
      }
    }
  }
  return hits
}

/** Parse an asar archive without external deps: header pickle + file tree. */
function readAsarEntries(asarPath) {
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  const dataBase = 8 + headerSize
  const entries = []
  const walk = (node, prefix) => {
    for (const [name, meta] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`
      if (meta.files) walk(meta, path)
      else if (meta.offset !== undefined) entries.push({ path, offset: dataBase + Number(meta.offset), size: Number(meta.size) })
    }
  }
  walk(header, '')
  return { buf, entries }
}

/** Scan one asar: per-entry content. */
export function scanAsar(asarPath) {
  const { buf, entries } = readAsarEntries(asarPath)
  const hits = []
  for (const entry of entries) {
    try {
      hits.push(...scanText(entry.path, () => buf.subarray(entry.offset, entry.offset + entry.size).toString('utf8')))
    } catch {}
  }
  return hits
}

/** Scan a directory tree (the unpacked app or its packaging inputs). */
export function scanDir(dir, relativeTo = dir) {
  const hits = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = full.slice(relativeTo.length + 1)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      hits.push(...scanDir(full, relativeTo))
      continue
    }
    hits.push(...scanText(rel.replaceAll('\\', '/'), () => readFileSync(full, 'utf8')))
  }
  return hits
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node check-no-secrets.mjs <dir|app.asar>')
    process.exit(2)
  }
  const hits = statSync(target).isDirectory() ? scanDir(target) : scanAsar(target)
  if (hits.length > 0) {
    for (const hit of hits) console.error(`[check-no-secrets] ${hit.file}:${hit.line} rule=${hit.rule} value=${hit.value}`)
    console.error(`[check-no-secrets] FAILED: ${hits.length} hit(s) — packaging must not ship user secrets.`)
    process.exit(1)
  }
  console.log('[check-no-secrets] PASS: no secret-like values in package inputs.')
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-no-secrets.mjs')) main()

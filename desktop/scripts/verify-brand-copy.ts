/**
 * Reject official brand names in product UI copy.
 *
 * Technical identifiers stay allowed: package scopes, `dsh-*` ids, wire
 * globals, resource schemes, environment variables, storage keys, the CLI
 * command, and real provider/model names. The locale dictionaries are the
 * product's user-visible surface, so they are the scan boundary.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Locale files that legitimately name the DeepSeek provider or its models. */
const DEEPSEEK_PROVIDER_FILES = new Set([
  'packages/client/ui-model-selection/src/client/locales.ts',
  'packages/client/ui-settings-models/src/client/locales.ts',
  'packages/client/ui-settings-web-search/src/client/locales.ts',
  'packages/experimental/client-ui-cot-translation/src/client/locales.ts',
])

/** Copy files whose brand audit is part of this gate. */
const COPY_FILES = [
  'packages/client/*/src/client/locales.ts',
  'packages/client/*/src/client/locale.ts',
  'packages/client/*/src/client/locales/**/*.ts',
  'packages/client/*/src/client/guide-locales.ts',
  'packages/client/locale/src/locales/*.ts',
  'packages/experimental/*/src/client/locales.ts',
  'packages/experimental/*/src/client/locale.ts',
  'packages/experimental/*/src/client/locales/**/*.ts',
  'apps/desktop/src/locale.ts',
]

/** One forbidden brand-word occurrence. */
export interface BrandCopyViolation {
  readonly file: string
  readonly line: number
  readonly word: string
  readonly text: string
}

/** Technical identifiers allowed to contain `DSH`. */
const DSH_TECHNICAL = /\$DSH_HOME|DSH_[A-Z0-9_]+|__DSH_[A-Z0-9_]+|dsh-|dsh\./

function copyFiles(): string[] {
  return [...new Set(COPY_FILES.flatMap(pattern => globSync(pattern, { cwd: root })))]
    .map(file => file.replaceAll('\\', '/'))
    .sort()
}

function allowedDeepSeek(file: string, line: string): boolean {
  if (DEEPSEEK_PROVIDER_FILES.has(file)) return true
  // The welcome key form names the official model provider; everything else
  // in the shell copy is product wording.
  return file === 'apps/desktop/src/locale.ts' && line.includes('welcomeKeyDescription')
}

/**
 * Find forbidden brand words in one copy file.
 * @param file - repository-relative path.
 * @param source - file contents.
 * @returns every forbidden occurrence with its one-based line.
 */
export function findBrandCopyViolations(file: string, source: string): BrandCopyViolation[] {
  const violations: BrandCopyViolation[] = []
  source.split(/\r?\n/).forEach((text, index) => {
    if (text.includes('深度求索')) {
      violations.push({ file, line: index + 1, word: '深度求索', text: text.trim() })
    }
    if (/\bDSH\b/.test(text) && !DSH_TECHNICAL.test(text)) {
      violations.push({ file, line: index + 1, word: 'DSH', text: text.trim() })
    }
    if (text.includes('DeepSeek') && !allowedDeepSeek(file, text)) {
      violations.push({ file, line: index + 1, word: 'DeepSeek', text: text.trim() })
    }
  })
  return violations
}

function main(): void {
  const files = copyFiles()
  if (files.length === 0) throw new Error('verify-brand-copy: no product locale files discovered')
  const violations = files.flatMap(file =>
    findBrandCopyViolations(file, readFileSync(resolve(root, file), 'utf8')))
  if (violations.length > 0) {
    console.error(`verify-brand-copy: ${violations.length} official brand word(s) in UI copy:`)
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} ${violation.word}: ${violation.text}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`verify-brand-copy: ${files.length} copy file(s) carry Cadre brand wording.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()

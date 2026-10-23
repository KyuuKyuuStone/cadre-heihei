#!/usr/bin/env node
/**
 * Migrate the Cadre provider catalogue into the official Models configuration.
 *
 * The official Models page owns three truths after this migration: `llm-pi-ai`
 * routes in the active profile patch, credential references resolved through
 * `credentials-local`, and the default model selection in `agent-default-model`.
 * This script only reads `cadre.sqlite`; it never writes the ledger, never reads
 * or writes credential values, and never deletes the two legacy tables. Deleting
 * those tables belongs to a later, separate change.
 *
 * Runs are idempotent: the profile patch is rewritten only when the computed
 * configuration differs from what is already there, and each write keeps a
 * timestamped backup beside the document.
 *
 * Usage (default is a dry run that writes nothing):
 *   node scripts/migrate-providers-to-official.mjs --db <cadre.sqlite> --home <DSH_HOME> [--profile desktop]
 *   node scripts/migrate-providers-to-official.mjs --db <cadre.sqlite> --home <DSH_HOME> --apply
 *   node scripts/migrate-providers-to-official.mjs --db <cadre.sqlite> --home <DSH_HOME> --verify
 *   node scripts/migrate-providers-to-official.mjs --db <cadre.sqlite> --home <DSH_HOME> --apply \
 *     --host-url <http://127.0.0.1:PORT> --cookie <cookie>   # also applies session bindings
 *   node scripts/migrate-providers-to-official.mjs --restore <patch.yml.bak-...>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'

const PROFILE_PATCH_ENTRY_IDS = { routes: 'llm-pi-ai', defaultModel: 'agent-default-model' }
const MANAGED_REF_PREFIX = 'CADRE_PROVIDER_'

class MigrationError extends Error {}

function usage() {
  return [
    'usage: migrate-providers-to-official.mjs --db <cadre.sqlite> --home <DSH_HOME> [options]',
    '',
    '  --db <path>       cadre.sqlite to read (opened read-only)',
    '  --home <path>     DSH_HOME containing profiles/<name>/cordis.patch.yml',
    '  --profile <name>  profile directory name (default: desktop)',
    '  --apply           write the profile patch (default: dry run, writes nothing)',
    '  --verify          re-read the profile patch and check every row migrated',
    '  --force-default   overwrite an existing agent-default-model entry',
    '  --host-url <url>  live Host origin; applies session bindings through RPC',
    '  --cookie <value>  Host session cookie used with --host-url',
    '  --json            print the plan as JSON',
    '  --restore <file>  copy a backup over the profile patch and exit',
  ].join('\n')
}

function parseCli(args) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      db: { type: 'string' },
      home: { type: 'string' },
      profile: { type: 'string', default: 'desktop' },
      apply: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      'force-default': { type: 'boolean', default: false },
      'host-url': { type: 'string' },
      cookie: { type: 'string' },
      json: { type: 'boolean', default: false },
      restore: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (values['restore'] !== undefined) return values
  if (values.help === true) return values
  if (values.db === undefined || values.home === undefined) {
    throw new MigrationError('--db and --home are required')
  }
  if (values['host-url'] !== undefined && values.cookie === undefined) {
    throw new MigrationError('--host-url requires --cookie')
  }
  if (values.verify === true) return values
  return values
}

/** Official wire protocol for one Cadre provider kind. */
function protocolFor(kind) {
  return kind === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
}

/** One `llm-pi-ai` route profile derived from a Cadre provider row. */
function routeFor(row) {
  return {
    displayName: row.name,
    api: protocolFor(row.kind),
    ...(row.base_url === null || row.base_url === undefined || row.base_url === ''
      ? {}
      : { baseURL: row.base_url }),
    // Keep the existing reference: the value already lives in the managed
    // credentials document, and this script never reads or moves secrets.
    apiKeyEnv: row.api_key_ref,
    models: parseModels(row.models_json).map(model => ({
      id: model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    })),
    ...(row.kind === 'deepseek' ? { compat: { thinkingFormat: 'deepseek' } } : {}),
  }
}

function parseModels(value) {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(model => typeof model === 'object' && model !== null && typeof model.id === 'string')
  } catch {
    return []
  }
}

/** Read rows without ever opening the database for writing. */
function readPlan(dbPath) {
  if (!existsSync(dbPath)) throw new MigrationError(`database not found: ${dbPath}`)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
    if (!tables.includes('providers')) {
      return { routes: [], defaultSelection: undefined, bindings: [], missingTables: true }
    }
    const rows = db.prepare('SELECT * FROM providers ORDER BY provider_id').all()
    const routes = rows.map(row => ({ id: row.provider_id, profile: routeFor(row), source: row }))
    const preferred = rows.find(row => row.is_default === 1) ?? rows.find(row => row.enabled === 1)
    const defaultSelection = preferred === undefined
      ? undefined
      : { provider: preferred.provider_id, model: preferred.default_model }
    const bindings = tables.includes('session_providers')
      ? db.prepare('SELECT * FROM session_providers').all()
        .map(row => ({ sessionId: row.session_id, provider: row.provider_id, model: row.model }))
      : []
    return { routes, defaultSelection, bindings, missingTables: false }
  } finally {
    db.close()
  }
}

function profilePatchPath(home, profile) {
  return join(resolve(home), 'profiles', profile, 'cordis.patch.yml')
}

/** Patches carry `!!js` expressions; keep them as scalars that round-trip. */
class JsExpression {
  constructor(value) { this.value = value }
}

const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  instanceOf: JsExpression,
  represent: expression => expression.value,
  construct: value => new JsExpression(value),
  resolve: value => typeof value === 'string' && value !== '',
})])

function loadDocument(path) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n'
  let entries
  try {
    entries = yaml.load(text, { schema: PATCH_SCHEMA }) ?? []
  } catch (error) {
    throw new MigrationError(`cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(entries)) throw new MigrationError(`${path} must contain a YAML sequence`)
  return entries
}

function findEntryIndex(entries, id) {
  return entries.findLastIndex(entry => typeof entry === 'object' && entry !== null
    && !Array.isArray(entry) && entry.id === id && entry.insert === undefined)
}

/** Route entries this document currently holds, keyed by route id. */
function currentProviders(config) {
  const providers = config?.providers
  return typeof providers === 'object' && providers !== null && !Array.isArray(providers) ? providers : {}
}

/** Merge managed routes while preserving routes this script does not own. */
function mergeProviders(existing, plan) {
  const managed = new Set(plan.routes.map(route => route.id))
  const next = {}
  for (const [route, config] of Object.entries(existing)) {
    const ref = typeof config === 'object' && config !== null ? config.apiKeyEnv : undefined
    // A stale route we used to manage is dropped; anything else stays untouched.
    if (typeof ref === 'string' && ref.startsWith(MANAGED_REF_PREFIX) && !managed.has(route)) continue
    if (managed.has(route)) continue
    next[route] = config
  }
  for (const route of plan.routes) next[route.id] = route.profile
  return next
}

/** Compute the exact document mutation without applying it. */
function planPatch(document, plan, options) {
  const routeIndex = findEntryIndex(document, PROFILE_PATCH_ENTRY_IDS.routes)
  const currentConfig = routeIndex < 0 ? {} : document[routeIndex].config ?? {}
  const current = currentProviders(currentConfig)
  const providers = mergeProviders(current, plan)
  const providersChanged = !isDeepStrictEqual(current, providers)
  const routeConfig = { ...(typeof currentConfig === 'object' && currentConfig !== null ? currentConfig : {}), providers }

  const defaultIndex = findEntryIndex(document, PROFILE_PATCH_ENTRY_IDS.defaultModel)
  const currentDefault = defaultIndex < 0 ? undefined : document[defaultIndex].config
  let defaultAction = 'keep'
  if (plan.defaultSelection === undefined) defaultAction = 'none'
  else if (defaultIndex < 0) defaultAction = 'add'
  else if (isDeepStrictEqual(currentDefault, plan.defaultSelection)) defaultAction = 'already-current'
  else defaultAction = options.forceDefault ? 'overwrite' : 'keep-existing'

  return { routeIndex, routeConfig, providersChanged, defaultIndex, defaultAction }
}

function serialize(document) {
  return yaml.dump(document, { schema: PATCH_SCHEMA, lineWidth: -1, noRefs: true })
}

function applyPlan(document, plan, computed, options) {
  const writes = []
  if (computed.providersChanged) {
    if (computed.routeIndex < 0) {
      document.push({
        id: PROFILE_PATCH_ENTRY_IDS.routes,
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: computed.routeConfig,
      })
    } else {
      document[computed.routeIndex] = { ...document[computed.routeIndex], config: computed.routeConfig }
    }
    writes.push('llm-pi-ai.providers')
  }
  if (computed.defaultAction === 'add') {
    document.push({
      id: PROFILE_PATCH_ENTRY_IDS.defaultModel,
      name: '@deepseek-ai/dsh-agent-default-model',
      config: plan.defaultSelection,
    })
    writes.push('agent-default-model.config')
  } else if (computed.defaultAction === 'overwrite') {
    document[computed.defaultIndex] = { ...document[computed.defaultIndex], config: plan.defaultSelection }
    writes.push('agent-default-model.config (forced)')
  }
  return writes
}

function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = `${path}.bak-${stamp}`
  copyFileSync(path, target)
  return target
}

/** Compare the applied document against the rows it claims to carry. */
function verify(document, plan, patchPath) {
  const problems = []
  const routeIndex = findEntryIndex(document, PROFILE_PATCH_ENTRY_IDS.routes)
  const providers = routeIndex < 0 ? {} : currentProviders(document[routeIndex].config)
  for (const route of plan.routes) {
    const actual = providers[route.id]
    if (actual === undefined) {
      problems.push(`${route.id}: route missing`)
      continue
    }
    if (!isDeepStrictEqual(actual, route.profile)) problems.push(`${route.id}: route fields differ from the ledger row`)
    else console.log(`PASS route ${route.id} (${route.profile.models.length} models, apiKeyEnv=${route.profile.apiKeyEnv})`)
  }
  const defaultIndex = findEntryIndex(document, PROFILE_PATCH_ENTRY_IDS.defaultModel)
  const actualDefault = defaultIndex < 0 ? undefined : document[defaultIndex].config
  if (plan.defaultSelection !== undefined) {
    if (isDeepStrictEqual(actualDefault, plan.defaultSelection)) {
      console.log(`PASS default model ${plan.defaultSelection.provider}/${plan.defaultSelection.model}`)
    } else {
      console.log(`WARN default model is ${JSON.stringify(actualDefault)}, ledger prefers ${JSON.stringify(plan.defaultSelection)}`)
    }
  }
  console.log(`INFO patch=${patchPath}`)
  console.log(`INFO session bindings in ledger=${plan.bindings.length} (applied only with --host-url/--cookie)`)
  console.log('INFO connectivity and Models-page rendering cannot be checked offline: open Settings → Models and confirm each row, its key dot, then pick a model in a new session')
  return problems
}

function printPlan(plan, computed, patchPath, json) {
  if (json === true) {
    console.log(JSON.stringify({
      patch: patchPath,
      routes: plan.routes.map(route => route.id),
      providersChanged: computed.providersChanged,
      defaultSelection: plan.defaultSelection ?? null,
      defaultAction: computed.defaultAction,
      bindings: plan.bindings,
    }, null, 2))
    return
  }
  console.log(`plan: ${plan.routes.length} provider row(s) from the ledger`)
  for (const route of plan.routes) {
    const row = route.source
    console.log(`  - ${route.id} → llm-pi-ai route: api=${route.profile.api}` +
      `${route.profile.baseURL === undefined ? '' : ` baseURL=${route.profile.baseURL}`}` +
      ` models=${route.profile.models.map(model => model.id).join(',')}` +
      ` keyRef=${row.api_key_ref} enabled=${row.enabled === 1 ? 'yes' : 'no'}` +
      `${row.is_default === 1 ? ' (ledger default)' : ''}`)
  }
  if (plan.defaultSelection === undefined) console.log('  default model: none to migrate')
  else {
    console.log(`  default model ${plan.defaultSelection.provider}/${plan.defaultSelection.model}` +
      ` → agent-default-model (${computed.defaultAction})`)
  }
  console.log(`  session bindings to apply via RPC: ${plan.bindings.length}`)
  console.log(`  llm-pi-ai.providers ${computed.providersChanged ? 'would change' : 'already current'}`)
  console.log(`  patch: ${patchPath}`)
  if (computed.defaultAction === 'keep-existing') {
    console.log('  NOTE official default already differs; pass --force-default to replace it')
  }
}

/** Minimal authenticated Host RPC client, mirroring apps/desktop/src/provider-runtime.ts. */
async function hostRpc(hostUrl, cookie, namespace, method, args) {
  const rpcId = randomUUID()
  const rpcMethod = `${namespace}/${method}`
  const response = await fetch(new URL(`/api/${rpcMethod}`, new URL(hostUrl).origin), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: rpcMethod, payload: { args } }),
  })
  if (!response.ok) throw new MigrationError(`host rpc ${rpcMethod}: http ${response.status}`)
  const envelope = await response.json()
  if (envelope.type !== 'server-response' || envelope.result?.ok !== true) {
    throw new MigrationError(`host rpc ${rpcMethod}: rejected ${JSON.stringify(envelope.result?.error ?? null)}`)
  }
  return envelope.result.value
}

/** Apply ledger session bindings through the official session API. */
async function applyBindings(plan, hostUrl, cookie) {
  if (plan.bindings.length === 0) return
  for (const binding of plan.bindings) {
    await hostRpc(hostUrl, cookie, 'session', 'selectModel', {
      sessionId: binding.sessionId, provider: binding.provider, model: binding.model,
    })
    console.log(`PASS binding ${binding.sessionId} → ${binding.provider}/${binding.model}`)
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help === true) {
    console.log(usage())
    return
  }
  if (options.restore !== undefined) {
    const match = /^(?<target>.+)\.bak-\d/u.exec(options.restore)
    if (match?.groups?.target === undefined) {
      throw new MigrationError('--restore expects a .bak-<timestamp> file written by this script')
    }
    if (!existsSync(options.restore)) throw new MigrationError(`backup not found: ${options.restore}`)
    copyFileSync(options.restore, match.groups.target)
    console.log(`restored ${match.groups.target} from ${options.restore}`)
    return
  }
  const patchPath = profilePatchPath(options.home, options.profile)
  const plan = readPlan(options.db)
  if (plan.missingTables) {
    console.log('providers table not found: nothing to migrate (an empty or pre-④ database)')
    return
  }
  const document = loadDocument(patchPath)
  const computed = planPatch(document, plan, { forceDefault: options['force-default'] === true })
  printPlan(plan, computed, patchPath, options.json === true)

  if (options.verify === true) {
    const problems = verify(document, plan, patchPath)
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL ${problem}`)
      process.exitCode = 1
    }
    return
  }
  if (options.apply !== true) {
    console.log('dry run: nothing written (pass --apply to write)')
    return
  }
  const writes = applyPlan(document, plan, computed, { forceDefault: options['force-default'] === true })
  if (writes.length > 0) {
    const target = backup(patchPath)
    writeFileSync(patchPath, serialize(document))
    console.log(`wrote ${writes.join(', ')}`)
    console.log(`backup ${target}`)
  } else {
    console.log('no change: profile patch already matches the ledger')
  }
  if (options['host-url'] !== undefined) await applyBindings(plan, options['host-url'], options.cookie)
}

main().catch(error => {
  console.error(error instanceof MigrationError ? error.message : error)
  process.exitCode = 1
})

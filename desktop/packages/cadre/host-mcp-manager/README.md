# @deepseek-ai/dsh-host-mcp-manager

Per-session MCP servers for Cadre: a machine-local catalog the operator curates,
a per-session selection, and `agent/pre-step` mounting of the selected servers as
`mcp-client` child fibers in that session's agent scope.

## Model Experience

A session with nothing selected sees no MCP tool and no prompt text: the manager
contributes no tools, no prompt section, and no message of its own.

Selecting a server makes that server's tool schemas appear exactly as
`mcp-client` publishes them (`mcp__<id>__<tool>`) inside that session's step, and
only there. Two sessions selecting the same id get independent transports.

Token and cache effects are inherited from `mcp-client`: enabling a server pays
its schema cost for that session, and a step keeps the same tool list while the
resolved config is unchanged, so the prompt prefix stays stable across steps. A
changed selection or a changed resolved config disposes the old fiber before
mounting the new one; the resulting tool-list change is `mcp-client`'s existing
generation swap, not a new model-visible input from the manager.

## Configuration

| Field | Environment | Default |
|---|---|---|
| `mcpDir` | `CADRE_MCP_DIR` | `~/.dsh/cadre-mcp/servers` |
| `ledgerPath` | `CADRE_LEDGER_PATH` | required; the manager stays inert without it |

`CADRE_LEDGER_PATH` is the Cadre ledger shared with the other host plugins. The
manager adds one table, `session_mcp`, created on first write; it never migrates
or rewrites the collaboration schema.

## Catalog

One directory per server under the catalog root, each holding `manifest.json`:

```json
{
  "id": "github",
  "name": "GitHub",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": { "fromEnv": "GITHUB_TOKEN" } }
}
```

`id` is the `mcp-client` `serverName`, so it fixes the model-facing tool prefix and
must not change after the entry exists. `env` and `headers` values must be
`{ "fromEnv": "NAME" }` references for credential-shaped names; the manager
rejects plaintext secrets and resolves references only in memory at mount time.

A directory whose manifest fails validation becomes a health row and leaves its
neighbours usable. Dot-directories such as `.backups` are never scanned.

A manifest may carry `descriptionI18n {zh, en}` beside `description`. A route call
that names a `locale` reads `descriptionI18n.zh` when the locale starts with `zh`,
otherwise `descriptionI18n.en`, falling back to `description`; blank translations
are dropped while parsing, so an empty entry never shadows the base field. Without
a locale the English entry wins, matching the skill catalog. `catalog` projects the
result onto `description`, and `get` projects it onto each entry's
`localizedDescription`, so a manifest that carries only `descriptionI18n` still
surfaces readable text.

## Routes

`POST /cadre/mcp/catalog`, `/cadre/mcp/get`, `/cadre/mcp/set` behind
`connection.admit`, a 16 KiB body limit, and `{ok:false, code, message,
remediation}` failures. `catalog` and `get` accept an optional `locale` and
localize descriptions as described above. Reads tolerate a session the ledger
cannot prove (an
empty team owns the project id first); cross-member reads and writes are
supervisor-only, departed members are refused, and a session may only override
`toolCallTimeoutMs` and `env` references — never the command, arguments, URL, or
headers of a catalog entry.

## Known Limitations and Deferred Work

- P1 covers the catalog, the selection, the pre-step mount, and the three routes
  above. The global library page and the member dialog (add/remove/test/preview)
  are P2: the manager exposes no route that writes the catalog yet.
- The step mounts what the ledger says; it does not probe a server to decide
  whether the selection is still valid. A server that fails to start is reported
  by `mcp-client` on its own channel and leaves the step running.
- Mount state lives in this plugin instance. A restart re-derives mounts from
  `session_mcp` on the next step, which is the intended recovery path.
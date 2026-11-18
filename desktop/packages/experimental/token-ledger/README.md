---
description: "Replay-aware token usage ledger with per-Session and per-process cumulative totals."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-token-ledger

English | [中文](README.zh.md)

## Summary

`ctx.tokenLedger` mirrors the provider token usage already committed on `assistant/message` events into ignorable `plugin:token-ledger/usage` records and answers per-Session and process-wide cumulative totals from them. The records survive surface compaction, fork, and resume without changing `SESSION_FORMAT_VERSION` or adding model-visible content. This experimental package is opt-in; a deployment without it keeps no ledger records.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package after the Session store and the projection registry, for example as one `cordis.yml` row:

```yaml
- id: token-ledger
  name: '@deepseek-ai/dsh-experimental-token-ledger'
```

The plugin has no configuration and no shipped composition contains that row, so the default product behavior is unchanged. Removing the row, or overriding it from a patch with `disabled: true`, stops new records and removes its projection unit; records already stored stay readable by a later mount.

Read the ledger through the service:

| Call | Returns |
|---|---|
| `get(session)` | `TokenLedgerReport` for one live `Session` |
| `forSession(sessionId)` | The same report for a live or already disposed Session, or `undefined` when this process never observed it |
| `global()` | `TokenLedgerGlobalReport` over every Session this process observed |

A report carries `entries` (one row per mirrored provider call, in commit order) and `totals`. Totals keep the provider's disjoint `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` buckets, plus `requests` and `billedTokens`. `billedTokens` is `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`; reasoning tokens are already part of `outputTokens` and are not billed again.

Every row also names the mirrored event's `sourceSeq`, `turn`, `step`, and the producing `provider` and `model`, so a caller can attribute totals to one step without re-reading the conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

A `session/event` observer mirrors every committed `assistant/message` that carries provider `usage` into one `appendPluginRecord(session, 'plugin:token-ledger/usage', payload)` record. The append is deferred to a microtask because a Session refuses to publish an event from inside its own publication, where observers run; a Session disposed before that microtask runs loses the record, and a failed append is logged instead of thrown into the microtask queue. Records are ordinary ignorable plugin records: the projection surface derives no message from them, `SESSION_FORMAT_VERSION` stays unchanged, and a reader without this package retains and skips them.

The folded state lives in the `ctx.sessionProjections` unit `tokenLedger`. Its `apply` validates each record against the payload schema, ignores a record whose `sourceSeq` is already counted (duplicate recorder instances after an HMR reload), and keeps an immutable `{ entries, totals }` value. The projection materializes lazily over the in-memory log, so a Session resumed from storage rebuilds its entries and totals from the stored records on first read without the deprecated synchronous event readers.

`session/disposed` snapshots the folded state before the Session leaves the store, which keeps `forSession()` and `global()` able to report a closed Session for the rest of the process. `session/created` drops a stale snapshot for a reused id. The process-wide view is deliberately not durable: a restart starts with no retired snapshots and recovers each Session's totals when that Session is opened.

Registration is an effect: unloading the plugin fiber disposes the projection registration and both listeners, so later turns append no records and `stateOf(session, 'tokenLedger')` reports the key as absent.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Session projections](../../session/session-projection/README.md) · [Experimental packages](../README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the ledger only mirrors usage already committed by the model loop and adds no prompt, tool, or result content.

#### KV Cache effect

The ledger sends no model request and changes no request prefix, so it has no cache effect; its ignorable records are excluded from the model-visible surface.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Records are appended after the `assistant/message` event they mirror, so a Session disposed between that commit and the deferred microtask loses one record. The ledger reports the remaining records and never blocks the loop.
- The process-wide view counts the live Sessions this process observed plus the Sessions it disposed; it resets on restart until each Session is opened again.
- Ledger records are best-effort retained across future Session-format migrations, like every plugin record. They are not compacted or pruned, so entries grow with the conversation.
- A stored record that violates the payload schema fails the projection fold with an explicit error instead of being skipped; the Session's ledger reads fail until the record is repaired.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

`tests/token-ledger.spec.ts` boots the real Loader composition — Session store, JSONL persistence, the projection registry, and this plugin — records usage, flushes it, and reads the stored log. It covers restart reconstruction, retention after Session disposal and fiber unload, and the process-wide totals.

</details>

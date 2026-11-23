---
description: "The context compaction settings page on the dsh web client's Plugins page: automatic compaction and the live pressure-budget ratio."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-compaction

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Context compaction** in the Official group to control automatic compaction and the pressure-budget ratio. The page distinguishes an inherited value from explicit on and off states, stages edits until save, and resets either field to the deployment composition. It exists only while the Host serves the `compaction-settings` namespace.

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

**Automatic compaction** offers **Follow deployment**, **On**, and **Off**. **Pressure threshold ratio** accepts a finite number greater than 0 and no more than 1; a lower value compacts earlier. Leave it blank to follow the deployment. An overridden field carries an **Overridden** badge and **Reset to default**. Nothing is written until **Save**; leaving the page drops the draft, invalid input blocks saving, and a refused save keeps the draft. The page also explains the pressure budget, overflow recovery, and manual `/compact`, while identifying deployment-owned safety limits as read-only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `compaction-settings` namespace through `ctx.configForms.get`, keeps both staged fields in `CompactionCardController` over the shared `SettingsFormModel` of `ui-primitives`, and registers `CompactionCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`. The page's copy lives in this package's `settings.compaction` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [compaction-basic](../../compaction/compaction-basic/README.md) — the compaction behavior and the volatile Host settings namespace.

-----

<a id="model-experience"></a>
## Model Experience

This package adds no model-facing prompt, tool, or request field. Its saved values change the Host compaction behavior documented by `compaction-basic`.

#### KV Cache effect

This package neither assembles nor sends a provider request; the underlying compaction engine owns any KV-cache effect of applying the saved values.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Volatile fields only** — the page edits only `auto` and `thresholdRatio`. Absolute capacity, retention, step-pressure, and overflow-retry safety fields remain deployment-owned and read-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

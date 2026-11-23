---
kind: upgrade-guide
description: "1.6.3 changes compaction-basic thresholdRatio from a fraction of the raw context window to a fraction of the pressure budget after the output reservation and headroom, and raises the default ratio from 0.8 to 0.9; identical explicit ratios trigger no later, while shipped Cadre presets move their trigger later."
---

# Compaction threshold ratio now applies to the pressure budget

English | [中文](guide.zh.md)

## Change

In 1.6.3, `compaction-basic` computes the automatic condensation trigger as `floor(min((W − O − headroomTokens) × thresholdRatio, thresholdTokens))`, where `W` is the routed context window and `O` its output reservation; the 1.6.2 formula was `floor(min(W × thresholdRatio, W − O − headroomTokens, thresholdTokens))`. Other fields, defaults, and validation are unchanged. For any explicit ratio the new threshold is at most the old one — `B = W − O − headroomTokens` is smaller than `W` whenever headroom is positive — so identical explicit ratios condense no later, possibly sooner; whether summarization becomes more frequent depends on the resolved trigger.

The default `thresholdRatio` rises from 0.8 (1.6.2) to 0.9 (1.6.3), so the net effect on default configurations depends on what the old value resolved to. On a 1,000,000-token route (output reservation 256,000, default headroom 65,536, `B = 678,464`), the old default 0.8 was clipped by `B` and triggered at 678,464; the new default 0.9 triggers at 610,617, still earlier (−67,847). Same-ratio comparison under the new formula: `0.9` moves 678,464 to 610,617, `0.8` to 542,771.

Shipped Cadre presets differ because their old trigger was pinned by an explicit cap, not the ratio: the 1.6.2 preset set `thresholdTokens: 120000`, so both Cadre routes triggered at 120,000; the 1.6.3 preset sets `thresholdTokens: 727040` with the default 0.9 ratio, triggering at 654,336 on the 1,048,576-token route and 275,817 on the 500,000/128,000 profile. Cadre default upgrades therefore condense later and less often. The cap still bounds the result, and shipped `retainTokens` (10,000) stays below every trigger. See the [compaction-basic README](../../../../packages/compaction/compaction-basic/README.md) for the full configuration table.

## Migration

Recompute each route's trigger as `floor(min((W − O − headroomTokens) × thresholdRatio, thresholdTokens))` and confirm it stays above the retained budget — a resolved `retainTokens` at least as large as the threshold rejects the plugin at load. To keep an old trigger with an unchanged cap, solve per route: `r_new = min(1, min(W × r_old, B) / B)`; that ratio is usually higher than `r_old` (for example 0.9 to 1.0). Do not assume a single value preserves every route's old trigger — compute per route, though routes may coincidentally share a valid value. If the old trigger was pinned by explicit `thresholdTokens`, keep it and set the per-route ratio accordingly.

Manual `/compact` condenses on demand regardless of the automatic threshold. The hard ceiling still caps the ratio, context-overflow recovery bypasses the threshold, and `auto: false` disables only proactive pressure checks and overflow retries while keeping `/compact` available. `compaction-settings` writes only the default policy's `auto` and `thresholdRatio`; an exact `modelPolicies` entry for the routed target still wins.

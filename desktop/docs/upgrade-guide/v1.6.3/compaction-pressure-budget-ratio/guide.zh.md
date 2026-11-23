---
kind: upgrade-guide
description: "1.6.3 将 compaction-basic 的 thresholdRatio 从原始上下文窗口的比例改为输出预留与 headroom 之后压力预算的比例，默认比例由 0.8 提升至 0.9；相同显式比例触发不更晚、可能提前，而随附 Cadre 预设的触发点后移。"
---

# 压缩阈值比例现应用于压力预算

[English](guide.md) | 中文

## 变更

1.6.3 中，`compaction-basic` 以 `floor(min((W − O − headroomTokens) × thresholdRatio, thresholdTokens))` 计算自动压缩触发点，其中 `W` 为路由模型的上下文窗口、`O` 为其有效输出预留；1.6.2 的公式为 `floor(min(W × thresholdRatio, W − O − headroomTokens, thresholdTokens))`。其余字段、默认值与校验不变。对任意显式比例，新触发点至多等于旧触发点——`B = W − O − headroomTokens` 在 headroom 为正时恒小于 `W`——因此相同显式比例下压缩不更晚、可能提前；摘要是否更频繁取决于解析出的触发点。

默认 `thresholdRatio` 由 1.6.2 的 0.8 提升至 1.6.3 的 0.9，默认配置的净效果取决于旧值实际解析出的触发点。在 1,000,000-token 路由（输出预留 256,000、默认 headroom 65,536、`B = 678,464`）上，旧默认 0.8 被 `B` 截断、触发于 678,464；新默认 0.9 触发于 610,617，仍提前（−67,847）。新公式下同比例对照：`0.9` 将 678,464 移至 610,617，`0.8` 移至 542,771。

随附 Cadre 预设不同：其旧触发点由显式上限钉定而非比例。1.6.2 预设设 `thresholdTokens: 120000`，两条 Cadre 路由均触发于 120,000；1.6.3 预设设 `thresholdTokens: 727040` 并采用默认 0.9 比例，在 1,048,576-token 路由触发于 654,336、在 500,000/128,000 profile 触发于 275,817。因此 Cadre 默认升级压缩更晚、更少。上限仍封顶结果，随附 `retainTokens`（10,000）低于每个触发点。完整配置表见 [compaction-basic README](../../../../packages/compaction/compaction-basic/README.zh.md)。

## 迁移

以 `floor(min((W − O − headroomTokens) × thresholdRatio, thresholdTokens))` 逐路由重算触发点，并确认其高于该路由保留预算——解析出的 `retainTokens` 不小于触发点会导致插件加载被拒。在 cap 不变时保持旧触发点，逐路由求解 `r_new = min(1, min(W × r_old, B) / B)`；该比例通常高于 `r_old`（例如 0.9 至 1.0）。不得假定单一取值能保持所有路由的旧触发点，须逐路由计算（不同路由可能恰好共用有效值）。若旧触发点由显式 `thresholdTokens` 钉定，保留该显式值并按路由设置比例。

手动 `/compact` 按需压缩，不受自动阈值影响。硬上限仍封顶比例，上下文溢出恢复完全绕过自动阈值；`auto: false` 仅关闭主动压力检查与溢出重试，`/compact` 仍可用。`compaction-settings` 命名空间只写默认策略的 `auto` 与 `thresholdRatio`；路由目标的精确 `modelPolicies` 条目仍然优先。

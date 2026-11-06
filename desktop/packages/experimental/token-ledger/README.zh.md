---
description: "可回放重建的 token 用量账本，提供会话级与进程级累计统计。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-token-ledger

[English](README.md) | 中文

## 概述

`ctx.tokenLedger` 把 `assistant/message` 事件中已经提交的提供商 token 用量镜像为可忽略的 `plugin:token-ledger/usage` 记录，并据此回答会话级与进程级累计统计。这些记录在表面压缩、分叉和恢复后仍然存在，既不改变 `SESSION_FORMAT_VERSION`，也不增加模型可见内容。该实验包为可选项；未挂载时不会保留任何账本记录。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在会话存储与投影注册表之后挂载该包，例如作为一条 `cordis.yml` 配置行：

```yaml
- id: token-ledger
  name: '@deepseek-ai/dsh-experimental-token-ledger'
```

该插件没有配置项，且没有任何随产品发布的组合包含该行，因此默认产品行为不变。删除该行，或在 patch 中将其覆盖为 `disabled: true`，都会停止写入新记录并移除其投影单元；已存储的记录在之后重新挂载时仍可读取。

通过服务查询账本：

| 调用 | 返回 |
|---|---|
| `get(session)` | 一个活跃 `Session` 的 `TokenLedgerReport` |
| `forSession(sessionId)` | 活跃或已销毁会话的同一报告；本进程从未观察过该会话时返回 `undefined` |
| `global()` | 覆盖本进程观察到的每个会话的 `TokenLedgerGlobalReport` |

一份报告包含 `entries`（每个被镜像的提供商调用一行，按提交顺序排列）与 `totals`。统计保留提供商互不重叠的 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 与 `reasoningTokens` 分桶，另含 `requests` 与 `billedTokens`。`billedTokens` 等于 `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`；推理 token 已属于 `outputTokens`，不会重复计费。

每行还记录被镜像事件的 `sourceSeq`、`turn`、`step`，以及产生用量的 `provider` 与 `model`，因此调用方无需重读对话即可把统计归因到具体步骤。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 —— 点击展开</summary>

`session/event` 观察者把每个携带提供商 `usage` 的已提交 `assistant/message` 镜像为一条 `appendPluginRecord(session, 'plugin:token-ledger/usage', payload)` 记录。追加操作被推迟到微任务执行，因为会话拒绝在自身发布过程中（观察者运行的位置）发布新事件；若会话在该微任务运行前被销毁，这条记录会丢失；若追加失败，错误只写入日志，而不会抛进微任务队列。记录就是普通的可忽略插件记录：投影表面不会从中派生任何消息，`SESSION_FORMAT_VERSION` 保持不变，未安装本包的读取方会保留并跳过它们。

折叠后的状态存放在 `ctx.sessionProjections` 的 `tokenLedger` 单元中。它的 `apply` 按负载 schema 校验每条记录，忽略 `sourceSeq` 已被计入的记录（HMR 重载后可能出现重复记录器实例），并保持不变的 `{ entries, totals }` 值。投影通过内存日志惰性构建，因此从存储恢复的会话会在首次读取时依据已存记录重建条目与统计，无需使用已弃用的同步事件读取接口。

`session/disposed` 会在会话离开存储前保存折叠状态的快照，使 `forSession()` 与 `global()` 在本进程余下的时间里仍能报告已关闭的会话。`session/created` 会丢弃同一 id 的过期快照。进程级视图有意不做持久化：重启后既没有已销毁快照，每个会话的统计会在该会话被打开时恢复。

注册本身是一个 effect：卸载插件 fiber 会同时移除投影注册与两个监听器，因此之后的轮次不再追加记录，`stateOf(session, 'tokenLedger')` 会把该键报告为不存在。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[会话投影](../../session/session-projection/README.zh.md) · [实验性包](../README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为账本只镜像模型循环已经提交的用量，不增加任何提示词、工具或结果内容。

#### KV Cache effect

账本不发送模型请求，也不改变请求前缀，因此没有缓存影响；其可忽略记录不进入模型可见表面。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 记录在被镜像的 `assistant/message` 事件之后追加，因此若会话在提交与推迟的微任务之间被销毁，会丢失一条记录。账本报告其余记录，且从不阻塞循环。
- 进程级视图统计本进程观察到的活跃会话与其销毁的会话；重启后会重置，直到各会话再次被打开。
- 与所有插件记录一样，账本记录在未来会话格式迁移中只做尽力保留。记录不会被压缩或清理，条目随对话增长。
- 违反负载 schema 的已存记录会让投影折叠显式报错，而不是被跳过；在记录被修复前，该会话的账本读取会失败。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 —— 点击展开</summary>

`tests/token-ledger.spec.ts` 启动真实的 Loader 组合——会话存储、JSONL 持久化、投影注册表与本插件——记录用量、刷写并读取已存日志。测试覆盖重启后的重建、会话销毁与 fiber 卸载后的保留，以及进程级统计。

</details>

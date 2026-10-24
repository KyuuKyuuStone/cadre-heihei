# 派活结构化回传、待派队列与可靠重试（2026-10-24）

## 1. presentationMeta（前端读 meta，不再解析文本）

`dispatch_task` 与 `retry_dispatch` 的 output 都声明 `presentationMeta`：

```ts
{
  dispatched: [{ taskId, assigneeName, role, dueAt }],
  failed: [{ target, reason, retryable, pendingId? }]
}
```

- 持久化位置：官方 tool result 的 `meta`（`defineTool` 的 `output.presentationMeta`
  由 registry 写入并随消息持久化，replay 可读——与 `read` 工具的读卡 meta 同一机制）。
- tool 输出 schema 同步为结构化 `dispatched/failed`（failed 含 `retryable`、可选 `pendingId`）；
  文本 `render` 仅作无 UI 时的兜底展示，前端不得解析。
- `retryable`：找不到员工/已离职（`待派：…`）与投递失败为 true；`dueAt` 非法为 false。

## 2. 待派队列（落库，重试的事实来源）

新表 `pending_dispatch`（cadre.sqlite，Host 侧建）：

```
pending_id PK, project_id, dispatcher_session_id,
employee, title, body, due_at,          -- 原始 spec 快照
reason, retryable, status('pending'|'dispatched'), attempts, task_id,
created_at, updated_at
```

- 每次 dispatch 失败且 `retryable=true` 时由 `failRow` 写入，返回其 `pendingId`（含 meta）。
- 成功后 `status=dispatched` 且记 `task_id`、`attempts+1`；再次失败只累加 attempts 与最新 reason。

## 3. 可靠重试：`retry_dispatch(pendingId)`

- 参数只有 `pendingId`：**从待派行读回原始 employee/title/body/dueAt 直接重跑**，
  不经过模型重新理解、不依赖主管「照做」。
- 只在主管/用户会话可调用；目标条已派出则明确报「无需重试」。
- 复用与首派相同的 `dispatchOne`（幂等指纹、逐条投递、失败回滚），所以重试语义与首派一致。
- 返回结构同 dispatch（`dispatched/failed` + 同一 presentationMeta）。

## 4. 实测（`D:/xxw_p/cadre-spike-env/s-loop7`，commit 见汇报）

1. 派给尚不存在的「员工乙」→ 失败并入库：
   `pending row {pending_id: b863cafd…, employee: 员工乙, status: pending, retryable: 1}`
2. 新建「员工乙」后调用 `retry_dispatch(b863cafd…)` →
   `retry ok pending=b863cafd… task=4114b566…`，待派行变为
   `{status: dispatched, task_id: 4114b566…, attempts: 1}`。
3. 全程无模型重规划：重试请求只带 pendingId。

## 5. 前端契约

- 读 tool result 的 `meta.dispatched / meta.failed`；`failed[].retryable` 决定按钮是否可点，
  点击时用 `failed[].pendingId` 触发 `retry_dispatch`（走主管会话工具通道或后续直连 IPC）。
- 状态条文案可随意改，不影响数据。

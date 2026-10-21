# 协作协议与引擎端口 · 类型草案 v0（W1-04）

> 状态：**类型草案，未实现**。作者：架构师。日期：2026-10-21。任务：W1-04（台账 `55d429a1`）。
> 本目录只有类型与契约常量；状态迁移、校验器、通道、持久化均未实现。实现属 W1-05/W1-06/W1-08，另行派单。
> 契约冲突时以 `docs/product/backend/01-数据契约草案.md`、ADR 与 `docs/pending-verification.md` 为准；本文件与它们冲突即为缺陷。

## 1. 评审范围

### 1.1 本任务产出

| 文件 | 职责 |
|---|---|
| `ids.ts` | 品牌 ID、`apiVersion`、UTC 时间戳、SHA-256 |
| `common.ts` | 通道、投递状态、回执自证字段、台账推进结果、空集合 |
| `task-status.ts` | 状态全集、迁移规则/权限矩阵、review 必经、rework、取代语义 |
| `errors.ts` | 错误码表、可重试性、`MISSING_TASK_ID` 候选、跨项目拒绝结构 |
| `dispatch.ts` | 派活请求/回执、前置校验、取代规则 |
| `report.ts` | 汇报请求/回执、漏 taskId 的入口形态 |
| `roster.ts` | 花名册、项目隔离、双口径、全局不可派活 |
| `index.ts` | 协议公共出口 |
| `../../ports/engine.ts` | EnginePort、能力位、事件流、错误结构（零 harness 类型） |
| `../../ports/index.ts` | 端口公共出口 |

### 1.2 依据

`docs/product/backend/01` §0/§1.2/§1.3/§2/§3/§6；`docs/product/frontend/01` §1.3/§2.3/§3.3；`docs/product/implementation/01` §1.4/§1.6；`docs/product/testing/01` §2/§3；`docs/product/testing/02` §1/§2；`docs/handover/02` 铁律 1/6/8/11；ADR-0003/0014/0015/0017；`docs/pending-verification.md`（2026-10-21 版）。

### 1.3 不在范围

实现代码、运行时校验、SQLite schema/仓储端口（等 B5）、UI 字段最终契约、MCP 工具 schema、证据卡结构与注入（等 A1/ADR-0015）。

## 2. 契约摘要

### 2.1 状态机与权限矩阵

来源：`backend/01` §1.3；审查口径 `review/01` §4。规则表是单一事实源 `TASK_TRANSITION_RULES`。

| from → to | 执行者 | 说明 |
|---|---|---|
| dispatched → accepted | assignee | 员工接受 |
| dispatched / accepted / in_progress / delivered / review / rework → cancelled | supervisor | 任意非终态可取消 |
| accepted → in_progress | assignee | 开始执行 |
| in_progress → delivered | assignee 或 system | 汇报投递成功时系统以员工名义原子推进 |
| delivered → review | supervisor | **review 必经**；主管点名进入 |
| review → verified / rework / failed | supervisor | 验收三分支 |
| rework → in_progress | assignee | 同一 taskId，attempt +1 |

不变量（`TASK_LEDGER_RULES`）：终态不可迁移；delivered 不得跳过 review；每次迁移写审计事件；取代时旧任务置 cancelled（reason=`superseded`），禁止静默并存。

### 2.2 派活/汇报

- 派活：`projectId`、`toSessionId`、`title`、`body`、`idempotencyKey`、可选 `supersedesTaskId`；前置拒绝空正文与客户端命令，目标须为本项目成员且非 offline。
- 汇报：必须显式 `taskId`；入口类型 `ReportRequestInput` 允许 `taskId` 缺失，以便返回 `MISSING_TASK_ID` + 候选，**不得自动挂靠**。
- 两个回执均含服务端实收的 `bodyBytes` / `preview` / `bodySha256`；`ledgerUpdated: false` 必须附 `ledgerError`，不得伪报成功。
- 幂等：同一 `(project_id, idempotency_key)` 重复提交返回首次回执；同键不同正文 → `IDEMPOTENCY_CONFLICT`。

### 2.3 错误码

| code | 场景 | retryable（U-08） |
|---|---|---|
| `MISSING_TASK_ID` | 汇报漏 taskId（附候选） | false |
| `TASK_NOT_FOUND` | 同项目内不存在 | false |
| `CROSS_PROJECT_DENIED` | 跨项目（不泄露存在性） | false |
| `INVALID_TRANSITION` | 状态机不允许 | false |
| `FORBIDDEN_ACTOR` | 角色/归属无权 | false |
| `EMPTY_BODY` | 派活空正文 | false |
| `CLIENT_COMMAND_REJECTED` | 派活含客户端命令 | false |
| `IDEMPOTENCY_CONFLICT` | 同键不同正文 | false |
| `DELIVERY_FAILED` | 通道投递失败（显式报错、不静默改道） | true |
| `INTERNAL_ERROR` | 未映射引擎/内部错误（附原始码） | true（待确认） |

### 2.4 跨项目与空态

- `project_id` 一律取调用方会话绑定，忽略请求体；跨项目拒绝**不含**候选、任务字段或存在性提示（类型中 `candidates?: never` 等为编译期约束）。
- 空集合统一为 `EmptyList<T>`：`empty: true` + `reason` + `hint`（铁律 11）；空不是 error。
- 全局花名册只能读摘要：`dispatchable: false`、`dispatchableCount: 0`，不得用于派活。

### 2.5 EnginePort 能力位（来自实测，不是愿望）

| 能力 | 取值 | 依据 | 状态 |
|---|---|---|---|
| `manualCompact` | `false` | N8；S3 手动 `/compact` 0 事件 | 实测不可用 |
| `tokenUsage` | `false` | N9；usage/shadowed 未暴露 | 实测不可得 |
| `mcpTools` | `true` | S5b B1-B4 | 实测可用 |
| `compactionEvents` | `'unverified'` | A1 未验证 | **不得改成 available** |
| `sessionEnumeration` | `false` | N7：SDK 无枚举 | 自建会话台账 |
| `crashRecovery` | `'structured-error-only'` | N15/N16 | 崩溃需重建会话 |

`EnginePort.listSessions()` 的语义是「产品自建台账」，不承诺来自引擎；`compaction.*` 事件的 `raw` 仅供 adapter/诊断，产品逻辑不得依赖。

## 3. 评审结论

- **通过为 W1-05/W1-06/W1-08 的输入**：状态机、回执、错误码、跨项目、空态、端口形状已覆盖 `backend/01` 的对应章节；
- **不通过为最终契约**：§4 未决项未闭合前，实现不得自行定论；类型草案不等于运行时校验器，实现必须独立校验（尤其权限、幂等、跨项目、候选范围）；
- 未发现与 ADR-0003/0006/0014/0015/0017 的直接冲突；ADR-0017 前提 6 的编号争议见 U-14。

## 4. 未决项

| ID | 未决项 | 影响 | 裁决/验证 |
|---|---|---|---|
| U-01 | A1：compaction 事件字段形态、稳定事件 ID、窗口外可观测性 | 证据卡注入与幂等键 `(taskId, eventId, revision)` | `testing/02`；A1 通过前保持 `unverified` |
| U-02 | N9：token 计量不可得 | 能力位 false；本版不定义 usage 字段，禁止估算 | 适配层自计量或延后 |
| U-03 | N8：手动压缩不可用 | 无按需压缩入口；替代触发未定 | 产品层设计 |
| U-04 | B5：SQLite WAL 并发/恢复、台账幂等未实测 | 本版不定义仓储端口与持久化约束 | 原型验证 |
| U-05 | N7：SDK 无会话枚举 | `listSessions` 依赖产品自建台账，数据来源待 M2 设计 | M2 |
| U-06 | N6：进程级 kill 不自动恢复 | 端口只承诺显式错误；重启/回收策略未设计 | M2 设计输入 |
| U-07 | `preview` 的 50 字符按 Unicode code point 还是 UTF-16 code unit 计数 | 回执自证口径；多字节/emoji 可能出现长度争议 | 评审裁定 |
| U-08 | `INTERNAL_ERROR` 是否可重试 | 前端错误条与重试策略 | 评审裁定（暂 true） |
| U-09 | 空态 `reason` 集合是否覆盖 UI 全部场景 | 前端状态矩阵逐格验收 | 前端确认 |
| U-10 | `delivered → review` 是否允许自动化触发 | 当前仅主管点名（`review/01` §4）；若自动化需改契约 | 主管/审查裁定 |
| U-11 | 信箱降级通道的触发条件与“唤醒会话”方式 | 派活/汇报在 HTTP 不可达时的行为 | M2 验证（S5b 未覆盖） |
| U-12 | supersedes 场景回执是否需回传旧任务状态 | 调用方如何确认旧任务已取消 | 评审裁定 |
| U-13 | `bodyBytes` 是否对 BOM/换行做规范化 | 端到端哈希比对 | 评审裁定（当前按“实收原样”） |
| U-14 | ADR-0017 前提 6 把 B5 写成“MCP 崩溃恢复已通过”，与 `pending-verification` 的 B5=SQLite 待实测冲突 | M1 是否可启动 SQLite 落库 | 主管裁决；本版不对 B5 作任何通过声明 |

## 5. 给实现方的硬约束

1. 类型草案不是校验器：权限、幂等、跨项目、候选范围必须在运行时独立校验；
2. 终态不可迁移；`delivered` 不得直达 `verified/rework/failed`；
3. 空集合必须给 `reason` + `hint`，不得渲染为错误；
4. 跨项目错误不得携带候选或任务存在性字段；
5. 能力位不得“补全”：`compactionEvents` 在 A1 通过前只能是 `unverified`；
6. 任何未映射错误 → `INTERNAL_ERROR` + `rawCode`，不得吞掉或改写为成功；
7. 端口层零 harness 类型；harness 专有 API 只允许出现在 `src/adapters/engine/harness/`。

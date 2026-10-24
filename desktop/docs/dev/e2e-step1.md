# 第一步验收：删模板 + 角色动态注入 + 主管硬约束 + 批量派活（2026-10-24）

环境：干净 `DSH_HOME`/`DEV_ROOT`（`D:/xxw_p/cadre-spike-env/s-loop7`），真实指针切换会话。
证据：同目录 `launch2.log`、`emp-role-verified.txt`、`01-employee-role.png`、
`sup-write2.txt`、`02-supervisor-write.png`、`sup-dispatch.txt`、`03-partial-dispatch.png`、
`dev-root/electron-user-data/cadre.sqlite.plugin.log`。

## 1. 删除旧模板

- `packages/bundle/cadre-app/cordis.patch.yml`：删除四个 `preset-cadre-*` 声明，patch 只剩 `cadre-collab` 一行。
- 前端 `CadreEmployee.tsx`：模板 id 改为角色 id（`dev/novel/general/roleplay`），**不再调用 `applyPreset`**（模板只记录到员工档案），删除 `cadre-` 前缀正则与模板字形表（徽标统一「员」）。
- `apps/desktop/src/employees-db.ts`：`TEMPLATE_ID_PATTERN` 去掉 `cadre-` 强制前缀。
- 删除失效测试：`packages/bundle/cadre-app/tests/cadre-presets.spec.ts`、`apps/web/tests/cadre-presets.e2e.ts`。
- 未做旧数据兼容（产品无用户）。

## 2. 角色动态注入（每轮生效）

`host-collab` 在 `agent/pre-step`（waterfall，任何路径都 `return next()`）为每个 Agent 注册一次
**作用域 prompt section**（`agent.ctx.systemPrompt.section`，order = `TEAM_POLICY`）。
section 的 text 是函数，**每次提示词组装都重新读台账**：

- 主管：注入固定职责（拆解/按花名册派活/验收汇总；有对应角色不得代劳；无角色才补位并说明；
  验收对照完成条件核实证据；汇报区分已证实/未决/风险）。
- 员工：`你是本项目的员工「<显示名>」。你的岗位职责：<花名册 persona_note / 模板>…`
  改花名册 → 下一轮立即生效。

实测：员工 `personaNote=负责数据清洗与周报，输出 CSV`，问「你的岗位职责是什么」，
回复含「数据清洗」（`emp-role-verified.txt`、`01-employee-role.png`）。

## 3. 主管硬约束

在 `agent/pre-step` 用官方 `agent.ctx.tools.restrict({ deny })`：主管 deny
`report_task, pwsh, write, edit`（win32 下 bash 未注册、`run_code` 属保留传输名，均已从名单剔除；
遇到未知名字时按 `restrict` 报错里的 known 集合交集重试）。

实测：主管会话要求「用 write 创建 supervisor-probe.txt」→ 工作目录**没有生成文件**
（`NO_FILE`），plugin.log 记录 `restrict agent=… role=supervisor deny=report_task,pwsh,write,edit`
（`sup-write2.txt`、`02-supervisor-write.png`）。

## 4. 批量派活（新接口）

`dispatch_task` 改为 `tasks: [{employee,title,body,dueAt}]`，**逐条**写台账 + 投递 + 确认，
返回 `{ dispatched:[{taskId,assigneeName,role,dueAt}], failed:[{target,reason}] }`：

- 部分成功可区分：一次派给「员工甲」+「不存在的员工」→ 1 条 `已派发`、1 条 `未派出`，
  后者 reason 前缀 `待派：`（找不到员工/已离职均归此列），不静默排队。
- 拆解失败可见：`tasks` 为空 → 抛「拆解失败：tasks 至少一条，请重新拆解后再派」；
  员工调用 → 抛「员工不能派活（caller=… role=worker）」，错误不再被吞。
- 单条投递被拒 → 该条回滚并计入 `failed`，其余条目继续（逐条确认）。

实测日志：`dispatch ok task=6903481c…`、`dispatch ok task=b036bf58…`、
`dispatch failed target=不存在的员工 …`（`launch2.log:47-50`、`sup-dispatch.txt`、`03-partial-dispatch.png`）。

## 未覆盖 / 后续

- 既有单测仍引用旧模板 id（`CadreEmployee.client.spec.tsx`、`employees-db.spec.ts` 等），需随第二步更新。
- 派活的「前端卡片/待派队列」UI 属第二步；本步只保证接口与台账语义。
- 主管的「自动拆解」触发仍靠 persona + 模型自觉，服务端兜底判定未做（见此前 Q1）。

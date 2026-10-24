# 端到端联调报告（进行中）

> 日期：2026-10-24　状态：**链路已通（第一轮），主管定向修复已提交，第二轮 UI 全链路未完成**
> 关联提交：c335410e（闭环工具打通）、44c24f45（主管定位）、fa01c617（根因记录）

## 1. 结论摘要

| 环节 | 状态 | 证据 |
|---|---|---|
| 真模型 → dispatch_task | ✅ 通过 | `s-loop2/launch.log:49 dispatch ok task=6e81c734…` |
| 员工会话收到任务 | ✅ 通过 | `s-loop2/emp.txt` 含【Cadre 任务】；UI「employee got task: true」 |
| 员工 → report_task | ✅ 通过 | `launch.log:50 report ok … supervisor=absent` |
| 台账 delivered → verified | ✅ 通过 | `transitionTask` 返回 `{ok:true,status:"verified",ledgerUpdated:true}` |
| 汇报卡前端展示 | ⏳ 未验证 | 本轮只验台账与消息投递，未截到 W3 汇报卡 |
| 主管会话收到回报（定向） | ⏳ 未验证 | 见 §3：已修复根因，待干净台账复测 |
| 干净台账 + 全 UI 建项目/主管/员工 | ⏳ 未完成 | 现有脚本复用历史会话，不能作为验收证据 |

## 2. 主管定位规则（已实现，44c24f45）

1. `employees-db.saveMember` 独占检查：`role='supervisor' AND state!='departed' AND session_id!='sup-1'`。
   ——`sup-1` 是台账种子占位行（无对应会话），此前永久占用主管名额，导致真实主管**建不出来**。
2. `host-collab.supervisor()`：`project_id=? AND role='supervisor' AND state!='departed' AND session_id!='sup-1'`
   `ORDER BY updated_at DESC LIMIT 1`，即「本项目唯一在册主管」。
3. `report_task`：命中主管 → prompt 主管会话并日志 `report ok … supervisor=<id>`；
   无主管 → 不阻塞，日志 `report supervisor=absent project=… task=… reporter=…`，并写 `<ledger>.plugin.log`。

## 2.5 第二轮复测结果（2026-10-24 18:30，s-loop5 干净环境）

- 干净 DSH_HOME/台账：是（`s-loop5`，空 userData、无历史会话）。
- 主管建成功：`supSave {"ok":true, role:"supervisor"}` —— sup-1 不再挤占名额（B1 修复生效）。
- 员工建成功：`empSave {"ok":true, role:"worker"}`。
- **卡在第 4 步「在主管会话里发起派活」**：CDP 点击会话行后无法确证当前活跃会话；
  实际执行上下文落在员工会话，工具被正确拒绝：
  `dispatch_task 调用失败：员工不能派活（caller=session-8318b402… role=worker）`。
  两次重试（含行点击重试与 active 探测）均未能切换到主管会话（active 探测无匹配元素）。
- 因此第二轮未拿到「派活成功/汇报卡/验收」证据；不是链路回归，而是**会话切换在无 UI 自动化钩子时不可判定**。
- 下一步：前端提供可测的会话激活标识（如 data-active-session 属性或路由 id 可读），
  或改用官方路由直接打开 `/session/<id>`；之后按 §4 清单一次跑完。

可能的 bug 观察（待确认，不先定性）：新建会话后点击会话行，UI 是否真的切换了当前会话；
若点击未生效，属前端 bug（B3 候选）。

## 3. 第二轮（待复测）失败原因说明

测试脚本复用旧 DSH_HOME 的历史会话列表：新脚本取的 `rows[0]` 实际是旧 worker 会话，
于是 dispatch 从员工会话发出，被正确拒绝：

```
dispatch_task 调用失败：员工不能派活（caller=session-e60199c3… role=worker）
```

这是**测试脚本取会话错误**，不是产品缺陷；同轮 `saveMember(supervisor)` 的 INVALID_ARGUMENT
则是旧主管仍占位（复测前需干净台账）。代码已改为错误信息带 caller，便于下次一眼定位。

## 4. 复测清单（干净环境）

1. `DSH_HOME`/`DSH_DESKTOP_DEV_ROOT` 全新目录，不拷贝历史会话。
2. UI 新建项目 → 新建主管会话并「保存成员(supervisor)」→ 新建员工会话并「保存成员(worker)」。
3. 主管会话发：`调用 dispatch_task 派给 <员工>，标题/要求/截止`。
4. 断言日志：`dispatch ok`；员工会话出现【Cadre 任务】。
5. 断言日志：`report ok … supervisor=<主管 sessionId>`（不是 absent）。
6. 主管会话 UI 出现【员工汇报】；截汇报卡图。
7. `window.cadre.listTasks` → delivered；`transitionTask(to:'verified')` → verified 并截图。

## 5. 问题清单（待第二轮补充）

### bug（已有证据或强嫌疑）
- B1：`sup-1` 种子占主管名额（已修，待复测确认）。
- B2：`report_task` 在无主管时静默跳过通知（已加 plugin.log，待确认 UI 侧是否应提示）。

### 设计问题（仅列出，不改设计）
- D1：台账仍由 Electron main 双写（本单未迁 Host），读写句柄并存；B1 迁移未做。
- D2：`dispatch_task` 目前全局注册，员工会话也能看到该工具（仅靠 role 拒绝），
  产品上是否应「只对主管会话暴露」需产品确认。
- D3：`report_task` 无「缺交付物」校验（W3 设计要求「不允许只写做完了」）。

## 6. 截图目录

`D:/xxw_p/cadre-spike-env/s-loop2/`（第一轮日志与文本；无前端汇报卡截图）
复测截图将补充到 `D:/xxw_p/cadre-spike-env/s-loop5/`。

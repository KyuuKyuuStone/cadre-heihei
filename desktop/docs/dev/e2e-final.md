# 最终端到端验收（2026-10-24）

> 环境：全新 `DSH_HOME`/`DEV_ROOT`（`D:/xxw_p/cadre-spike-env/s-loop6`），空台账、无历史会话。
> 模型：DeepSeek-V4.1-Flash（测试密钥）；会话切换用真实指针事件
> （`Input.dispatchMouseEvent` mousePressed/Released），不使用合成 click。
> 证据目录：同上，`launch.log`（Host/main 日志）、`emp.txt`、`sup.txt`、`d3.txt`、`result.json`、
> `02-supervisor.png`、`03-verified.png`、`04-d3-reject.png`。

## 结果一览

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新建主管 / 新建员工（干净台账） | ✅ | `supSave {"ok":true,role:"supervisor"}`、`empSave {"ok":true,role:"worker"}`；`sup-1` 不再挤占名额 |
| 2 | 主管派活（dispatch_task，含截止） | ✅ | `launch.log:46 dispatch ok task=9e08a7e7… due=2026-10-24T17:46:50Z` |
| 3 | 员工会话收到【Cadre 任务】并执行 | ✅ | `emp.txt` 含【Cadre 任务】；模型执行后调用回报 |
| 4 | 员工回报（D3：空交付物必须拒绝） | ✅ | 正常回报 `report ok`；反向用例 `d3.txt` 出现「汇报必须附交付物」 |
| 5 | **主管会话收到【员工汇报】**（supervisor 定位） | ✅ | `launch.log:47 report ok … supervisor=session-5fce8dcb…`（真实主管 id，非 absent）；`sup.txt` 含【员工汇报】 |
| 6 | 前端汇报卡显示该任务 | ⚠️ 部分 | `02-supervisor.png`：汇报消息在主管会话中可见；是否为 W3 卡片形态未逐项核对（交前端比对） |
| 7 | 用户验收 → verified | ✅ | `transitionTask` 返回 `verified`；台账 `status:"verified"`；`03-verified.png` |
| 8 | D2 反向可见性 | ✅ | `cadre.sqlite.plugin.log` 出现 `restrict agent=… role=…` 两条（worker 禁 dispatch_task/list_employees、supervisor 禁 report_task） |

## 未覆盖

- 「新建项目并绑定文件夹」：本轮沿用默认工作区直接建主管/员工，未走项目创建 UI；不影响台账与工具链路，
  但该步骤需单独按 W8 验一次。
- 汇报卡（W3）视觉细节（折叠摘要行、未读点、状态标）未逐项比对截图。
- 截图覆盖：02/03/04 三张；派活与员工任务页有文本证据，未逐页截图。

## 结论

**整条链路已通，可以打包含新功能给用户。** 建议安装包复验时补 W8「项目 + 文件夹」与汇报卡视觉两项。

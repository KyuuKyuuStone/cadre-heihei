# cadre-heihei

**cadre-heihei 是「主管/员工」AI 协作工作台的新项目。** 基于开源 MIT 内核 [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（评估结论：能当地基，推荐 fork）构建——主管编排拆解派活，员工无人值守执行并自动汇报。

**命名**：`cadre`＝骨干/干部，对应「主管—员工」的组织结构；`-heihei` 是家族后缀，延续前身项目。

**前身**：[cc-heihei](https://github.com/KyuuKyuuStone/claude-code-heihei)——已**冻结于 v1.7.9**（最后一个版本），代码按 MIT 开源。v1.7.9 Release 仍可下载使用。

**当前状态**：**已 GO（ADR-0017），进入实施准备；B1/B5 前提已满足（开发态/原型范围），打包态待验；S3 与 S5a 按 ADR-0015/0016 执行降级方案。** 2026-10-21 用户已裁定 12 条启动决策；其余 GO 前提未满足前不得进入对应阶段。

## 文档入口（本 README 是唯一入口）

| 位置 | 性质 | 用途 |
|---|---|---|
| [`docs/decisions/`](docs/decisions/README.md) | **现行决策**（可演进） | 12 条启动决策的 ADR、被否决项与理由、勘误区 |
| [`docs/product/`](docs/product/README.md) | **现行产品文档**（可演进） | 方向总纲、产品模型、交互设计、设计规范、审查与测试规范 |
| [`docs/pending-verification.md`](docs/pending-verification.md) | 现行清单 | 待核查项，分「阻塞 / 不阻塞」；含 `6aa34b7a` 的关闭结论 |
| [`docs/archive/2026-10-23-旧文档/`](docs/archive/2026-10-23-旧文档/README.md) | **历史 · 已封存** | 交接包快照（`01`~`06` + `blessings`）、旧 spike、旧设计与评审记录（2026-10-23 只移动不删除） |

规则：

1. **历史查 `docs/archive/2026-10-23-旧文档/`，现行决定查 `docs/decisions/`，产品设计查 `docs/product/`。** 与 ADR 冲突时以 ADR 为准（勘误区见归档内的 `handover/README.md`）。
2. 交接包原文**不得修改**；新结论写入 ADR 或产品文档。
3. **架构判断在通过 spike 前一律标「假设，待 spike 验证」**，不得写成定论。

## 现行硬约束（摘要，详见 ADR）

- 完全开源可改；**零改内核优先**（ADR-0002）
- 引擎可替换，接缝方向 MCP（ADR-0003，假设待验证）
- token 效率从架构层考虑（`docs/archive/2026-10-23-旧文档/handover/05-新项目的起点约束.md`）
- 自动化不加人工审批点；首版三屏、不做审批 UI（ADR-0007）
- 视觉沿用骨架，WCAG AA / 警示 AAA，六主题从前身回填（ADR-0008）
- UI 摘要化：截断标注 + 展开入口，用量只落日志（ADR-0009）
- spike 阻断即停（ADR-0001）；Node ≥ 22.19 基线（ADR-0004，Electron 是否满足待实测）
- spike 在独立工作区 `D:\xxw_p\cadre-spike-env` 执行，不做 VM/账户隔离（ADR-0013）
- 每会话独立 `DeepSeekHarness` 实例，MCP 仍为工具接缝（ADR-0014，变更原单进程多会话）
- 汇报漏 taskId 显式报错列候选（ADR-0006）
- 门禁 DoD 含空仓重算 baseline + 坏样本（ADR-0011）
- 交接包冻结只读 + 唯一入口 + 轻量 ADR（ADR-0012）

## 事实基线

- 前身冻结版本：**v1.7.9**（tag `v1.7.9` @ `8ab1c24`，Release 三资产齐）
- 新底座：`deepseek-harness`（MIT，无 CLA/DCO；评估克隆钉 `687f282e` = dsh-v0.2.1-rc.2，位于 `D:\xxw_p\cc-heihei-verify\harness-eval\deepseek-harness`）
- 一线反馈素材：前身仓库 `IDE反馈/` 目录 7 份（7 个真实项目、30+ 岗位会话的实测反馈）
- 前身最后一笔修复（commit `5eba92a`）已在 v1.7.9 发布

## 建议阅读顺序

`docs/product/DIRECTION.md` → `docs/decisions/README.md` → `docs/product/README.md` → `docs/pending-verification.md` → `docs/archive/2026-10-23-旧文档/handover/02-理念与铁律.md` → `docs/archive/2026-10-23-旧文档/handover/05-新项目的起点约束.md`。

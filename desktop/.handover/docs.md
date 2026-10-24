# 交接 · 技术文档岗（2026-10-23）

## 状态

**当前无进行中的单**。最近交付：`255105b0`（ADR 附注 + product-model 重写），已提交 `713880a5`；工作区无我的未提交改动。
**不阻塞压缩**，随时可停。

## 已完成到哪一步

1. **DIRECTION 主文档**：§5 11 条已拍板、§6 运行规则（主管只读/员工单任务/用户/项目两层/暂不做）、§7 发布纪律（推送须授权，远端 `KyuuKyuuStone/cadre-heihei`，当前无 remote）；附录 B 现有未决 #1–#23。
2. **INTERACTION**：只做同步标注（§7.1 的 DIRECTION 行已标「已同步」）；第四批（两层、离职、自定义角色）由设计侧改，我未改其设计正文。
3. **ADR**：ADR-0021 加「层级口径更新」附注（正文保留），ADR-0022/0005 加简注，README 摘要更新，ADR-0020 记历史引用（附录 B #23）。
4. **product-model.md**：按两层重写（工作区容器→项目文件夹→员工属于项目；无跨项目/无全局在册；删除=离职）。
5. **ROADMAP-LATER.md**：8 条未来优化（本期不做），DIRECTION §6.5 已指向。

## 已改文件（我的提交）

`docs/product/DIRECTION.md`、`docs/product/INTERACTION.md`、`docs/product/product-model.md`、`docs/product/ROADMAP-LATER.md`、`docs/decisions/{ADR-0021,ADR-0022,ADR-0005,README}.md`、`CLAUDE.md`（顶部硬规则块 + §0 第 6 条）。
最新提交：`713880a5`、`34ccc6f5`、`e0e636bf`、`c40ab13`、`2b43007`、`bff3b826`。

## 下一步（接手就做）

1. **附录 B 剩余未决**（DIRECTION）：#18 远端授权流程、#19 发布四件套载体、#20 容器层语义、#21 `project_id`↔workspace 映射、#22 自定义角色库作用域、#12 两级验收状态机、#13 主管只读工具集落地、#14 排队/重派计数。
2. **待同步文档**：`docs/dev/dsh-architecture-map.md` 中「工作区=项目」措辞（若还有）；`docs/product/README.md` 索引补 DIRECTION 之外新文件时检查。
3. **不要做**：不要改 ADR 正文（只加附注）；不要 commit 他人未提交改动（如 `docs/product/design/03-brand-compliance.md` 未跟踪）。

## 踩过的坑

- **共享工作树并发写**：同一文件被设计侧同时改，`Edit` 会报「File has been modified」——重新 Read 再改，不要重试原命令；提交前先 `git status` 确认改动集只含本任务文件。
- **`git add -A` 会夹带**：目录里有他人未跟踪文件（`03-brand-compliance.md`、`__pycache__/`），只按文件名 add。
- **文档链接检查**：用 python 扫 `](path)`，排除 `http`/`#`，相对路径按文件目录解析；每次改完跑一遍。
- **门禁**：commit 钩子会跑 file-size + app/src 导入检查，正常即可通过；不改 `app/` 时无需理会。

## 依赖谁

- **设计侧**：INTERACTION 的 W1/W7/W8/W9 与线框由其维护；我改其文件前先确认（§5/§7.1 我有编辑权限）。
- **后端**：附录 B #12–#14、#20–#22 的落地口径；`project_id` 映射由后端定。
- **用户**：附录 B 中标注「用户」的项需拍板；推送必须经用户授权（§7）。

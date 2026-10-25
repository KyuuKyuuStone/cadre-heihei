# UPSTREAM：官方基线、差异登记与选择性融合

> **定位说明（2026-10-25，用户决定）**：**Cadre Heihei 是独立发行版**，不以跟随官方为目标。本登记**仅为本团队未来与上游同步时查账**，不是对上游的贡献清单，也不要求逐条对外解释。
> **登记降级为极简清单**：一行一条——**文件 + 一句原因**；能合并就合并、能省就省。下方既有条目**保持不变**（历史记录），新增条目按极简要求写。

> 本文件是 **fork 差异的唯一登记处**。升级不再以「跟上官方」为目标，而是按 ADR-0023 的**选择性融合**逐处决策：每一行都必须能回答「我们为什么偏离官方」，升级时按 ADR-0023 §3.5 的判据（A 修过我们的坑 / B 净减代码 / C 可测性能 / D 安全变严 / E 产品冲突 / F 破坏成本）判断该合还是该留。

## 基线

- **upstream pin**：`687f282e`（`vendor/deepseek-harness`，dsh `0.2.1-rc.2` 发布提交）
- **当前产品版本**：0.5.1（`desktop/package.json`）
- **复制方式**：`desktop/` 是 pin 的整仓副本（`apps/`、`packages/`、`vendor/`、`scripts/`、根配置），构建产物除外。
- **官方更新来源**：`vendor/deepseek-harness`（git submodule，只读）。
- **冻结点补记**：`cadre-experimental-0.5.0` 打 tag 时整树源码大部分未跟踪，**冻结范围有漏洞**；
  已由两笔抢救 commit（源码层 3.3k+ 与资源类 213 项）补全，并以 `cadre-experimental-0.5.0-src`
  作为**真正的源码层冻结点**（残余仅工作环境类，git 保管范围外）。
- **待办（基线）**：本基线数字来自 0.2.1-rc.2 快照（非官方最新——本机代理不可达未能拉取）；
  网络恢复后重跑一次真最新基线（`package:desktop:win:x64:unsigned`，快照与实测见
  `D:\xxw_p\cadre-release\upstream-baseline\README.txt`）。
- **开发态已知问题（2026-10-26 核实）**：dev 实例运行中执行 `pnpm run build:artifacts`，官方 HMR 会热替换含 `ui-session` 在内的插件；替换间隙根节点抛
  `scope 'session-maybe' rendered without an installed adapter` 并白屏（官方 `ui-renderer` 失败不回滚，见 `packages/client/hmr/README.md` 失败策略）。
  `bindings.tsx` / `scoped-slots.tsx` / `ui-session/index.ts` 与 pin **逐字节一致**，非本 fork 引入；正常启动 + 稳定产物页面刷新不触发，安装包运行期无 bundle 重建写入。

## 登记约定

每条差异四个字段：

| 字段 | 取值 |
|---|---|
| 类别 | 内核补丁 / 插件新增 / 配置 / 构建脚本 / 资源品牌 / 测试基线 / 文档 |
| 改动摘要 | 一句话说清「和官方不一样在哪」 |
| 保留理由 | `官方没有` / `官方有但冲突` / `我方产品需要`（三选一，可加短注） |
| 融合提示 | 升级时按 ADR-0023 §3.5 判：`A/B/C/D` 有证据才合；`E` 冲突则保留；无证据默认保留 |

**版本号差异不登记**：0.2.1-rc.2 → 0.5.1 会改动 344 个 `package.json` 的 `version` 字段，自动检查会把「仅版本号不同」的清单单独列出，不要求逐条登记。

## 自动发现（防漏登）

```bash
# 全量报告（只读，不写任何文件）
node desktop/scripts/check-upstream-drift.mjs

# 机器可读
node desktop/scripts/check-upstream-drift.mjs --json

# 作为门禁：有未登记改动则退出码 1
node desktop/scripts/check-upstream-drift.mjs --fail-on-drift
```

脚本行为：以 pin 的 `git ls-tree HEAD` 为基准，逐字节比对 `desktop/` 同名文件（忽略 CRLF），再扫描 `desktop/` 找新增文件；产出 modified / version-only / deleted / added / **build residue** / **UNREGISTERED** 六组。`UNREGISTERED` = 本文件中没有出现的路径。构建残留（`lib/`、`dist/`、`*.map`、源码旁的编译产物 `x.js`/`x.d.ts`、`vendor/src/` 等）自动归类，不算产品改动。

**建议**：接入打包预检（`apps/desktop/scripts/preflight-package.mjs`）时加 `--fail-on-drift`，或在 CI 单独跑一个只读 job；本单不接线。

## 计数概览（2026-10-23 实测）

| 分组 | 数量 |
|---|---|
| 真实修改（非版本号） | 71 |
| 新增文件（不含本文件自身） | 41 |
| 构建残留（待清理） | 38 |
| 仅版本号变化的 package.json | 344 |
| 删除的上游文件 | 0 |

---

## 一、内核补丁（真正改官方行为的）

> 判定标准：改了官方**运行时行为**（进程、插件树、UI 注册、构建产物），不是单纯文案或资源。

| # | 路径 | 改动摘要 | 为什么不能只用插件解决 | 最小侵入面 |
|---|---|---|---|---|
| K1 | `apps/desktop/src/main.ts` | 新增 Cadre 台账/花名册/员工（含 `cadre:saveMember` / `cadre:retireMember`）/provider 的 IPC handler、托盘明暗图标、provider 凭据同步；`createRequire` 加载 `cadre-collab.cjs`；**关窗直接隐藏到托盘，不再弹「任务不会中断」提示**（2026-10-24，用户要求无条件去掉，`background-notice.ts` 与文案一并删除） | SQLite、`safeStorage`、`nativeTheme`、`ipcMain` 都是 Electron 主进程 API，Cordis 客户端插件拿不到 | 后续按 ADR-0023 §2.4 把员工/账本迁到 Host 服务后，本文件 hunk 应大幅收缩 |
| K2 | `apps/desktop/src/ipc.ts` | 新增 `cadre:*` 通道常量（任务、花名册、provider、session 绑定、员工） | 通道名必须与 preload/main 一致；无官方等价 | 随 K1 一起收缩；`window.cadre` 目标归零 |
| K3 | `apps/desktop/src/preload-app.ts` | 暴露 `window.cadre` 桥（任务/花名册/provider/员工） | contextBridge 只能写在 preload | 迁移完成后只保留不可替代通道 |
| K4 | `apps/desktop/src/project-manager.ts` | 桌面 profile 的 bundles 列表追加 `@deepseek-ai/dsh-bundle-cadre`；`applyRelease` 补齐**既有 profile** 缺失的 Desktop bundles（旧 profile 的 `package.json` 不会被 `initProfile` 重写，缺 bundle 会让所有 `cadre-*` preset 报 `agent-preset/not-found`）；并从旧 manifest 删除已下线的 `agent-team-profile` bundle 及其依赖 | profile 由桌面端生成，官方模板不含我们 bundle | 一个常量 `DESKTOP_BUNDLES` + 一个 `RETIRED_BUNDLES` |
| K5 | `apps/desktop/src/tray.ts` | 托盘图标支持按系统明暗切换（`resolveIconPath` + `setDark`） | 托盘生命周期在 Electron 主进程 | 一个类内新增方法；可保持在桌面壳 |
| K6 | `apps/desktop/src/locale.ts` | 产品名 `DeepSeek Harness` → `Cadre Heihei`（菜单/托盘/欢迎页） | 应用菜单与托盘文案由主进程提供 | 纯字符串替换，6 处 |
| K7 | `packages/bundle/base/cordis.patch.yml` | 禁用 `llm-deepseek-account`（无账户产品） | **这是官方扩展点**（patch `disabled`），不是代码 patch | 1 行 + 注释 |
| K8 | `packages/bundle/web-app/cordis.patch.yml` | 禁用 `ui-settings-account`（隐藏账户设置入口） | 同 K7，官方 patch 机制 | 1 行 + 注释；`account-controller` 仍由官方默认禁用 |
| K9 | `packages/client/ui-theme/src/theme-settings.ts` | 默认主题 `system` → `dark` | 官方没有「部署默认主题」配置面 | 1 行常量（**建议改为品牌/部署注入，见 §六**） |
| K10 | `packages/client/ui-sidebar/src/client/index.ts` | 注册侧栏壳、项目行「＋」三选一/「台账」、会话角色标识（主管方标/员工圆标 + 岗位徽章 + 状态/当前任务副标题）与行列菜单、建人/台账 overlay、主题 token 覆盖。0.7.0 后**删除 CadrePanel 面板**（花名册/台账整页、`main:cadre` 路由、`sidebar.panellist:cadre` 入口全部移除）；建人改为 `shell.overlay` 弹窗，台账改为只读 overlay。EnginePort 客户端绑定经 `@deepseek-ai/dsh-cadre-engine/client`（内联进本包 bundle，见 K18） | 注册本身是官方 slot 扩展点；但**代码写进了官方包** | 应抽成独立客户端插件包（`slots.inject` 外部可用），本文件 hunk 可清零 |
| K11 | `packages/client/ui-sidebar/src/client/SidebarRoot.module.css` | 侧栏玻璃层背景改为 `color-mix` 取主题 token | 官方没有对应视觉变体 | 4 条声明；可移入我们的主题样式 |
| K12 | `packages/client/ui-brand-official/src/client/index.ts`、`packages/client/ui-brand-official/src/client/Brand.tsx` | 品牌占位改为 Cadre 印章（含 hero 槽位） | 官方明确要求另做品牌包，不应改包内 | **ADR-0023 §2.6 决定迁到独立品牌包，本项待删** |
| K13 | `packages/client/web/src/boot-page.ts` | 启动页字标改为 `Cadre Heihei` | 启动页在客户端 bundle 内、早于插件加载 | 1 行；品牌包无法覆盖启动页 |
| K14 | `scripts/client-build-environment.ts` | `DSH_CLIENT_TITLE` 改为 `Cadre Heihei` | 构建期常量，插件读不到 | 1 行 |
| K15 | `apps/desktop/scripts/electron-builder-config.mjs` | productName/artifactName/protocol 改名；files 白名单加 `lib/cadre-collab.cjs`；安装图标换 Cadre；Windows 多尺寸 ICO | 打包配置只能改这里 | 名称与资源映射；`cadre-collab.cjs` 随迁移可删 |
| K16 | `apps/desktop/scripts/installer.nsh` | `customInstall` 清理旧程序文件（不碰用户数据） | NSIS 钩子只能改官方脚本 | 一个 macro；改名重装期间必需 |
| K17 | `apps/desktop/scripts/smoke-packaged-runtime.ts` | 冒烟测试按新 productName 找 `Cadre Heihei.exe/.app` | 官方脚本硬编码产品名 | 2 行 |
| K18 | `packages/client/tsdown.client.ts` | `INLINE_SAFE` 增加 `cadre-engine`，允许侧栏 bundle 内联 `@deepseek-ai/dsh-cadre-engine/client` | 该包是浏览器安全的无状态适配层（与 `session`/`brand`/`llm` 同桶）；官方 module table 的 row 键只到包名，子路径无法成为 row，做成 client 插件又会为纯库引入无谓的插件身份 | 正则里一个交替项；若官方给库级内联白名单配置面则改用它 |
| K19 | `packages/client/ui-conversation/src/client/locales.ts` | 派活/汇报状态条所需文案与术语 | 官方文案层没有产品术语位 | 若干词条；可迁移为独立插件的 locale 覆盖 |
| K20 | `packages/client/ui-tool/src/client/apply.ts` | 注册 `dispatch-row` 工具卡视图（读 tool result 的 presentationMeta） | 官方工具卡注册表在客户端包内，插件只能注册到既有视图集合 | 一条注册；可抽成客户端插件 |
| K21 | `packages/client/ui-tool/src/client/tool/toolviews/dispatch-row.tsx` | 派活结果卡：成功/失败分列、`retryable` 决定重试按钮、用 `pendingId` 触发重试 | 跨会话任务卡官方无对应视图 | 新文件；数据全部来自 meta，可平移到独立包 |
| K22 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | 项目/花名册侧栏接线与状态条挂载；新建会话按钮改为三选一 Menu，`.newSessionMenu` 让包裹层拉伸（修复按钮宽度塌陷到 26px） | 官方侧栏组合点内部 | 接线 hunk；应随 K10 一起抽插件 |
| K23 | `packages/client/ui-sidebar/src/client/contract/slots.ts` | ~~新增项目行/会话标识 slot 类型（与 ui-workspace 契约镜像，避免包循环）~~ **2026-10-25 撤销**：镜像声明已移除，槽声明归位 ui-workspace（owner）；ui-sidebar 注册处改为局部类型化 + 注释说明包循环，见 K28 | 类型契约在官方包内声明 | 类型声明；抽插件时并入我们自己的 contract |
| K24 | `packages/client/ui-workspace/src/client/contract/slots.ts`、`rows/Rows.tsx`、`rows/WorkspaceBrowser.tsx` | 新增 `sidebar.workspaces.project.row.action`（项目行＋/台账）、`sidebar.workspaces.project.row.create`（项目头下通用创建座位，当前不注册条目）、`sidebar.session.row.badge`（角色胶囊）与 `sidebar.session.row.subtitle`（第二行：岗位 + 运行中/空闲 + 当前任务）；项目行显示文件夹路径；会话行改为两行 56px；项目行动作条常显（避免悬停菜单时触发器被隐藏）；已占用项目行 action 时隐藏原单按钮；按产品 rank 排序；空白会话行标题附创建时间（`新会话 · HH:mm`，空白行无 prompt，Host 的 `updatedAt` 即 `createdAt`） | 官方项目行/会话行没有这些扩展点；产品要求入口和身份/状态都在侧栏行上；空行与顶部「新会话」按钮撞名 | 四个 list slot + 一行排序 + 行高 + 标题时间后缀；官方若提供行 action/subtitle seat 可回退 |
| K25 | `packages/client/ui-sidebar/src/client/cadre-session-rank.ts`（cordis 服务 `cadreSessionRank`）；`packages/client/ui-workspace/src/client/index.ts` 消费 | 产品级会话置顶 rank：主管恒置顶，其余按原派生顺序；跨包共享走 cordis 服务，避免跨插件值导入 | 官方排序无「角色」概念；bundle purity 禁止跨插件值导入 | 一个服务 + 一个稳定空 Map；抽插件后可移到独立包 |
| K26 | `packages/client/ui-chat/src/client/chat/MessageItem.tsx`、`chat/CadreReportCard.tsx` | 主管会话里的员工汇报卡：解析 Host 汇报文本，默认折叠为一行（标签 + 任务号 + 一句话摘要），展开后显示全文、交付物、状态与「通过/打回」，打回必填原因；展开状态按汇报内容记入 localStorage | 官方 user 消息渲染不认识 cadre 汇报协议；验收必须回到会话；多条汇报不应刷屏 | 一个文本前缀分支 + 一张卡；协议若改为结构化消息可移除文本解析 |
| K27 | `packages/client/*/src/client/locales*.ts`（ui-workspace、ui-conversation、ui-reference、ui-settings 等） | 用户可见「工作区」统一改为「项目部」（侧栏分组、菜单、空态、提示、权限文案） | 产品术语统一（DC-001 一层项目部） | 纯文案替换；抽插件后用 locale 覆盖更佳 |
| K28 | `packages/client/ui-sidebar/src/client/contract/slots.ts` | 删除四个槽的镜像声明（两个官方槽 + 两个新增槽），槽声明统一归 ui-workspace；`hooks.projectState` 取代全局 `cadreSupervisor`，按 workspace id 判定主管；注册处局部类型化以避开包循环 | 镜像会被 slot 目录门禁判重复，且 owner 契约只能有一处 | 抽独立插件后本文件可清零 |
| K29 | `packages/client/ui-tool/src/client/contract/slots.ts` | `tool.call.toolview` JSDoc 收紧一行（3 行合并为 2 行），回到 122 行报告预算内 | 我方 slot 目录门禁预算；官方新增 DispatchStatusRow 后为 123 行 | A（可合入上游） |
| K30 | `scripts/slot-walk.ts` | `dedent()` 先归一化 CRLF 再切行，避免 Windows 检出（core.autocrlf）生成含裸 CR 的 catalog | 修过我们的坑（A）：Windows 上生成物非法、`--check` 永远红 | A（可合入上游） |
| K31 | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | 重新生成：补 `sidebar.workspaces.project.row.action` / `sidebar.workspaces.project.row.create` / `sidebar.session.row.badge`，并纳入 toolview 既有漂移 | 生成物，跟随声明变化 | 重跑 `pnpm run gen-client-catalog` |

**内核补丁结论：17 处，其中 3 处（K7/K8/K10）本可完全走官方扩展点、1 处（K12）已决定迁走、1 处（K9）应换实现方式。真正无法避免的只剩桌面壳 6 处（K1–K6）+ 构建 4 处（K14–K17）。**

---

## 二、插件新增（官方没有、我们用官方机制加的能力）

| 路径 | 改动摘要 | 保留理由 | 融合提示 |
|---|---|---|---|
| `packages/bundle/cadre-app/` | 员工模板 bundle：四个 preset（dev/novel/general/roleplay），`cordis.patch.yml` + no-op 入口 | 官方没有这些模板 | 机制稳定，升级基本不动；preset 字段若变走 §3.5 F |
| `packages/client/ui-sidebar/src/client/CadrePanel.tsx` | **已删除**（0.7.0 侧栏重设计）：花名册/台账面板页、项目面板入口、`main:cadre` 路由全部移除；能力迁到 CadreCreateDialog / CadreLedgerOverlay / CadreSidebar | 用户明确否掉管理面板，侧栏会话列表即主界面 | 无需保留 |
| `packages/client/ui-sidebar/src/client/CadreCreateDialog.tsx`、`CadreLedgerOverlay.tsx`、`CadreSidebar.tsx` | 建人弹窗（680px 宽）、只读台账 overlay（六列 + 时间线）、项目行＋/台账、会话行角色标识 + 状态副标题、悬停菜单宽限与行菜单 | 侧栏即主界面；官方无项目/角色概念 | 官方 slot 扩展；可抽独立插件 |
| `packages/client/ui-sidebar/src/client/CadreSidebar.module.css`、`CadreCreateDialog.module.css`、`CadreLedgerOverlay.module.css` | 上述组件的样式（只用主题 token） | 产品 UI | 随组件迁移 |
| `packages/client/ui-sidebar/tests/cadre-custom-roles.client.spec.ts` | 自定义角色存储测试 | 产品 UI | 随组件迁移 |
| `packages/client/ui-sidebar/src/client/CadreRoster.tsx`、`CadreRoster.module.css` | **已删除**（面板移除）；角色标识改到会话行（CadreSidebar） | 官方无角色概念；设计 c07dd22 已改到行上 | 无需保留 |
| `packages/client/ui-sidebar/src/client/cadre-roster-source.ts` | 花名册数据薄适配（IPC → 视图模型；未来切 Host Remote 只改此文件）；自定义角色暂存 localStorage（待入台账） | 官方无跨会话花名册 | 随 ADR-0023 §2.4 迁移；自定义角色存储随后端表迁移 |
| `packages/client/ui-sidebar/src/client/CadreEmployee.tsx` | **已删除**（0.7.0）：员工编辑/离职改由 CadreSidebar 的会话行菜单（编辑资料/离职）承担 | 官方无「员工」概念 | 无需保留 |
| `packages/client/ui-sidebar/src/client/EmployeeSection.tsx` | **已删除**（未注册且无引用） | 官方有 `settings.section`，无员工页 | 无需保留 |
| `packages/client/ui-sidebar/src/client/ProviderSection.tsx` | 「模型 Providers」设置分区 | **官方有同类（Models 页），属重复** | ADR-0023 §2.5：迁移后删除 |
| `packages/client/ui-sidebar/src/client/cadre-skin.tokens.ts` | 昼流/夜流主题 token 覆盖 | 官方 `ctx.theme` 扩展点允许 | 保留；与官方 token 变更走 C/E 判断 |
| `packages/client/ui-sidebar/src/client/CadreEmployee.module.css` | 员工对话框样式 | 产品 UI | 保留 |
| `packages/client/ui-sidebar/tests/CadreEmployee.client.spec.tsx` | **已删除**（随 CadreEmployee 移除） | 产品 UI | 无需保留 |
| `apps/desktop/src/cadre-ledger.ts` | 台账 SQLite 读取（userData/cadre.sqlite）；0.7.0 增 `due_at`、`task_events` 时间线与 member 岗位描述 | 官方无跨会话账本 | ADR-0023 §2.4：迁 Host 服务后本文件移动 |
| `apps/desktop/src/cadre-collab-api.ts` | 台账写路径的类型契约 | 同上 | 同上 |
| `apps/desktop/src/employees-db.ts` | 员工偏好表（模板/模型/备注）+ 台账 `members` 角色写入与离职（`saveMember` / `retireMember`，含每项目唯一在职主管校验） | 官方无员工偏好存储 | 同上；表保留，宿主迁移 |
| `apps/desktop/src/providers-db.ts` | provider / session_providers 表 | **与官方三处真值重复** | ADR-0023 §2.5：先迁移后删除 |
| `apps/desktop/src/provider-credentials.ts` | provider 密钥读写与掩码 | 官方 `credentials` 已有等价 | 随 providers 一起删除 |
| `apps/desktop/src/provider-runtime.ts` | 把 Cadre provider 同步进官方 `llm-pi-ai` settings/credentials | 官方 Models 页可直接写 | 随 providers 一起删除 |
| `apps/desktop/src/tray-icon.ts` | 按明暗解析托盘 ICO 路径 | 官方无明暗双图标 | 保留（桌面壳） |
| `apps/desktop/tests/employees-db.spec.ts` | 员工表测试 | 产品 | 保留 |
| `apps/web/tests/cadre-presets.e2e.ts` | 装配态验证 cadre-* preset（roster/read/select） | 产品 | 保留 |
| `apps/web/tests/plugin-manager.e2e.ts`、`apps/web/tests/expected/plugin-manager/*.md` | skip 4 个断言官方 Agent Teams 卡存在的用例；3 份渲染快照删除该卡，刷新计数快照 11→10 | 产品不交付官方实验团队（见本文件 agent-team 配置行）；断言其存在已是错误基线 | 测试基线；**官方升级时需重放**；恢复交付则还原 skip 与快照 |
| `cadre-collab/entry.ts` | 协作写路径实现（编译为 `lib/cadre-collab.cjs`） | 官方无账本 | 迁 Host 服务后移动 |
| `scripts/build-cadre-collab.mjs` | 把 `cadre-collab/entry.ts` 打成 CJS 供 main require | 桌面壳加载方式 | 随迁移删除 |
| `scripts/check-upstream-drift.mjs` | 本文件的自动发现脚本 | 过程工具 | 保留 |
| `packages/client/ui-brand-official/src/client/Brand.module.css` | Cadre 印章样式 | 品牌 | 随 K12 迁到独立品牌包 |
| `packages/client/ui-brand-official/src/client/seal-light.svg` | 浅色印章图 | 品牌 | 随 K12 迁走 |
| `packages/client/ui-brand-official/src/client/seal-dark.svg` | 深色印章图 | 品牌 | 随 K12 迁走 |
| `packages/client/ui-brand-official/src/client/assets.d.ts` | SVG 模块类型声明 | 构建 | 随 K12 迁走 |
| `packages/client/ui-brand-official/src/css-modules.d.ts` | CSS Modules 类型声明 | 构建 | 随 K12 迁走 |
| `apps/desktop/scripts/check-no-secrets.mjs` | 打包密钥泄漏门禁（afterPack 扫描） | 官方无 | 保留（安全，D 判据） |
| `apps/desktop/scripts/preflight-package.mjs` | 打包前预检（可接漂移检查） | 官方无 | 保留 |
| `apps/desktop/scripts/release.mjs` | 一键发布（bump→构建→校验→发布） | 官方无 | 保留 |
| `apps/desktop/CHANGELOG.md` | 产品变更日志 | 产品 | 保留 |
| `docs/dev/packaging-playbook.md` | 打包操作手册 | 过程文档 | 保留 |
| `apps/desktop/.env.windows` | 本地打包测试环境变量（占位域名，无真实密钥） | 构建环境 | 保留但**建议移出版本控制或确认为公开样例** |

---

## 三、配置

| 路径 | 改动摘要 | 保留理由 | 融合提示 |
|---|---|---|---|
| `apps/desktop/package.json` | 新增 `release:win` 脚本；依赖加 `@deepseek-ai/dsh-bundle-cadre` | 构建接线 | 官方新增脚本时按 B/F 判断 |
| `apps/desktop-host/package.json` | 依赖加 `@deepseek-ai/dsh-bundle-cadre`（进核心包集闭包） | 官方闭包根只有 dsh/host，必须挂 | 官方若支持「随包 bundle 清单」可融合（B） |
| `apps/cli/package.json` | 把 `@deepseek-ai/dsh-experimental-agent-team-profile` 从 `dependencies` 移到 `devDependencies`（另两个 agent-team 包上游已在 devDependencies） | 产品不交付官方实验团队「Agent Teams」；源码与官方测试保留 | **官方升级时需重放**；闭包断言见 `apps/desktop/scripts/prepare-package-set.ts`；评估见 `docs/dev/agent-team-removal-plan.md` |
| `packages/client/ui-sidebar/package.json` | 新增 api-remotes / session-controller / connection / ui-theme 依赖；files 加 `lib/types/**/*.js` | 员工对话框与主题注入需要 | 抽独立插件包后可回滚部分 |
| `packages/client/ui-sidebar/tsconfig.json` | 增加对应 project references | 构建 | 随包拆分收缩 |
| `packages/client/ui-brand-official/package.json` | 增加 ui-conversation 依赖（hero 品牌槽） | 品牌 | 随 K12 迁走 |
| `packages/client/ui-brand-official/tsconfig.json` | 增加 ui-conversation reference | 构建 | 随 K12 迁走 |
| `tsconfig.host.json` | references 增加 `packages/bundle/cadre-app` | 构建 | 保留 |
| `apps/web/tsconfig.json` | exclude 增加 `tests/cadre-presets.e2e.ts`（引用 scaffold，避免 TS6307） | 测试边界 | 官方改 exclude 列表时按 B 判断 |
| `pnpm-lock.yaml` | 依赖图变化（新 workspace 包与依赖） | 构建 | 每次版本升级重生成 |
| `apps/desktop/README.md` | 增加密钥门禁说明 | 文档 | 保留 |

---

## 四、构建脚本

| 路径 | 改动摘要 | 保留理由 | 融合提示 |
|---|---|---|---|
| `apps/desktop/scripts/dev.ts` | 支持 `DSH_DESKTOP_DEV_ROOT` 指定独立开发根（避免与第二实例抢目录） | 开发体验，官方没有 | 可上游化（B），但优先保留 |
| `apps/desktop/scripts/electron-builder-config.mjs` | 见 K15 | 打包必需 | 名称部分为 E（品牌冲突）→ 保留 |
| `apps/desktop/scripts/installer.nsh` | 见 K16 | 打包必需 | 保留 |
| `apps/desktop/installer/strings.nsh` | 安装器文案改名（含中文） | 品牌 | 保留 |
| `apps/desktop/scripts/smoke-packaged-runtime.ts` | 见 K17 | 打包必需 | 保留 |
| `scripts/client-build-environment.ts` | 见 K14 | 构建必需 | 保留 |

---

## 五、资源与品牌

| 路径 | 改动摘要 | 保留理由 | 融合提示 |
|---|---|---|---|
| `apps/desktop/installer/assets/` | NSIS 头图/侧栏/深色版换 Cadre（5 个 PNG） | 品牌 | 保留（E） |
| `apps/desktop/renderer/assets/welcome-brand.svg` | 欢迎页品牌图 | 品牌 | 保留（E） |
| `apps/desktop/resources/icon.png` | 应用图标（512 印章） | 品牌 | 保留（E） |
| `apps/desktop/resources/icon-macos.png` | macOS 图标 | 品牌 | 保留（E） |
| `apps/desktop/resources/icon.ico` | Windows 多尺寸应用图标（新增） | 品牌 | 保留 |
| `apps/desktop/resources/installer.ico` | 安装器图标（新增） | 品牌 | 保留 |
| `apps/desktop/resources/tray.ico` | 深色任务栏托盘图标（新增） | 品牌 | 保留 |
| `apps/desktop/resources/tray-light.ico` | 浅色任务栏托盘图标（新增） | 品牌 | 保留 |
| `apps/web/public/favicon.svg` | 站点图标换印章 | 品牌 | 保留（E） |
| `apps/web/public/favicon-dark.svg` | 深色站点图标 | 品牌 | 保留（E） |

---

## 六、测试基线与文案（官方包内）

> 以下改动都是**产品改名带来的连锁更新**，不改变官方逻辑；升级时官方改同一文件，按 §3.5 A/B 判断（通常保留我们的文案，除非官方重写了该文案结构）。

| 路径 | 改动摘要 |
|---|---|
| `apps/desktop/tests/expected/about-panel.json` | 关于面板应用名/菜单文案 |
| `apps/desktop/tests/expected/application-menu-en-US.json` | 英文菜单快照 |
| `apps/desktop/tests/expected/application-menu-zh-CN.json` | 中文菜单快照 |
| `apps/desktop/tests/background-notice.spec.ts` | 通知标题断言 |
| `apps/desktop/tests/main-startup.spec.ts` | Windows 清理重试 + 用户目录隔离 |
| `apps/desktop/tests/tray.spec.ts` | 托盘明暗图标断言 |
| `apps/desktop/tests/welcome-startup.spec.ts` | nativeTheme mock 补事件接口 |
| `apps/desktop/tests/installer-packaging.spec.ts` | 图标来源与配置形状断言 |
| `apps/desktop/tests/macos-signature.spec.ts` | 协议名断言 |
| `packages/client/ui-settings-account/tests/expected/` | 账户/引导页文案快照（12 个文件） |
| `packages/client/ui-settings-account/src/client/locales.ts` | 账户设置文案改名 |
| `packages/client/ui-settings-account/src/client/locales/onboarding.ts` | 引导文案改名 |
| `packages/client/ui-settings-models/src/client/locales.ts` | 欢迎弹窗文案改名 |
| `packages/client/ui-settings-models/tests/welcome-notice.client.spec.tsx` | 对应断言 |
| `packages/client/ui-plugin-manager/src/client/locales.ts` | 插件安装安全提示改名 |
| `packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts` | Office 预览提示改名 |
| `packages/client/web/tests/boot-page.client.spec.ts` | 启动页字标断言 |
| `packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx` | 品牌槽断言（含 hero） |

---

## 七、仅版本号变化

344 个 `package.json` 只有 `version` 从 `0.2.1-rc.2` 变为 `0.5.1`，由发布脚本统一 bump，不逐条登记。自动检查的 `version-only package.json` 分组列出全部路径。

---

## 八、构建残留（非产品改动，建议清理）

以下文件是构建或临时步骤落到源码树里的产物，**不属于有意改动**，自动检查已归类为 residue：

| 路径 | 来源 |
|---|---|
| `packages/test-support/session-snapshot/src/` 下的 `*.js` / `*.d.ts` | 测试支撑包被 tsc 直接编译进 `src/`（应删除或改出到 `lib/`） |
| `packages/test-support/llm-replay/src/` 下的 `*.js` / `*.d.ts` | 同上 |
| `packages/test-support/loader-smoke/src/` 下的 `*.js` / `*.d.ts` | 同上 |
| `packages/llm/deepseek-llm-api-extensions/src/` 下的 `*.js` / `*.d.ts` | 同上 |
| `vendor/src/`、`vendor/package.json`、`vendor/tsconfig.json`、`vendor/LICENSE` | 疑似把 `vendor/cosmokit` 的包内容复制到了 `vendor/` 根（误操作残留） |
| `.dsh-build/client-build-environment.json` | 构建记录（已在忽略列表外，建议加入忽略） |
| `undefined/temp/tsx-*` | tsx 运行时的临时缓存目录（环境变量缺失时生成，建议清理） |

> 清理不属于本单范围；登记在此，避免下次比对时重复排查。

---

## 九、升级流程（选择性融合）

1. 更新 `vendor/deepseek-harness` pin，跑官方 prepare 链产出新基线；
2. 运行 `node desktop/scripts/check-upstream-drift.mjs`，得到新版差异清单；
3. 对**每一处**变更按 ADR-0023 §3.5 判据决策：融合 / 保留 / 延后，并把判据与证据写回本表；
4. 融合：删掉我们的实现，改用官方；保留：在本表更新「官方已有但冲突」的具体冲突点与复评条件；
5. 跑回归清单（官方 UI 启动、协作面板、账本读写、员工模板可选、模型选择无账户、多会话、打包冒烟）；
6. 记录本次 diff 行数、融合/保留比例与未决项。

**禁止**：无判据的整包重放；把「官方更新了」当作融合理由；在本表之外悄悄改官方文件。

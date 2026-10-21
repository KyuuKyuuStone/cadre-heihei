# 前端资产迁移清单（W1-10）

- **来源**：`D:\xxw_p\claude-code-heihei`（只读），tag `v1.7.9` = `8ab1c241`。
- **commit 口径**：下表 `@hash` 为该来源文件最后一次修改的 commit（`git log -1 --format=%h -- <path>`），不是整仓 HEAD。
- **搬迁原则**：只搬首版三屏需要的纯函数与文案；与桌面/Electron/前身业务类型耦合的件一律不搬并登记原因。

## 1. i18n（`app/src/renderer/i18n/`）

| 目标文件 | 来源 @ commit | 适配说明 |
|---|---|---|
| `i18n/locale.ts` | `desktop/src/i18n/locale.ts` @ `b22af51` | 浏览器全局改为最小结构类型访问（新 app tsc 未启 DOM lib）；逻辑未改 |
| `i18n/index.ts` | `desktop/src/i18n/index.ts` @ `2106a2e` | **移除** `useTranslation` 与 zustand `t()`（renderer 尚无 UI 框架/状态库）；保留边表合并、`TextKey` 并集、`translate` 纯函数 |
| `i18n/locales/en.ts` | `desktop/src/i18n/locales/en.ts` @ `a7039db` | 原样 |
| `i18n/locales/zh.ts` | `.../zh.ts` @ `a7039db` | 相对导入补 `.ts` |
| `i18n/locales/zh-TW.ts` | `.../zh-TW.ts` @ `a7039db` | 相对导入补 `.ts`；文件内导出名仍为 `zh`（沿用前身，index 以别名 `zhTW` 导入） |
| `i18n/locales/jp.ts` | `.../jp.ts` @ `a7039db` | 相对导入补 `.ts` |
| `i18n/locales/kr.ts` | `.../kr.ts` @ `a7039db` | 相对导入补 `.ts` |
| `i18n/locales/speech.ts` | `.../speech.ts` @ `2106a2e` | 边表机制样例；**首版未引用**（无语音 UI），二期启用 |
| `i18n/locales/contextSource.ts` | `.../contextSource.ts` @ `95d0d5a` | 边表机制样例；**首版未引用**（界面不做 token 用量） |

边表机制保持不变：主表 2495–2497 行（file-size 上限 2500，不许增行），专项词条独立成文件，`index.ts` 运行时合并、类型面并集。

## 2. lib 通用件（`app/src/renderer/lib/`）

| 目标文件 | 来源 @ commit | 适配说明 | 三屏用途 |
|---|---|---|---|
| `apiErrorMessage.ts` | `desktop/src/lib/apiErrorMessage.ts` @ `bd6b858` | `ApiFailureKind` 为本地过渡联合类型，已标 `TODO(M1)`：接入 `app/src/collab/protocol` 错误码后替换；i18n 路径改本地 | 会话流错误条、跨项目拒绝文案 |
| `formatMessageTimestamp.ts` | `.../formatMessageTimestamp.ts` @ `b22af51` | 仅改 import 路径 | 会话流消息时间 |
| `sessionTitle.ts` | `.../sessionTitle.ts` @ `b22af51` | 无改动 | 会话标题、花名册/会话切换 |
| `filePathBoundary.ts` | `.../filePathBoundary.ts` @ `b22af51` | 相对导入补 `.ts` | 消息中文件路径识别、打开落盘文件 |
| `urlBoundary.ts` | `.../urlBoundary.ts` @ `b22af51` | 无改动 | 同上（被 filePathBoundary/assistantOutputTargets 依赖） |
| `assistantOutputTargets.ts` | `.../assistantOutputTargets.ts` @ `b22af51` | 相对导入补 `.ts` | 会话流产物入口 |
| `browserSafePort.ts` | `.../browserSafePort.ts` @ `b22af51` | 无改动 | 「服务不可用」态与端口校验 |
| `cx.ts` | `.../cx.ts` @ `b22af51` | 无改动；前身无测试，**返工已补 4 例最小测试** | 组件 className 拼接 |
| `formatBytes.ts` | `.../formatBytes.ts` @ `b22af51` | 无改动；前身无测试，**返工已补 4 例最小测试** | 截断标注的字节数展示 |

## 3. 测试（`app/tests/renderer/`）

测试位置从源文件同目录调整到 `tests/renderer/`，以沿用现有 `node --test "tests/**/*.test.ts"`，未改 `package.json`。

| 目标文件 | 来源 @ commit | 适配说明 |
|---|---|---|
| `i18n/locale.test.ts` | `desktop/src/i18n/locale.test.ts` @ `b22af51` | vitest/jsdom → node:test + 最小 `localStorage`/`document`/`navigator` stub；原 7 用例全部保留；`vi.fn` 计数改为显式计数；返工新增 3 例：旧键一次性迁移写新键、新键优先、非法旧值不迁移 |
| `i18n/index.test.ts` | `desktop/src/i18n/index.test.tsx` @ `3a304df` | 保留全部 `translate` 与键表用例；**React hook 用例未搬**（见未适配项）；新增主表键 parity 与边表机制用例（逐语言比对边表字典值） |
| `i18n/speech.test.ts` | `.../speech.test.ts` @ `2106a2e` | vitest → node:test；断言未改 |
| `i18n/contextSource.test.ts` | `.../contextSource.test.ts` @ `95d0d5a` | vitest → node:test；断言未改 |
| `lib/apiErrorMessage.test.ts` | `.../apiErrorMessage.test.ts` @ `f356346` | 去 zustand store，直接把 `translate` 绑定 `zh`；断言未改 |
| `lib/formatMessageTimestamp.test.ts` | @ `b22af51` | vitest → node:test；断言未改 |
| `lib/sessionTitle.test.ts` | @ `b22af51` | vitest → node:test；断言未改 |
| `lib/filePathBoundary.test.ts` | @ `04fe222` | vitest → node:test；断言未改 |
| `lib/urlBoundary.test.ts` | @ `da12189` | vitest → node:test；断言未改 |
| `lib/assistantOutputTargets.test.ts` | @ `b22af51` | vitest → node:test；断言未改 |
| `lib/browserSafePort.test.ts` | @ `b22af51` | vitest → node:test；断言未改 |
| `lib/cx.test.ts` | 新增（返工） | 前身无测试；覆盖拼接、falsy 过滤、空结果、不做冲突类合并 4 例 |
| `lib/formatBytes.test.ts` | 新增（返工） | 前身无测试；覆盖 0/负数/非有限、B/KB/MiB/GiB 换算 4 例 |
| `renderer/assert-compat.ts` | 新增（非搬迁） | 最小 `expect` 适配层（映射到 node:assert/strict），只覆盖搬迁测试用到的 matcher |

## 4. 未搬迁（停止记录，未静默删除）

| 件 | 原因 |
|---|---|
| `i18n/index.ts` 的 `useTranslation` / `t()` | 依赖 React 与 zustand `settingsStore`；renderer 尚未引入 UI 框架与状态库 |
| `i18n/index.test.tsx` 的 hook 用例 | 依赖 `@testing-library/react` + zustand；随 hook 一起暂缓 |
| `lib/speech/**` | 语音二期（任务明确不搬） |
| `lib/backgroundTasks.ts` | 依赖前身 `types/chat` 的 `BackgroundAgentTask` 业务类型 |
| `lib/recentProjectsCache.ts` | 依赖前身 `api/sessions` 的 `RecentProject` 类型 |
| `lib/sessionWorkspace.ts` | 依赖前身 `types/session` 类型 |
| `lib/parseRunOutput.ts` | 解析前身 CLI stream-json 输出，与 harness 事件模型不一致（且无测试） |
| `lib/markdownAutolink.ts` | 依赖外部包 `marked`，引入需先改 `app/package.json`（未获批准） |
| `lib/desktopHost/**`、`appZoom`、`clipboard`、`desktopNotifications*` | Electron/桌面宿主 API 耦合 |
| `lib/preview*`、`htmlPreviewPolicy`、`openWith*`、`handlePreviewLink` | Diff/预览二期 |
| `lib/composerAttachments`、`attachmentImages`、`imageCompress`、`selectionComposer` | 输入附件二期 |
| `lib/modelChoices`、`providerModels`、`providerSettingsJson`、`runtimeSelection`、`localModelPlan`、`mcpStatus`、`persistenceMigrations`、`skillFrontmatter`、`terminalRuntime`、`terminalTheme`、`touchH5`、`diagnosticsCapture`、`doctorRepair`、`cronDescribe`、`publicAsset`、`formatTokenCount` | 非首版三屏；token 用量界面不做 |

## 5. 验证

- `node --test "tests/**/*.test.ts"`：本搬迁件相关 **180 例全绿**（含返工新增 11 例）；同次全仓运行（含并行角色新增用例）**fail 0**。
- 四门禁 `node scripts/gates/run-all.ts`：**4/4 PASS**（file-size / import-semantics / tsc-baseline / smoke）。
- **判别力自证**：① 临时移除 `zh` 的边表合并（`zh: { ...zh }`）→ `index.test.ts` 边表用例 1 红，复原后全绿；② 临时去掉旧键迁移的 `setItem` → `locale.test.ts` 迁移用例 1 红，复原后全绿。
- 未验证：任何 UI 渲染、无障碍、真实 renderer 运行——本批只有纯函数与文案。

## 6. 已定与待确认

1. `LOCALE_STORAGE_KEY` 已改为 `cadre-heihei-locale`；读到前身旧键 `cc-heihei-locale` 时一次性迁移写新键（旧键保留，新键优先），已有 3 例测试覆盖。
2. `ApiFailureKind` 为本地过渡类型，源码已标 `TODO(M1)`：接入 `app/src/collab/protocol` 错误码后替换。
3. `cx.ts`、`formatBytes.ts` 前身无测试，返工已各补 4 例最小测试。
4. `speech.ts`、`contextSource.ts` 边表**首版未引用**，保留作边表机制样例（供后续专项词条照此拆分）。
5. renderer 未启用 DOM lib，`locale.ts` 用最小全局类型过渡；引入 UI 框架时应为 renderer 单独配置 DOM lib。
6. 未改 `package.json`、`tsconfig.json`、`src/ports`、`src/collab/protocol`。
7. `app/scripts/gates/evidence/` 为门禁运行产物，已加入 `.gitignore` 并移出索引，本地留存供汇报引用。

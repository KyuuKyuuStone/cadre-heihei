# 交接记录 · backend / EnginePort & desktop & 协作闭环

> 时间：2026-10-24 18:20（下压前）
> 状态：闭环工具代码已提交 `37ed89ba`，**插件未被 Host 挂载**，真实闭环未验证；无在跑进程。

## 当前进度

| 单元 | 状态 | 提交 |
|---|---|---|
| EnginePort S2 / S3 / client 接线 | 完成 | c618a4f6 / 47de27ff / ad6cb4ac |
| P0 转员工修复（profile bundle 补齐 + 员工镜像 members） | 完成 | 4b543a3e |
| 关窗提示移除 | 完成 | f9783f74 |
| 协作最小闭环工具（dispatch_task / report_task / list_employees） | **代码完成，未跑通** | 37ed89ba |

## 闭环卡点（从这继续）

1. 组合层已确认包含该行：用 app-boot 复算 profile 组合，输出
   `cadre-collab -> @deepseek-ai/dsh-bundle-cadre`（另有 4 个 preset 行）。
2. 但 Host 启动后 `cadre-collab` 的 `apply` 不执行：`<ledger>.plugin.log` 未生成，
   也没有 `CADRE_LEDGER_PATH unset` 的兜底日志；模型侧看不到新工具（一次
   dispatch 指令只产生文本、无工具调用）。
3. 下一步定位方向（按可能性）：
   - loader 解析行名时用的基准/白名单（bundle 自身作为插件行是否被过滤）；
   - bundle package 的 exports/main 是否满足 loader 的 ESM 入口要求；
   - 用 Host inspector(9230) 或在 loader 源码里加一次性日志，确认是否尝试过 import；
   - 若 bundle 行不可行，改为新增独立 Host 插件包并加入 profile 依赖闭包。
4. 打通后按验证清单：真实模型 → dispatch_task 日志 `cadre-collab: dispatch ok` →
   员工会话收到【Cadre 任务】→ report_task 日志 → 主管会话收到【员工汇报】→
   `window.cadre.transitionTask({taskId,to:'verified'})` 验收。

## 关键文件

- `packages/bundle/cadre-app/src/index.ts`：Ledger + 三个工具（含补偿/幂等/诊断日志）
- `packages/bundle/cadre-app/cordis.patch.yml`：`cadre-collab` 行（id 唯一）
- `apps/desktop/src/main.ts`：向 Host 注入 `CADRE_LEDGER_PATH` / `CADRE_PROJECT_ID`
- 环境：`D:/xxw_p/cadre-spike-env/s-loop/{home,dev-root,launch6.log}`
  启动命令模板见下方「踩坑」。

## 踩坑

- **改完 ts 必须两层构建**：`tsc -b tsconfig.host.json`（产出 lib/types）之后
  `tsdown --env.DSH_BUILD_FACE host`（产出 lib/index.js）。只跑 tsdown 会继续
  打包旧 lib/types（本单因此白折腾两轮）。验证方法：`grep dispatch_task lib/index.js`。
- `pnpm --filter ... run start` 已自带 `--skip-build`，不要再追加 `-- --skip-build`。
- dev 启动：`DSH_HOME=... DSH_DESKTOP_DEV_ROOT=... DSH_DESKTOP_RENDERER_DEBUG_PORT=933x pnpm --filter @deepseek-ai/dsh-desktop run start`
- 旧 profile 只在首建写 bundles（P0 已补 reconcile）；profile 在 `$DSH_HOME/profiles/desktop`。
- 前端并行改动多，提交一律 `git commit --only <paths>` 或先清点 `git diff --cached`。

## 其他待办

- P0 的安装包复验（dev 等价运行态已验证）。
- 20 条已知失败测试按用户口径本期不修。
- B1（Host 单写者）未开工。

## 根因已定位（2026-10-24 18:10）

launch8.log:40-41 确证：`dsh: warning: 1 entry did not activate` /
`cadre-collab (@deepseek-ai/dsh-bundle-cadre): failed to import: ERR_MODULE_NOT_FOUND
… imported from $DSH_HOME/profiles/desktop/`。

- loader baseUrl = profile 目录；profile 无 node_modules；bundle 自身被
  `collectProfileScopePackages` 从 profile 链接里显式删除（profile.ts:594-604），
  所以「bundle 自己当插件行」必然解析失败；preset 行不走 loader 才显得正常。
- 修复：独立包 `packages/cadre/host-collab` + bundle deps 依赖它 + patch 行改名；
  同步修 CADRE_LEDGER_PATH 注入（Host env 实测缺失）。

## P0 装机 file:// fallback 诊断（未完成，交接用）

### 线索（已查，未定性）
- 主窗口唯一加载点是 `apps/desktop/src/main.ts:628` 的 `window.loadURL(url)`，url 来自 Host
  ready 消息（`dsh web: http://…`）；**main 里没有 `file://` / `loadFile` 降级分支**。
- 全仓 `loadFile` 只出现在：`welcome-window.ts:120`（`renderer/welcome.html`）、
  `policy-test-auth.ts:127`（登录加载页）、`mandatory-update-window.ts`（更新兜底页）。
- `fallback` 关键词只在 `mandatory-update-policy.ts`（更新兜底页）等无关位置出现。
- 推论（未验证）：装机看到的「官方样式页」不是 main 的显式降级，更可能是 Host 未 ready 时的
  产物 —— 例如窗口加载了静态资源，或 `dsh-app://app` 前端在缺少 host 注入时只渲染半成品。

### 下一步三条
1. **先拿装机日志**：装 `package:win:x64:unsigned` 产物后看 userData 日志，确认 Host 是否发出
   ready；若未 ready，需要先把 Host stderr 落盘（见下）再采一次。
2. **对比 dev / packaged 两条启动路径**：dev = `apps/desktop/.desktop-build/development`；
   packaged = `.desktop-build/targets/win-x64/dsh`（asar 内）。逐项比对入口、cwd（projectDir）、
   env（`desktopNodeEnvironment`）、资源根、profile 位置。
3. **检查 host-collab 是否进装机闭包**：`packages/cadre/host-collab/package.json` 有
   `"private": true`，且 files 只列 lib；需确认它被 bundle 依赖闭包/`prepare-package-set` 带进
   `targets/win-x64/dsh/node_modules`，否则 profile 行解析会失败（与 dev 的 1-entry 告警同类）。

### 怀疑但未验证
- **identity.json 门槛**：不清楚 `identity.json` + members 校验是谁加的、在启动路径哪个环节读，
  是否会在干净装机环境阻断 Host 或窗口。
- **host-process stderr 缓冲**：`apps/desktop/src/host-process.ts:204` 把 stderr 收进内存，
  仅退出/fatal 时拼接打印；装机启动失败时这段诊断基本看不到，建议改成同时落盘
  （userData/logs/host-stderr.log），这是后续所有装机诊断的前置能力。
- 参考：dev 下同类问题（loader 解析失败）就是靠 Host stdout 的
  `1 entry did not activate` 才定位的；装机必须先有等价可见性。

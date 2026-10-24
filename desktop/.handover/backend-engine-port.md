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

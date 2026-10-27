# Packaging Playbook（一条命令出包）

## 一键发布

```bash
cd desktop/apps/desktop
pnpm release:win --version 0.5.1             # 全流程：bump → 预检 → 构建 → 校验 → 发布
pnpm release:win --version 0.5.1 --dry-run   # 只到预检，打印执行计划
node scripts/preflight-package.mjs           # 单独预检
pnpm -w run package:desktop:win:x64:unsigned # 单独构建（预检通过后）
```

- 每步失败即停，输出「哪一步/为什么/建议命令」；日志在 `apps/desktop/.desktop-build/release-logs/<ts>/`。
- 内置降并发（DSH_GATE_CONCURRENCY=3 + NODE_OPTIONS=--max-old-space-size=8192）与 npmmirror。
- 发布落 `D:\xxw_p\cadre-release\<version>\`（exe + SHA256.txt + README.txt，README 自动带 CHANGELOG 摘要）。

## 常见失败对照表（0.5.0 三类教训固化）

| 症状 | 根因 | 检查 | 修复 |
|---|---|---|---|
| host aggregate check 报 TS6133/TS2322（tests/*.spec.ts） | 测试文件的 TS 严格错误，跑到 20 分钟才炸 | 预检 step 1（官方 `build.ts --scope check` 同款） | 删未使用引用/修类型；预检 2 分钟内拦下 |
| 尾段 smoke spawn ENOENT（DeepSeek Harness.exe） | 产品名改名后官方脚本硬编码旧 exe 名 | 预检 step 2（全仓 DeepSeek Harness 残留扫描） | 改 smoke-packaged-runtime 等硬编码并登记 UPSTREAM.md |
| makensis `Error in script <stdin> line N` | NSIS 资源缺失（bmp/ico）或宏语法（标签重复） | 预检 step 3/4（图标四件格式、nsis.* 指向、bmp 生成） | 跑 prepare-windows-installer.ps1 重生成 bmp；NSIS 宏用 LogicLib `${If}` 不用标签 |
| afterPack check-no-secrets 拦截 | 用户 API Key 混进打包面 | 预检 step 5 | 按输出 file:line 清除，**绝不绕过门禁** |
| telemetry/清理宏丢失 | 改动 installer.nsh 后未确认 | 预检 step 6 | customInstall 宏必须在位（含 %APPDATA% 边界注释） |

## 边界约定

- 安装器 customInstall 只清 `$INSTDIR` 内程序文件；**用户数据（%APPDATA%）绝不动**。
- installer.ico 必须与 icon.ico 同源（seal）；NSIS 编译期资源不进 runtime resources。
- 安装包不含 `.env*`、`*.pem`、`*.pfx`、`user-data/`、`*.sqlite`（check-no-secrets 双扫）。

## 发布与提交纪律（用户硬规则，2026-10-23）

- **任何 `git push` 必须经用户明确授权**——团队任何人不得自行推送；口头批准不算；当前仓库无远端，将来配置远端后同样适用。
- 工具层已落地：`release.mjs` 中 `--push` 默认被拒，须 `--push --confirm` 双重显式；无远端配置时直接 fail（step 0-push-guard）。
- 对外发布**以版本为节点**：推送前整理成面向版本的提交集，必须同时具备 ① 版本号 ② CHANGELOG ③ 发布必过清单通过 ④ 用户确认——缺一不可。
- 本地 commit 照常（开发/回滚需要），但不构成对外发布、不代表可以推送。

## 桌面 main 必须走 `run build`，不能只跑 `tsc`

`apps/desktop/lib/main.js` 由 `pnpm --filter cadre-heihei-desktop run build`
（= `tsc -b && tsdown bundle`）产出；`tsc -b` 只更新 `lib/types`，**不会**刷新
`lib/main.js`。只跑 tsc 后启动 dev 或手测，实际跑的是旧 main（表现为新加的
env 注入/IPC 不生效、旧行为残留）。已两次造成误判。

- 改任何 `apps/desktop/src/*.ts` 后：`pnpm --filter cadre-heihei-desktop run build`，再 `run start`。
- 发布链已覆盖：`package-target.ts` 先 `run build:official`（含 tsc + tsdown 两个 face + desktop bundle），
  所以安装包不受此坑影响；此坑只影响 dev/手测。
- Host 侧插件（`packages/...`）除了 `tsc -b tsconfig.host.json` 还须
  `tsdown --env.DSH_BUILD_FACE host`，同样两层。
- 快速自检：`grep -c "<新标识>" apps/desktop/lib/main.js` 与
  `packages/<pkg>/lib/index.js` 均 > 0 再启动。

## primary-runtime 残缺自检与恢复（node.exe ENOENT 的真相）

`primary-runtime`（`.desktop-build/targets/win-x64/runtime/`）由
`apps/desktop/scripts/prepare-runtime.ts` 生成，**每次执行先整树删除
`RUNTIME_ROOT` 再重建**（`prepare-runtime.ts:54` `rmSync(RUNTIME_ROOT)`）。
构建/复制中途被中断（kill、重启、断电）就会留下**残缺树**：典型症状是
`run start` 报 `dependencies/node/bin/node.exe ENOENT`，随后 python venv
`ensurepip` 也失败（同一中断打断了 node 与 python 两段复制）。

- **与 host tsdown 无关**：tsdown 只写 `lib/`，不会碰 `runtime/`——别朝这个方向排查。
- **恢复**：跑官方全链（`release:win` 或 `build:official`，prepare-runtime 在链内自动重建，
  0.5.2 已验证）；**单跑 `prepare:runtime` 在本机静默退出**（dsh 树段后无输出即死，
  根因未明——待后端诊断，勿反复盲跑）。
- **自检**：`ls apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime/dependencies/node/bin/node.exe`
  与 `dependencies/python/python.exe` 都在，才说明 runtime 完整；preflight 已加入该检查。

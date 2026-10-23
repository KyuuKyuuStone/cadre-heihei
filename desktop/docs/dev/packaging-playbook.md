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

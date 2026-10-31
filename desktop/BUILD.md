# 构建指南（BUILD）

## 前置要求

- Windows 10/11（打包链为 NSIS；Linux/macOS 仅用于开发）。
- Node `^22.19.0 || >=24`（需内置 zstd，用于会话日志）。
- pnpm `11.28.5`（`packageManager` 锁定；`corepack prepare pnpm@11.28.5 --activate && corepack enable pnpm`）。
- 可选：Visual Studio Build Tools（安装器资源编译）；EV 代码签名证书（仅签名发布需要）。

## 首次构建

```sh
git clone <仓库地址> && cd <仓库>/desktop
pnpm install --frozen-lockfile
pnpm run build:cadre        # 两个 gitignore 的 CJS 运行时产物（主进程与 Host 桥）
pnpm run build              # 全量 TS/TSUP 产物
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm run typecheck` | 5 个聚合全量类型检查 |
| `pnpm run gates` | 五门禁（构建一致性/文件规模/import 语义/tsc 基线/双 runner smoke） |
| `pnpm run gates:evidence` | 门禁判别力两态自证（坏样本必红→复原必绿） |
| `pnpm run build:check` | 发布前构建一致性检查 |
| `pnpm run dev:desktop` | 桌面开发态（predev 自动重建 CJS） |
| `pnpm run test` | 全量测试 + smoke |

## 离线与镜像

- 依赖默认 npmjs；内网用 `pnpm install --registry=https://registry.npmmirror.com` 单次替换（勿写入仓库配置）。
- Electron 运行时支持 `ELECTRON_MIRROR` 镜像；离线机器先在有网机器完成 `pnpm install` 与运行时准备，再整目录搬运。
- 两个 CJS 产物（`apps/desktop/lib/cadre-collab.cjs`、`packages/cadre/host-collab/lib/cadre-ledger.cjs`）不入库；干净 checkout 后必须 `pnpm run build:cadre` 重建，门禁 `cadre-build` 会拒绝陈旧产物。

## 打包

- 发布链：`pnpm release:win --version x.y.z`（bump → CJS 重建 → preflight → 打包 → verify → publish）。
- 打包守卫：装配链内置 `ensureCadreBundles`/`assertCadreAsarEntries`，干净 checkout 缺产物即硬失败。
- dry-run：`--dry-run` 真跑 preflight（含 stamp 校验）。

# app · cadre-heihei 应用工作区

W1-03 只建立 pnpm workspace 骨架与 A 档门禁，**不含业务逻辑**。

## 结构

```
app/
  package.json            pnpm 根包（Node 关键路径，不使用 Bun）
  pnpm-workspace.yaml     独立 workspace；不 include vendor/
  tsconfig.json           NodeNext + strict + noEmit
  src/
    ports/ adapters/ collab/ main/ preload/ renderer/
  scripts/
    gates/                四个门禁、fixture、evidence、baseline
    git-hooks/            pre-commit / pre-push 与安装脚本
    preflight-release.mjs 出包前验证（build 阶段未适配，见下）
  tests/                  Node test runner（smoke/acceptance）
```

## 常用命令（在 `app/` 下）

```
pnpm install
pnpm run gates              # 四门禁顺序执行
pnpm run gates:evidence     # 注入必红 → 复原必绿
pnpm test                   # 直接跑 Node test runner
pnpm run hooks:install      # 安装 pre-push（非阻塞提醒）
pnpm run hooks:install:pre-commit
```

四门禁：`check-file-size`、`check-import-semantics`、`check-tsc-baseline`、`smoke`
（`smoke` 使用 `acceptance-lib` 解析 JUnit 并强制非空、无跳过）。
详见 `scripts/gates/README.md`。

## 未适配项

- `preflight-release.mjs` 的 `build` 阶段未适配（尚无打包配置），显式 fail-closed，不伪造通过。
- 前身 `smoke-critical-paths.ts` 是业务冒烟（桌面 sidecar/派活汇报），W1-03 无业务逻辑，
  未迁移；用 Node test runner 的 smoke 门禁替代。
- 前身 desktop tsc / electron-builder / sidecar / CC 业务字面量未迁移。

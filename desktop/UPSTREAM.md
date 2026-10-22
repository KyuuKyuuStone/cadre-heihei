# UPSTREAM：vendor/deepseek-harness 复制基线

- baseline pin: 687f282e（vendor/deepseek-harness commit，s28 复制时点）
- 复制方式：apps/desktop、apps/desktop-host、apps/cli、packages/**、native/system、scripts/**、根配置（pnpm-workspace 收窄 + 保留 overrides）；未改源码，构建产物（lib/dist）除外按需补齐
- 升级流程：重跑官方 prepare 链产出新基线 → 闭包/差异比对 → 重放本表 diff

## 与 vendor 的差异（复制后必要修改登记）

| 文件 | 差异 |
|---|---|
| apps/desktop/scripts/electron-builder-config.mjs | files 白名单追加 lib/cadre-collab.cjs（主进程台账后端进 asar） |

# 参与贡献

[English](CONTRIBUTING.md) | 中文

感谢关注 Cadre Heihei（基于 DeepSeek Harness 的多会话协作发行版）。

## 当前阶段

1.0 前以核心闭环打磨为主；欢迎 issue 与讨论，代码 PR 请先开讨论对齐范围。

## 提交纪律

- 只 `git add` 自己的文件（共享工作树多人在途）；`git diff --cached --name-only` 核验恰好 N 个。
- 禁 stash/reset/checkout 公共分支；`push` 必须先获得维护者授权。
- 改 `cadre-collab/**` 必须重建 CJS（`pnpm run build:cadre`）——门禁 `cadre-build` 会拒绝陈旧产物。
- 测试描述行为而非正确性；破坏样本（改坏必红）与修复同提交。

## 欢迎的贡献

- 缺陷报告：现象 → 复现步骤 → 预期（内部缺陷台账由维护者维护，外部用 issue）。
- 插件生态（`dsh-plugin` topic）、文档与翻译、复现与最小用例。

## 不做的事

- 不引入云服务/遥测；不改变「写的人和验收的人分离」的角色边界；不提交凭据或内部文档。

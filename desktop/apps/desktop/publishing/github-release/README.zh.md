---
description: "以单一发布人在 GitHub Releases 上发布桌面端预发布，并先证明三点提交一致。发布脚本在校验打包提交、tag 与 Release 目标全部一致前不写任何远端状态。"
---

# 桌面端 GitHub 发布

[English](README.md) | 中文

## 概述

以单一发布人在 GitHub Releases 上发布桌面端预发布，并先证明三点提交一致。发布脚本在校验打包提交、tag 与 Release 目标全部一致前不写任何远端状态。[发布参考](../README.zh.md)与 [CI 发布流程](../ci/README.zh.md)负责下载服务与自托管通道；本参考负责发布负责人直接在 GitHub 上发布的公开预发布通道。

## 目录

- [发布规则](#rules)
- [发布前准备](#before-you-publish)
- [用发布脚本发布](#publish)
- [失败文案与处置](#recovery)
- [事故对照：v1.5.3](#incident)

<a id="rules"></a>

## 发布规则

1. 一个版本只由一人发布。该版本已存在草稿或带资产的 Release 时，脚本会拒绝第二位操作者，并行发布无法重复上传。
2. tag `v<version>`、Release 的 `targetCommitish` 与打包提交必须是同一个提交。打包提交来自安装包旁的 `<target>-release.json` 完成记录——签名通道构建由打包脚本写入，unsigned 预发布从机器写入的打包运行记录派生——操作者不需要手输提交号。
3. 构建必须来自干净的检出。完成记录为 `dirty` 时拒绝发布，因为 tag 将无法指向用户实际收到的代码树。
4. 脚本先读后写：全部远端校验先行，绝不移动既有 tag，绝不覆盖资产，每次 create 都显式携带 `--target <commit>`。

<a id="before-you-publish"></a>

## 发布前准备

构建发布产物，并让完成记录保持在产物旁边。Windows 发布路径是 `pnpm release:win --version <version>`，它在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` 下产出安装包与相邻的 `.exe.blockmap`。unsigned 构建不写完成记录——签名通道构建才会写——因此在 `apps/desktop` 下运行 `pnpm exec tsx scripts/derive-unsigned-release-record.ts win-x64`，从机器写入的打包运行记录派生记录。该步骤读取该 target 最新的 unsigned 运行，拒绝 dirty、失败或未完成的运行；目录中没有唯一匹配记录版本的安装包时拒绝猜测，并把 `win-x64-release.json` 写在安装包旁。完成记录缺失或过期即硬性终止：重跑派生步骤，绝不手写记录。

把发布说明准备为 Markdown 文件；`--notes-file` 必填。发布前先把打包提交推送到 GitHub，因为 Release 必须指向远端已知的提交。`gh` 必须已安装并完成认证（`gh auth login`）；脚本使用操作者本人的 GitHub 身份，且绝不自行重试。

<a id="publish"></a>

## 用发布脚本发布

在 `apps/desktop` 目录下运行。先用 `--dry-run` 校验：它执行全部本地与远端检查，不写任何状态：

```sh
pnpm exec tsx scripts/desktop-github-release.ts \
  .desktop-build/targets/win-x64/unsigned-artifacts/cadre-heihei-1.5.4-win-x64-unsigned.exe \
  --notes-file <notes.md> --dry-run
```

去掉 `--dry-run` 即正式发布。脚本用 `gh release create v<version> --target <commit> --prerelease --title --notes-file` 创建预发布，不带 `--clobber` 上传安装包与 blockmap，回读 Release，并核对 tag、目标提交与每个资产的 state、大小与 SHA-256 摘要后才报告成功。已存在且指向打包提交的空 Release 会被续传；其余既有状态一律拒绝。

<a id="recovery"></a>

## 失败文案与处置

每次失败都会打印触发终止的规则，并以非零码退出且不再写入。`no completion record`、`names no version` 或 `is not a full commit id`：用打包脚本重建，然后用 `scripts/derive-unsigned-release-record.ts` 重新派生记录。`with uncommitted changes`：从干净检出重建。`is not on <repository>`：先推送发布提交。

`tag ... names X, not the packaged commit` 或 `is an annotated tag`：人工核对并处置 tag；脚本绝不移动它。`release ... targets X, not the packaged commit`：删除该 Release 后用脚本重新发布。`already carries N asset(s)`：另一位操作者已发布；先核对 Release，不要上传。`is a draft`：另一位操作者正在准备；与其当面对齐。`gh release upload ... failed` 或 `verification failed`：查看 Release，人工处置半完成状态，再重跑脚本。

<a id="incident"></a>

## 事故对照：v1.5.3

v1.5.3 发布时 `gh release create` 未带 `--target`，GitHub 把 Release 挂到默认分支头而不是 tag 所指提交：tag 指向构建提交而 Release 指向 master 头，第二位操作者上传同一资产被重名保护拒绝。脚本使这条路径不再可能：target 永远显式，不一致的 tag 或 Release 在任何写入前被拒绝，带资产的 Release 绝不被上传。

## 开发备注

unsigned 打包刻意不写完成记录；派生步骤是桥梁，让 GitHub 预发布通道从机器写入的打包运行记录复用同一记录契约，而不削弱记录本身的含义。

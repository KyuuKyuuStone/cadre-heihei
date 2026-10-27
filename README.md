# Cadre Heihei

> **主管的主要任务就是理解用户，然后去派活完成。**

你跟一个「主管」说想法，它理解、拆解、派给员工去做，做完了报给你看。你只做决定，不做操作。

**如臂使指，一念百行。**

> 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）构建 —— 感谢 DeepSeek 团队开源这套底座。

[下载安装](#下载安装) · [快速开始](#快速开始) · [三个概念](#三个概念) · [基于 DeepSeek Harness 构建](#基于-deepseek-harness-构建) · [English](#english)

---

## 它解决什么问题

一个人用 AI 做点东西——写小说、写软件、做运营——实际流程往往是：开一堆窗口，自己当调度，反复解释背景，拿到半成品再自己拼。AI 越能干，你越像一个项目经理，而不是创作者。

Cadre Heihei 把这些杂事交出去：**你只负责说想要什么**，主管负责理解与拆解，员工负责专业执行，你直接看结果。

- 想做一个网站 → 主管拆成前端、后端、测试，派下去
- 想写一本小说 → 主管拆成设定、大纲、章节，派下去
- 中途改主意 → 直接跟主管说，它重新安排

没有表单，没有看板，没有必须填的配置向导。产品体验就是**和主管对话**。

## 三个概念

- **项目部** —— 一个本地文件夹就是一个项目部，也是一条隔离边界。不同项目部之间互相看不见。
- **主管** —— 唯一跟你对话的人（每个项目部一名）。它负责理解你的想法、拆任务、验收员工的产出。它不干执行的活。
- **员工** —— 前端、后端、架构师、设计师、写作、资料整理……一个员工就是一个 AI 会话，只负责专业执行。
- **普通会话** —— 你随手问两句的对话。不算员工，不进花名册，随时可删。

## 基于 DeepSeek Harness 构建

Cadre Heihei 不是从零写的。它的底座是 **DeepSeek Harness**（[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT 许可）——DeepSeek 团队开源的一套插件式 Agent 基础设施。我们在这套底座上做修改与扩展，把它从「一个通用 Agent 运行时」改造成了「一个由主管派活、员工干活的协作产品」。

**我们重用的**

- **会话引擎**：会话生命周期、上下文压缩、JSONL 与 SQLite 持久化
- **插件体系**：Cordis 插件树、profile/bundle 组合、配置 patch 语义 —— 产品里几乎每项能力都是往这棵树上插一行
- **UI 框架**：客户端 slot 机制与设置页扩展（桌面端复用上游的 Web 客户端组件来构建界面）
- **模型与工具层**：provider 抽象、工具注册与权限流

没有这些，这个项目不会有今天的样子。

**我们添加的**

- 主管 / 员工的角色模型：花名册、任务台账、跨会话派单与汇报
- 派活与验收流程：只有主管能派活，员工只执行、不猜意图，两层汇报
- 侧栏「协作」面板与项目部隔离
- 品牌与安装器

**我们对官方代码的每一处改动**，逐条登记在 [`desktop/UPSTREAM.md`](desktop/UPSTREAM.md) —— 位置、理由、是否计划合并回上游。这是我们该有的透明度。

**许可证**：本项目采用 MIT，与上游一致。根目录 [`LICENSE`](LICENSE) 保留了 DeepSeek Harness 的原始版权声明（`Copyright (c) 2026 DeepSeek`）与本项目的声明；上游的 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 原样保留在 `desktop/` 下，未做改动。

## 下载安装

> 安装包**待发布**，将托管在 [GitHub Releases](https://github.com/KyuuKyuuStone/cadre-heihei/releases)（当前版本 0.8.7，2026-10-26，约 274 MiB）。

- **系统**：Windows 10 / 11
- **安装**：双击安装（当前为 per-user 安装）；启动时 Windows 可能弹出 SmartScreen 告警——安装包**未做代码签名**，点「更多信息 → 仍要运行」即可
- **账户**：不需要注册或登录；模型接入方式是**在设置页填你自己的 API Key**（支持多家服务商）
- **自动更新与遥测**：默认关闭
- **数据位置**：`~/.dsh`
  - `~/.dsh/cadre.sqlite` —— 花名册与任务台账
  - 卸载不会删除数据，重装不丢团队与历史

## 快速开始

1. **装好并启动**，打开「设置」填入模型服务商的 API Key
2. **建项目部** —— 选一个本地文件夹
3. **建人** —— 先建一名「主管」，再按需建员工（前端、后端……可直接套用角色模板，名称和职责都能改）
4. **跟主管说想法** —— 打开主管会话，把你想做的事说清楚。拆解、派活、催进度、验收，它自己会走

想让某个员工换个做法？点进它的会话直接说。所有任务流向主管，员工之间不互相说话。

## 截图

> 截图待补（0.8.7 正式界面：主界面 / 侧栏团队 / 主管对话）

## 技术栈与许可

- **平台**：**Windows 桌面客户端**（Windows 10 / 11）。上游代码包含 Web 端外壳，桌面端复用了它的客户端组件，但 **Web 端不在本项目的维护与支持范围内**。
- **桌面端**：Electron
- **内核**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT 许可），插件化架构
- **存储**：任务台账走本地 SQLite，会话持久化为 JSONL，全部留在本机
- **许可证**：[MIT](LICENSE)，与原项目一致
- **源码结构与贡献指南**：待补

## 前身

前身是 [cc-heihei](https://github.com/KyuuKyuuStone/claude-code-heihei)，已冻结于 v1.7.9。

---

## English

**Cadre Heihei** is a single-user desktop app that gives you an AI *supervisor*.

You describe what you want. The supervisor understands it, breaks it into tasks, dispatches them to AI *employees* (each a separate agent session with its own responsibility), reviews their work, and reports back to you. You never fill in a form, configure a workflow, or manage a board — the product *is* the conversation with the supervisor.

- **Project** = a local folder = an isolation boundary
- **Supervisor** = one per project; the only agent you talk to; understands, decomposes, dispatches, reviews
- **Employee** = 前端 / 后端 / 设计师 / 写作 …; executes one thing at a time, does not guess your intent

Current state: Windows preview, version 0.8.7, unsigned build.

**Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).** This project is not written from scratch — it is a modified and extended fork of DeepSeek Harness, with a collaboration layer (supervisor / employee roles, task ledger, dispatch and review) added on top. Every change we made to official code is recorded in [`desktop/UPSTREAM.md`](desktop/UPSTREAM.md). Licensed under MIT; [`LICENSE`](LICENSE) retains the original DeepSeek copyright notice.

Predecessor: [cc-heihei](https://github.com/KyuuKyuuStone/claude-code-heihei), frozen at v1.7.9.

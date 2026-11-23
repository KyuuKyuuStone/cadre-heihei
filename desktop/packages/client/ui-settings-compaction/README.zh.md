---
description: "dsh Web 客户端插件页中的上下文压缩设置：自动压缩与实时压力预算比例。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-compaction

[English](README.md) | 中文

## 摘要

在侧边栏打开**插件**，在“内置插件”组选择**上下文压缩**，即可控制自动压缩与压力预算比例。页面区分跟随部署、显式开启与显式关闭，保存前保留暂存修改，并可分别将字段恢复为部署组合的值。只有 Host 提供 `compaction-settings` 命名空间时页面才存在。

## 目录

- [使用此包](#使用此包)
- [理解实现](#理解实现)
- [进一步探索](#进一步探索)
- [模型体验](#模型体验)
- [已知限制与后续工作](#已知限制与后续工作)
- [开发说明](#开发说明)

-----

<a id="use-this-package"></a>
## 使用此包

**自动压缩**提供**跟随部署**、**开启**与**关闭**。**压力触发比例**接受大于 0 且不超过 1 的有限数字；数值越小，压缩越早。留空表示跟随部署。已覆盖的字段显示**已覆盖**标记与**恢复默认**操作。点击**保存**前不会写入；离开页面会丢弃草稿，非法输入会阻止保存，拒绝保存后会保留草稿。页面还说明压力预算、溢出恢复与手动 `/compact`，并将部署管理的安全限制标明为只读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 半侧的 `apply` 为空，只用于保留 Loader 行，使客户端模块系统能够提供浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `compaction-settings` 命名空间，在 `CompactionCardController` 中基于 `ui-primitives` 的共享 `SettingsFormModel` 保存两个字段的暂存状态，并通过 `ctx.configForms.whileServed` 将 `CompactionCard` 注册到插件页的 `plugins.item` 插槽。页面文案位于本包的 `settings.compaction` 字典。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.md)——插件页及本页注册的 `plugins.item` 插槽。
- [ui-settings](../ui-settings/README.md)——本页使用的设置作用域与已提供命名空间监听。
- [ui-primitives](../ui-primitives/README.md)——本页渲染的设置表单模型与字段。
- [compaction-basic](../../compaction/compaction-basic/README.md)——压缩行为与易变 Host 设置命名空间。

-----

<a id="model-experience"></a>
## 模型体验

本包不新增模型可见的提示、工具或请求字段。保存的值会改变 `compaction-basic` 文档所述的 Host 压缩行为。

#### KV 缓存影响

本包既不组装也不发送提供商请求；应用保存值产生的 KV 缓存影响由底层压缩引擎负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅易变字段**——本页只编辑 `auto` 与 `thresholdRatio`。绝对容量、保留预算、步骤压力与溢出重试安全字段仍由部署管理且只读。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

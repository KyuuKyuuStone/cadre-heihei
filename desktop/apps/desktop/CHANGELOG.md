# Changelog

## 0.5.2

- P0 修复：升级用户转员工恢复——profile 缺失的 cadre bundle 自动补齐（升级后不再「未设模板」）
- P0 修复：关窗不再弹「任务不会中断」提示，直接隐藏到托盘

## 0.5.1

- 浅色主题可读性修复
- 转员工时模板应用修复
- 安装器品牌清理：exe 图标与安装界面替换为 Cadre Heihei（不再出现鲸鱼与官方文案）
- 安装目录清理：重装到非空目录时自动清走旧程序文件（%APPDATA% 用户数据绝不动）
- 发布清单固化：preflight 六项预检（TS/产品名/图标/NSIS/密钥/清理宏）+ release.mjs 一键发布 + push 硬规则（--push 需 --confirm 双显式）
- 工程收编：整树源码与编译配置 3.8k+ 文件入库（源码层抢救，冻结点 cadre-experimental-0.5.0-src）

## 0.5.0

- 深色为主的昼流/夜流配色体系（驼色 tokens 全量落地）
- Cadre Heihei 品牌与笑脸图标（应用/托盘/安装器接线）
- 员工模板字段修复
- 打包密钥门禁（check-no-secrets：afterPack 扫描，命中即中止）
- 退出时关闭 SQLite 连接

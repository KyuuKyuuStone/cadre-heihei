# 安全政策（SECURITY）

## 报告漏洞

- GitHub 私密安全报告（Security → Report a vulnerability），**不要**公开 issue。
- 48 小时内确认，7 天内给出修复计划；严重问题先发缓解指引。

## 安全设计要点（供报告者定位）

- 单机单用户：密钥仅存本机（safeStorage/系统凭据服务），无遥测、无云依赖。
- 角色边界：主管只调度与验收，写路径由 `host-write-guard` 在 `tools/pre-execute` 收口（策略 JSON 数据化，fail-closed）；员工写路径由角色掩码与沙箱约束。
- 会话日志为 zstd 帧容器，本地存储于 `~/.dsh/`；卸载不清用户数据。
- 已知取舍：安装包未签名（SmartScreen 提示）；主管 shell 在策略中显式拒绝；跨项目部派活一律拒绝。

## 支持版本

- 仅最新 minor（0.10.x → 1.0.0）；升级路径含 additive 会话事件的前后向兼容（见 CHANGELOG）。

## 凭据泄露

- 立即轮换模型 API key；本产品不持有除模型凭据外的任何密钥。

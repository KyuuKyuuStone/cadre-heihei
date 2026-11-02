# Changelog

## 1.1.4

- **技能页单入口**：技能页只保留一个内嵌对话入口，问/装/建都走普通 `cadre-skill-admin` 会话，AI 用 catalog/preview/install 工具自行查询和安装
- **技能管理员去绑定**：admin session 不再绑定 supervisor/operator；消息读写/发送与 `skill_install` 按项目成员校验，worker 也可用，跨项目/非成员拒绝
- **SMTP IPv4/587**：nodemailer 强制 `family:4`；465 连接/超时失败自动回退 587 STARTTLS；连接/TLS 错误保留底层 code 并 redact
- **自然语言 install-any**：自由文本中提取一个包名或 URL；SkillHub 说明 URL + 包名走包名安装，仅 URL 走 URL 安装，歧义返回 `SKILL_INSTRUCTION_UNSUPPORTED`
- **授权码保存回退**：安装版 Host 拿不到 Electron `safeStorage` 时，自动回退 Windows DPAPI（PowerShell `ProtectedData`，密码经 stdin），仍失败才报 `SECRET_STORE_UNAVAILABLE`
- **兼容旧密文**：secret 文件保持原始密文格式；配置仍只存 `authCodeRef`，不存/不回传授权码；日志标明 provider/失败原因，不含授权码
- **邮件设置仅授权码**：SMTP 设置页只保留邮箱授权码直填，移除服务商/环境变量名等复杂配置；保存后写入安全存储
- **DPAPI 安全存储**：授权码经 Electron `safeStorage`（Windows DPAPI 用户作用域）加密写入 `%APPDATA%\Cadre\secrets\email\<projectId>.bin`，配置仅保留 `authCodeRef`，get 只回 `hasKey`；不落明文
- **删除环境变量名**：移除设置页的 `authCodeEnv` 输入；旧环境变量仍作为发送兼容回退并提示迁移
- **其余沿用 1.1.3**：技能界面重构/页内安装/全员可装/不分角色、SMTP QQ/163 默认、Resend 修正与高级提供方

## 1.1.3

- **技能界面重构**：技能库/每对话技能页统一为列表 + 安装入口，内置/已安装分层，安装结果直接刷新
- **技能安装内化为页内区块**：技能页常驻 URL / 包名安装区，移除安装弹窗；URL 走现有 GitHub 安装，包名走 `install-package`，高级安装仍可打开技能管理员对话
- **技能安装全员可用**：add/remove/install-url/install-package 允许同项目在册成员；技能管理员 plan/apply 仍仅 supervisor；非成员仍 `SKILL_FORBIDDEN`
- **技能不再按主管/员工区分**：manifest `roles` 仅元数据，选中即注册；catalog 不过滤；主管/员工可用同一套技能
- **包名安装（SkillHub）**：`POST /cadre/skills/install-package` 固定 WSL `skillhub install <name> --dir …`，严格包名校验、180s 超时、可读 unsupported/failure、审计
- **会话技能页重设计**：每对话技能页签/安装入口重新整理，成员可查看和调整本会话技能
- **SMTP 默认提供方**：`provider: smtp` 支持 QQ/163 预设（smtp.qq.com:465 / smtp.163.com:465，secure），填邮箱 + 授权码即可；auth code 只读 `QQ_EMAIL_AUTH_CODE` 等环境变量
- **Resend 修正 / 高级提供方**：SendGrid/Resend 保留为高级；Resend 不再本地 `verifiedDomains` 拦截，改由服务端 403/422 映射 `EMAIL_FROM_NOT_VERIFIED`/`EMAIL_RECIPIENT_RESTRICTED`
- **typecheck 修复**：修复技能安装测试与提供方设置相关的类型错误

### 已知限制

- SMTP 需要邮箱开启 SMTP 并使用授权码；QQ/163 可能触发风控/限额
- 包名安装依赖 WSL `Ubuntu-24.04` 与 `/root/.local/bin/skillhub`
- 安装包未签名（SmartScreen 提示）

## 1.1.2

- **技能管理员（普通对话）**：技能页内嵌 `cadre-skill-admin` hidden preset，普通 Session，不写花名册/不占员工位；`skill_catalog`/`skill_preview`/`skill_plan`/`skill_audit` 四个模型工具；安装/更新/删除由用户确认后走 `admin/apply`（planId+token），带备份、回滚、审计
- **技能管理员会话修复**：`sessionController` 改为每次调用懒解析，避免插件加载顺序导致 admin 服务未挂载；创建失败返回 `SKILL_ADMIN_SESSION_FAILED`/`SKILL_ADMIN_PRESET_MISSING` 并展示具体原因
- **技能管理员预设修复**：补齐 `tool-fs-search` 的 `sampleOverCapGlobResults` 必填配置，避免 preset broken；其他插件配置做审计
- **技能库全员可用**：catalog/get 允许同项目在册成员查看自己的技能，worker 可修改自己的选择，supervisor 可查看/修改任意成员；add/remove/install-url 仍仅 supervisor
- **每对话技能页**：会话内新增技能页签，成员可查看/选择本会话技能；不再依赖会话头部入口
- **移除头部技能 chip**：删除会话 header 的技能数量/chip，入口统一到每对话技能页
- **移除重复右键技能菜单**：删除技能行上重复的右键菜单项，保留主管成员菜单
- **SkillHub 格式适配**：支持 `@scope/<pack>/` 两层目录与无 `manifest.json` 的 `SKILL.md` frontmatter 合成（id/name/description/roles/tokenEstimate/source/license），scope 限定 id 避免 slug 冲突
- **技能来源/署名**：manifest 支持 `author`/https `homepage`，catalog/preview 展示；URL 安装、来源入口、预设页底部致谢
- **主管任务卡**：派单默认折叠、区分配色；`【Cadre 任务】` 改为 `【主管任务】`，字段不变、旧前缀兼容
- **Cadre 团队模式**：`cadre` 预设聚焦 shell/read/write/grep/测试/打包/台账，persona 带派单四项、证据、基线、actor-target、环境与 release preflight；`cadre-team` 内置技能
- **P0/兼容**：打包始终重建 CJS、schema 2→3 幂等迁移、技能库分层、URL 安装大小/超时限制

### 已知限制

- 技能管理员会话绑定保存在内存，应用重启后旧会话需重新绑定
- 技能市场（ClawHub/SkillHub）未接；浏览器/截图工具未内置
- `cadre-team` 内置技能默认不自动选中，需在技能库选择
- 安装包未签名（SmartScreen 提示）；429/外部依赖仅有界重试

## 1.1.1

- **真实库 schema 2→3 修复**：打包始终从当前源码重建 CJS，启动 `initCadreStore` 幂等补齐 `members.skills_json`；旧 schema 下技能 catalog/get 降级为空、set 返回可读 `SKILL_SCHEMA_OUTDATED`
- **技能库与员工选择分层**：`~/.dsh/cadre-skills/<pack>/manifest.json + SKILL.md`；技能入口统一为「技能」；主管在员工菜单/建员工时选择技能，只对选中会话注册，默认不加载；角色不匹配拒绝；改选/内容变化 dispose 旧注册；`members.skills_json` additive（schema v3，默认 `[]`）
- **技能 IPC**：`/cadre/skills/{catalog,get,set,preview,add,remove,install-url}`，supervisor-only、项目/成员/角色校验、数组去重，只更新 `skills_json`
- **技能库分层**：内置技能（随包 `builtin-skills/`，只读）与手动安装（`~/.dsh/cadre-skills`）区分 `origin`；manifest 支持 `descriptionI18n{zh,en}`；新增 `cadre-team`/`cadre-workflow` 内置技能；公开 GitHub URL 安装（HTTPS/大小/超时限制）
- **Cadre 团队模式预设**：新增 `cadre`（Cadre 团队模式），基于标准工具集但聚焦 shell/read/write/grep/测试/打包/台账，去掉无关 `tool-web`；persona 带派单四项、证据规范、单一基线、actor-target、环境与 release preflight；`source: cadre`，上游 standard/ptc/minimal/cordis 不变
- **归属致谢**：preset source 元数据区分 `deepseek`/`cadre`，UI 可标注；内置技能注明来源
- **技能署名/主页链接**：manifest 支持可选 `author` 与 https `homepage`，catalog/preview 返回并在技能库展示；`ai-design` 标注 Elaya 及上游仓库，Cadre 内置技能标注 Cadre
- **来源入口**：技能库/预设页提供上游仓库/主页链接与底部致谢
- **预设页归属修正**：底部致谢区、Cadre 预设归入内置分组并去除多余来源徽标
- **主管任务卡**：派单消息默认折叠为任务卡，主管/员工任务使用区分配色与标题；正文与交付要求可展开
- **派单文案**：`【Cadre 任务】` 改为 `【主管任务】`，任务号/标题/截止/交付要求字段不变；历史卡片兼容旧前缀
- **手动添加/删除技能**：`/cadre/skills/add` 接收 manifest + SKILL.md 正文，kebab-case/角色/路径校验，默认不覆盖，`overwrite:true` 才替换；`/cadre/skills/remove` 需 confirm；原子目录写入
- **工具结果 4k 落盘**：Cadre `spill-policy.maxInlineTokens` 12.5k → 4000，超出保留头尾并写 spill 文件路径，tool call/result 配对不变
- **Token 治理**：compaction 保留尾部 50k（阈值 150k 不变）；step 级压缩 `stepPressureCheck` 默认 **true**（100k 阈值、2 个 tool 起检）；压缩发生时会增加一次摘要 LLM 调用
- **响应式**：台账与邮件设置弹窗适配窄窗口/侧栏宽度
- **邮件通知**：会话级 SendGrid、主管设置页/测试发送、失败不阻断
- **台账分页**：台账每页 20 行、页码窗口/上下页，筛选与搜索重置第 1 页
- 包含 1.0.0 全部修复

### 已知限制

- 技能市场（ClawHub/SkillHub）未接；浏览器/截图工具未内置
- `cadre-team` 内置技能默认不自动选中，需在技能库选择
- 删除技能包不会清理 `members.skills_json` 中的旧选择
- 安装包未签名（SmartScreen 提示）
- 429/外部依赖仅做有界重试并告知；step 级压缩已默认开，峰值未做真实长会话 A/B

## 1.1.0

- **会话级邮件通知**：每个 Cadre 项目独立配置启停、发件人、收件人、`apiKeyEnv`、dry-run、最小发送间隔；配置存 `~/.dsh/cadre-email/<projectId>.json`，密钥只引用环境变量名，不写入仓库/日志
- **SendGrid HTTPS**：仅使用 SendGrid v3 `POST /v3/mail/send`，不依赖本机 SMTP；密钥缺失/鉴权失败/HTTP/网络异常均返回结构化错误并 redact
- **触发**：任务进入 delivered/verified 时发项目汇总；显式/自动升级（`【需要您决定】`）发 escalation；dedupe + 项目级限流，失败不阻断任务与停摆主流程
- **主管设置页**：侧栏主管邮件通知设置，支持启停/收件人/发件人/环境变量名、测试发送、dry-run；IPC 只返回 `hasKey`，不回传密钥值
- **邮件设置帮助**：设置页补充 SendGrid 注册/API Key/发件人认证入口，并标注邮件备案/合规要求
- **首开缺配置不报错**：项目尚无配置文件时 `get` 返回 `configured:false` 的禁用默认值，首次保存自动创建目录/文件；非法 JSON 仍给出可读错误且不含文件路径
- **响应式修复**：台账与邮件设置弹窗适配窄窗口/侧栏宽度，避免横向溢出与按钮遮挡
- **Token 治理**：Cadre compaction 保留尾部固定 50k（阈值 150k 不变），降低长 turn 每次请求的 cache-read 上下文
- 移除无用的「编辑资料」菜单
- 包含 1.0.0 全部修复：强锁/Skill、三态/视图、内部化、台账分页、lastError/aborted、开源文档/CI

### 已知限制

- 未用真实 SendGrid API key/邮箱做端到端验证（单测注入 fetch）
- task-summary 依赖 watchdog 首次扫描建立 Episode；任务在首次扫描前已完成可能漏发
- 安装包未签名（SmartScreen 提示）
- 429/外部依赖仅做有界重试并告知，不自动改派修复任务

## 1.0.0

- **主管写文件强锁**：host-write-guard 在 `tools/pre-execute` 只拦 supervisor 写工具；只允许 workspace/`reports/` 下 `.md/.txt`，Office/shell 分别返回专用错误码；roots 按项目/会话/配置兜底，策略 JSON 热更新、fail-closed、审计；非写工具（派活/查台账/读文件）直接放行
- **主管 Skill**：host-supervisor-skill 以独立 SKILL.md 提供讨论/派活/验收/汇报方法，按花名册只注册到 supervisor 的 agent scope；pre-step 全分支 `next()`，不短路 waterfall
- **停摆三态与视图**：additive turn 生命周期事件（含 aborted/无首 token 回注与 ignorable 降级）、model_generation/tool_execution/no_events 投影、compaction 暂停、`elapsedMs/heartbeatAt/firstTokenAt/tokensSoFar/stallBasis/inferred` 字段；长单步 10 分钟才升级
- **通知内部化**：停摆/催办/恢复统一 `【主管内部】`，仅 `【需要您决定】` 对用户可见；侧栏内部事件开关
- **台账分页**：台账每页 20 行，底部页码窗口/上下页，筛选与搜索重置第 1 页，无匹配空状态
- **lastError 与失败回注**：停摆/任务视图暴露 `lastError{code,message,at}`，模型能力不匹配（thinking/400）等分类为可读错误；aborted 及未出首 token 的 error/blocked 在下一轮回注 `[系统通知]`
- **工程与开源边界**：公开版 UPSTREAM（第三方/ vendored 归属）、BUILD/CONTRIBUTING/SECURITY、CHANGELOG 与源码注释去除内部编号、Windows keyless CI（typecheck/gates/build:check/smoke/evidence）

### 已知限制

- 心跳为 watchdog 15 秒扫描节拍推导，不是独立定时采样
- `inferred` 旧日志投影无独立 spec
- 安装包未签名（SmartScreen 提示）
- 429/外部依赖仅做有界重试并告知，不自动改派修复任务

## 0.10.9（1.0.0 前 RC：移除对话区状态条）

- **删除用户可见状态条**：移除 CadreStallCard 在对话输入区/标题栏的状态条注册与渲染，普通对话不再出现停摆/执行状态条
- **保留侧栏与台账**：项目侧栏的员工状态、台账停摆列与 `【主管内部】` 通知继续保留；内部停摆诊断不受影响
- 0.10.9 包含 0.10.8 状态条内联、0.10.7 台账分页与 0.10.6 全部修复

### 已知限制

- 心跳为 watchdog 扫描节拍，不是独立 30 秒采样；`tokensSoFar` 依赖 usage
- aborted 回注不覆盖 error/blocked
- 早期版本未结构化暴露 lastError（1.0.0 已补）
- 通知前缀为文本协议；内部事件开关未按会话持久化
- 强锁只覆盖已登记写工具
- 旧 0.10.0 仍无法读取 0.10.1+ 新事件日志
- 版本策略：0.10.9 为 RC；0.10.10 直接发布 **1.0.0**

## 0.10.8（0.10.7 + 状态条内联 chip）

- **底部状态条内联**：侧栏底部状态改为按内容宽度内联的 chip，贴合输入区，不再整行铺满；长生成进度/模型信息仍单行显示
- 0.10.8 包含 0.10.7 的台账分页（每页 20、底部页码窗口、筛选重置、空状态）与 0.10.6 全部修复（强锁、pre-step、terminal reason、内部化/三态）

### 已知限制

- 心跳为 watchdog 扫描节拍，不是独立 30 秒采样；`tokensSoFar` 依赖 usage
- aborted 回注不覆盖 error/blocked
- 早期版本未结构化暴露 lastError（1.0.0 已补）
- 通知前缀为文本协议；内部事件开关未按会话持久化
- 强锁只覆盖已登记写工具
- 旧 0.10.0 仍无法读取 0.10.1+ 新事件日志
- 版本策略：0.10.7 不单独发布；0.10.8 验收后发；0.10.9 收口；0.10.10 直接发 1.0.0

## 0.10.7（0.10.6 + 台账分页）

- **台账分页**：项目台账每页 20 行，底部显示总条数/当前页并给出页码窗口（`1 … 4 5 6 … 10`）、上一页/下一页；搜索与筛选变化自动回到第 1 页
- **空状态**：有台账但筛选/搜索无匹配时显示「没有匹配的任务；换一个筛选或关键词。」
- 0.10.7 包含 0.10.6 全部修复（强锁工具分类/roots、pre-step 不短路、terminal reason 读写、底部单行状态、内部化/三态）

### 已知限制

- 心跳为 watchdog 扫描节拍，不是独立 30 秒采样；`tokensSoFar` 依赖 usage
- aborted 回注不覆盖 error/blocked
- 早期版本未结构化暴露 lastError（1.0.0 已补）
- 通知前缀为文本协议；内部事件开关未按会话持久化
- 强锁只覆盖已登记写工具
- 旧 0.10.0 仍无法读取 0.10.1+ 新事件日志
- 版本策略备忘：0.10.9 之后直接发 1.0.0，不单独发 0.10.10

## 0.10.6（合并发布：强锁、pre-step、terminal reason 与单行状态）

- **强锁工具分类/roots**：host-write-guard 先分类再查策略；`dispatch_task/list_tasks/transition_task/read/grep` 等非写工具直接放行；shell/office 分别返回 `WRITE_SHELL_DENIED`/`WRITE_OFFICE_DENIED`；roots 按 `projects.root_path → 会话 cwd → workspaceRoot → reportsDir` 兜底，workspace 下 `.md/.txt` 允许、`.ts` 拒绝
- **pre-step 不短路**：supervisor Skill 的 `agent/pre-step` 监听器改为 `(payload, next)`，所有分支 `return next()`；不再让 agent loop 读 `decision.kind` 抛 undefined
- **terminal reason 读写修复**：写侧 turn 退出统一落结构化 reason（缺失 fallback error/UNKNOWN）；读侧 Session 加载/回放对历史 `turn/end` 缺 reason 做内存归一化，不重写日志；goal/ACP/session-query/subagent/telemetry/workflow/chat 消费点加守卫
- **底部单行状态**：侧栏底部状态收敛为单行，长生成进度不再撑高面板
- **内部化/三态**：停摆/催办/恢复通知默认 `【主管内部】`，仅升级 `【需要您决定】` 可见；停摆视图暴露 elapsed/heartbeat/firstToken/tokens/stallBasis/inferred 三态字段

### 已知限制

- 心跳为 watchdog 扫描节拍，不是独立 30 秒定时采样；`tokensSoFar` 依赖 usage
- aborted 回注不覆盖 error/blocked
- 早期版本未结构化暴露 lastError（1.0.0 已补）
- 通知前缀为文本协议，普通消息同前缀会被一并隐藏；「显示内部事件」开关未按会话持久化
- 强锁只覆盖已登记写工具；未登记的新写工具需补策略
- 历史日志不会被重写；旧 0.10.0 仍无法读取 0.10.1+ 写入的新事件

## 0.10.5（强锁工具分类热修）

- **强锁只拦写工具**：host-write-guard 先分类再查策略/roots；`dispatch_task`、`list_tasks`、`transition_task`、`read`、`grep` 等直接放行，不会因项目未登记/策略缺失被 fail-closed
- **shell/office 优先拒绝**：`bash/pwsh` 返回 `WRITE_SHELL_DENIED`，`office_*/docx_*/xlsx_*/pptx_*` 返回 `WRITE_OFFICE_DENIED`，不再报 `WRITE_POLICY_UNAVAILABLE`
- **roots 兜底**：`projects.root_path` → 会话 header cwd → 配置 `workspaceRoot` → 绝对 `reportsDir`；全部缺失才 `WRITE_POLICY_UNAVAILABLE`
- 主管在 workspace 下 `.md/.txt` 允许、`.ts` 拒绝；普通会话不受影响

## 0.10.4（pre-step 短路热修）

- **修复 supervisor Skill 短路 `agent/pre-step`**：监听器改为 `(payload, next)`，无 agent、非主管、已注册、注册失败等所有分支都 `return next()`；此前返回 undefined 会让 agent loop 读 `decision.kind` 抛 `Cannot read properties of undefined (reading 'kind')`，普通会话新开一轮也必失败
- **Cadre pre-step 审计**：host-collab 既有监听器所有分支返回 next；host-governance/host-write-guard 不注册该事件；新增 Skill「不短路 waterfall」回归
- 0.10.4 unsigned 包可覆盖 0.10.3/0.10.0-hotfix.2，不要求新建主管或团队

## 0.10.3（terminal reason 兼容性热修）

- **写侧兜底**：agent-loop 所有 turn 退出路径统一落结构化 `turn/end.reason`；没有终止原因时写 `error/UNKNOWN`，不再产生 `reason: undefined`
- **读侧归一化**：会话加载/回放遇到历史 `turn/end` 缺 reason 时在内存归一化为 `error/UNKNOWN`，不重写日志；goal-round-driver、ACP codec、session-query、subagent、telemetry、workflow、chat/trajectory 等所有 `reason.kind` 消费点加守卫
- **降级兼容**：`turn/received` 等 additive 生命周期事件标记 `ignorable`，旧版本读取新会话不再整条拒绝
- 覆盖 hotfix.2 用户的 terminal reason 复发；不需要新建主管或团队

## 0.10.1（主管强锁、Skill 与停摆三态）

- **主管写文件强锁**：新增 host-write-guard，在 `tools/pre-execute` 只拦在册 supervisor——只允许项目工作区与 `reports/` 下的 `.md/.txt`，Office 与 bash/pwsh 显式拒绝，路径经 realpath 归一，策略 JSON 可热更新，失败一律 fail-closed 并写审计行；worker 与普通会话不受影响
- **主管 Skill**：新增 host-supervisor-skill，把「讨论 vs 派任务、明确指令才执行、澄清六步、偏好与边界、汇报聚合、精致汇报派员工、只读诊断」写成独立 SKILL.md，按花名册只注册到 supervisor 的 agent scope，worker 不可见；row config 可关闭，工具掩码仍优先
- **停摆三态与 turn 生命周期**：新增 additive Session 事件 `turn/received`、`model_call/started`、`model_call/first_token`、`turn/completed`、`turn/aborted`（含 `hadFirstToken`）；中止（含从未出首 token）在下一轮回注员工；watchdog 区分 model_generation / tool_execution / no_events，长单步生成 3–7 分钟不再误报，单步超 10 分钟才升级，no_events 维持 3/10 分钟；compaction 窗口暂停判定
- **停摆视图字段**：StallTaskView 暴露 `elapsedMs/heartbeatAt/firstTokenAt/tokensSoFar/stallBasis/inferred`，旧会话字段为 null 且 `inferred:true`，不伪造心跳；nudge 带机器可读 stallBasis
- **通知内部化**：possibly_stalled/stalled/recovered 统一加 `【主管内部】` 前缀（模型可见、UI 隐藏），只有 `【需要您决定】` 的升级文案对用户可见；员工 nudge 文本不变
- **M4**：修正 waiting_question 历史 ask 误判——停摆判定窗口收敛到当前任务下发/返工时间，旧会话的未答问题不再冻结新任务

### 已知限制

- **心跳为扫描节拍推导**：`heartbeatAt` 来自 watchdog 扫描确认活动的时间，不是独立 30 秒定时采样；流式过程中的 `tokensSoFar` 依赖 usage，可能为 null
- **aborted 回注不覆盖 error/blocked**：只有 `aborted` 且带中断原因时向员工回注，模型错误与 pre-step 拒绝仍按原路径处理
- **早期 lastError 展示简化**：0.10.x 停摆视图未消费任务 `lastError`；1.0.0 已补结构化字段
- **前缀碰撞/开关未按会话挂载**：`【主管内部】`/`【需要您决定】` 为文本前缀协议，普通消息若以相同前缀开头会被同样处理；「显示内部事件」开关是客户端状态，尚未按会话持久化
- **强锁只覆盖已登记写工具**：未登记的新写工具默认不拦，需在策略中补登记；supervisor 的 shell 整工具拒绝，worker shell 不受本锁约束

## 0.10.0（员工请示路由与停摆治理）

- **员工会请示了**：员工遇到拿不准的事向主管提问，问题先经 host-collab 路由（每员工待答上限、30 分钟无答复自动升级，均可配置），主管答复后原路回流员工会话；不再靠员工自己抄送；角色工具掩码修正为 deny 式——worker 隐藏派活/花名册/状态迁移三件（`ask_user_question` 保留），supervisor 隐藏汇报与全部执行工具（`resolve_employee_question` 保留），未来新增工具不再误留给员工
- **任务停摆治理**：host-governance 停摆检测按最后活动判 normal/possibly_stalled/stalled/waiting_question，goal 自动续跑；主管侧可催办、重派（reassign：open 任务原状态改派在册员工，逐事件留幂等键）、取消、升级——前端停摆卡按 episodeId 原位更新，stale 时禁用动作；停摆视图 version 口径改为直接取任务行版本，与台账并发写同源，消除重派/取消的版本冲突误报；waiting_question 判定窗口收敛进 activity 模块，最后活动取数与归一化可测且边界全覆盖
- **汇报幂等键修复**：rework 后再次汇报不再重放上一轮 delivered 的幂等键（键按起始状态收窄），二次汇报不再被静默吞掉；rework 二次汇报按周期键落库，跨周期键不冲突，轮次中途重试亦不复用键
- **会话压缩不再滚雪球**：compaction 新增绝对阈值 `thresholdTokens`（Cadre 默认 150k），有效阈值取窗口比例/预留/绝对值的最小值；摘要强制输出 Status、Commands and Exit Codes、Failing Tests、Contract Decisions、Unverified、Evidence 并保留 file:line/exit code/失败用例/spill 引用——压缩后证据仍可寻址
- **打包缺件门禁**：打包链强制重建两个 cadre CJS 并在 asar 组装后校验在档，干净检出不再可能打出台账不可用的包（0.9.3 P0 的流程性根治）

### 已知限制

- **无 pixel 级 Electron 验收**：停摆 UI 的实机截图验收未做（打包内建 smoke 已过，视觉对照留待装机验收）
- **前端决策卡未接**：升级（escalate）动作仅路由上报，前端决策卡未实现
- **compaction 摘要未经真实 LLM 审计**：结构化摘要字段以确定性模板产出，尚未用真实模型会话审计其质量

## 0.9.3（员工管理闭环：职责可见、返工通知、离职处置）

- **主管能看到员工的职责与模型**：`list_employees` 返回角色明细（sessionId、姓名、状态、职责描述、模板、偏好模型），派活前先看清谁在做什么、用什么模型
- **打回返工闭环补上**：任务被打回 rework 时，员工会话立即收到一条含打回原因的通知，不用再等主管口头转达；通知失败不回滚状态，只在结果里标注 `notifyError` 供追问
- **员工离职必须先处置未结任务**：有未结任务时直接离职会被拒绝并给出选择——`cancel`（未结任务全部取消，原因 assignee-retired）或 `return`（任务原状态退回在岗主管，逐任务留痕）；`transfer` 本版未实现（0.10.0）
- **离职员工看得见、找得回**：花名册 departed 行显示「已离职/历史归属」徽标，会话与台账保留不删
- **花名册读失败不再伪装成空团队**：loading/空/读失败三态分开，失败可重试
- **台账超期一眼可见**：任务行按截止时间判定超期并高亮「已超期」；派活卡按 projectId 回查台账状态，通道失败显示「状态未同步」而不是静默
- **构建防陈旧门禁**（K39）：`lib/*.cjs` 漏建/过期时 gates 首位即失败（cadre-build gate + 双态自证）；`pretest`/`predev`/`pregates:evidence` 自动重建；release dry-run 预演同一时序

### 已知限制

- **transfer（任务转交他人）未实现**：离职处置只有 cancel/return，转交留给 0.10.0
- **主管离职只能取消**：项目只剩一名主管时，其未结任务无法 return（无人可接），只能取消
- **return 语义**：任务状态不变、仅把负责席位移交在岗主管，逐任务留 `task_events`（`from_status = to_status`，原因 assignee-retired）；已验收/已搁置等终态任务不参与

## 0.9.2（创建主管可选模型）

- **新建主管也能选模型**：服务商 / 模型 / 思考强度选择器与创建员工时一致；选中后写入主管会话的模型选择，不选则用官方默认模型，不影响创建
- 主管仍是单例：已有主管的项目部照旧要求先让其离职，模型选择不改变这条约束
- 本次发布用于验证 0.9.1 的检查更新提示：安装后启动只会在侧栏显示「有新版本」，**不会自动跳转或强制升级**

## 0.9.1（新增功能：检查更新）

> 版本口径：这是一次**新功能发布**（SemVer 语义上属 minor），不是 bug 修复。0.x 阶段按 patch 位出包，便于用户尽快试用；下一个正式 minor 节点再恢复常规节奏。

- **侧栏提示新版本**：启动检查一次 GitHub Releases，之后每 24 小时一次；有新版时侧栏底部显示「有新版本 x.y.z · 查看」，点击打开 GitHub Releases 页面。不自动下载、不自动安装、不弹阻塞对话框
- **设置新增「检查更新」开关**（默认开启）：关闭后不再发起任何网络请求；偏好保存在 `userData/desktop/settings.json`
- **容错**：网络失败、超时（5 秒）、被墙、403 限流、响应畸形全部静默忽略，不报错不打扰；下次定时重试
- **升级后首次启动提示**：检测到版本变化且台账仍有花名册数据时，提示一次「团队数据还在，界面设置重置了」，避免用户误以为 0.9.0 的 userData 迁移丢了团队数据；只提示一次
- **安全取值**：只读取 GitHub API 的 `tag_name` 做版本比较，跳转地址固定为 `https://github.com/KyuuKyuuStone/cadre-heihei/releases/latest`，**忽略接口返回的 `html_url`**，避免上游响应被篡改或意外指向任意下载页

## 0.9.0（破坏性变更：与官方版共存）

- **应用包名改为 `cadre-heihei-desktop`**：此前与官方 DeepSeek Harness 同名，导致两应用共用 userData、互相抢单实例锁——运行我们的官方就打不开（反之亦然），且无任何提示。改名后 userData 迁到 `%APPDATA%\cadre-heihei-desktop`，与官方版可同机共存
- **桌面偏好重置**（破坏性）：`desktop/settings.json` 与 `keybindings.json` 留在旧目录不迁移，主题/快捷键需重新设置
- **登录凭据需重新输入**（破坏性）：官方 userData 里的登录态不再共享，首次启动需在应用内重新登录
- **团队数据不受影响**：花名册/台账/sessions 在 `~/.dsh`，与 userData 无关，升级零迁移
- `dsh://` 协议注册仍与官方共用（后装者覆盖），下版处理

## 0.8.7（重装丢团队数据修复）

- **卸载不再删除用户数据**：保留 `%APPDATA%` userData（含 `cadre.sqlite`、`desktop/settings.json`），重装不丢花名册/台账
- **台账默认迁到 `~/.dsh/cadre.sqlite`**：与 sessions 同域，卸载器保证不碰；旧 userData 库首次启动自动迁移（一致性快照 + 完整性校验 + 旧库保留 + 新库优先，绝不覆盖）
- **丢失不再静默**：检测到曾经有花名册、当前库却被重建时，会话行显示「团队数据丢失」，提示恢复而不是伪装成普通会话
- 修正发布 README「卸载保留 userData」与卸载器实际行为相反的文案
- **安装界面印章 logo**：三页（欢迎/解压/完成）中央图从纯文字改为「家印笑脸印章 + Cadre Heihei」组合；移除自绘框架下永不生效的 installerHeader 死配置

## 0.8.6（三个架构修复）

- **主管能看见台账了**：新增 list_tasks（任务状态/负责人/进展）、transition_task（验收/打回/搁置），主管终于能走完「派活→看进度→验收」
- **验收审计可信**：actor 不再来自环境变量（能伪造），改从花名册解析；汇报状态逐跳迁移，每步留记录
- **权限限制 fail-closed**：规则解析失败时禁用工具并告警，不再静默放行
- **desktop 切断对主仓 app/src 的 import 依赖**（副本自持，不再跨仓引用）

## 0.8.5（品牌清理 + 插件精简 + 启动修复）

- 品牌全面清理：鱼尾动画→Cadre 印章、「深度求索中」→「Cadre 思考中」、窗口标题「DSH 本地构建」→「Cadre 本地构建」、插件页「重启 Cadre」
- 移除官方插件：DeepSeek 账号登录、品牌展示、使用统计（Cadre 品牌改由侧栏自持）
- 界面：主管默认名「主管」、角色分色（主管绿/员工琥珀/普通灰）、状态行精简、移除左侧标识
- **修复启动失败**：删账号插件后 welcome 冷启动 404 导致打不开

## 0.8.4（主管终于像个主管了）

- 空白会话标题显示时间戳（「新会话 · 23:54」），避免与顶部按钮撞名、多条空白会话可区分

- 主管花名册**每轮重查**：新员工加入后同一会话立刻看到（之前只看首轮凭记忆）
- 离职修复：确认框从行菜单移到独立浮层，离职真正生效（无匹配返回 NOT_FOUND，不假成功）
- 员工提示词收成一行：`你的角色：后端——负责…`
- 主管缺角色时**主动问用户"要不要配一个"**，不自己补位
- 主管汇报改为**阶段性总结**：不逐条复述、只报风险和需决策
- 员工汇报**折叠成一行**，点开看全文、展开状态记忆
- 重复的「新会话」行已删

## 0.8.1（修复用户实测问题）

- 新建会话按钮恢复（之前被压扁成 26px）
- 派活/角色下拉菜单不再一移动鼠标就消失
- 会话行显示职位（主管 / 员工 · 后端），行高加宽，带状态点
- 建员工可选择服务商/模型（读官方模型目录，与官方「模型」页同源）
- 新建主管/员工后自动报到（系统在会话里发提示，让其确认职责）
- 移除官方实验功能 Agent Teams（插件页不再出现）

## 0.8.0（结构性改版·收口）

- 项目部 = 官方工作区（一个项目部一本账），`projectId` 全链路改为 workspaceId
- 侧栏会话列表即主界面，CadrePanel 管理面板已删除
- 项目部行 `＋`（主管/员工/普通会话三选一）+「台账」按钮
- 派活状态条：拆解中 / 已派给谁 / 已交付待审 / 部分成功可重试 / 拆解失败
- 待派队列 + 一键重试（不依赖模型重说）
- 角色 = 花名册描述动态注入；主管硬只读（工具层 deny）
- 防幽灵员工：派给不存在的员工进待派，不凭空造人
- 启动标语：如臂使指，一念百行

## 0.7.0（结构性改版）

- 一层「项目部」：原项目层删除，工作区即项目部
- 项目部 `+` / 侧栏「新会话」→ 主管 / 员工 / 普通会话 三选一
- 建主管只填名字；建员工走角色模板（软件 9 / 小说 6 / 通用 5），自动填职责，可选服务商/模型/思考强度
- 删除手动派活弹窗，改为主管会话内派活状态条（拆解中 / 已派给谁 / 已交付待审 / 部分成功可重试 / 拆解失败）
- 待派队列：派活失败自动落库，一键重试
- 角色 = 花名册描述动态注入（不再使用官方 preset 注册）
- 主管硬只读（只能读文件与状态，不能写/执行改文件命令）
- 设置删除「模型 Providers」，模型配置统一走官方模型页
- 启动标语：如臂使指，一念百行

## 0.6.0

- 主管派活工具与员工汇报（6 个 MCP 协作工具接入：派活/汇报/查任务/验收/花名册）
- 两级验收：主管先审 → 用户过目；验收面板与汇报卡
- 按角色限制工具可见性（supervisor/worker 权限矩阵）
- 两层侧栏与项目级创建入口（工作区 → 项目 → 花名册；项目行「＋」三步创建）
- 项目绑定真实文件夹（W8）：员工在项目文件夹下工作
- 汇报卡视觉（W3）：交付物、状态、时间线完整呈现

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

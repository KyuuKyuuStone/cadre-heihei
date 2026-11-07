# package-doctor

Cadre Heihei 桌面端「新机器源码打包」预检工具。零依赖、单文件、只读：不修改仓库、
缓存或本地 dotenv 文件；不回显任何敏感值——dotenv 只打印键名，代理地址只打印
`scheme://host[:port]`（URL 里的用户名/密码一律遮蔽）。

## 用法

```powershell
cd <desktop 工作区根>                           # 即包含 apps/desktop 的那一层
node ..\tools\package-doctor\doctor.mjs         # 仓库默认取当前工作目录
node ..\tools\package-doctor\doctor.mjs --repo D:\build\cadre-heihei\desktop
node ..\tools\package-doctor\doctor.mjs --help
```

仓库定位：默认取 `process.cwd()`，要求其下同时存在 `package.json` 与
`apps/desktop/package.json`；`--repo <路径>` 可显式指定。参数只接受
`--repo <路径>`、`--help` 与 `-h`；定位失败、`--repo` 缺值、重复或值以 `-`
开头、出现未知参数时，打印用法并以退出码 64 结束（`--help` 退出码为 0）。

要求：Node 18.15+（本仓库 engines 要求 ^22.19.0 || >=24.0.0）；Windows/macOS/Linux 均可运行，
平台相关项按 `process.platform` 自动选择（win32 检查 `.env.windows`，darwin 检查 `.env.macos`）。

## 检查项与输出

先跑仓库自己的配置权威 `pnpm --dir apps/desktop run check:package`
（即 `apps/desktop/package.json` 的 `scripts.check:package` = `tsx scripts/package-target.ts --check`），
把它归类为 PASS/FAIL；其余检查项是它不覆盖的新机坑：

| 检查 id | 内容 | PASS/WARN/FAIL 规则 |
| --- | --- | --- |
| `check:package` | 仓库自检（依赖齐全 + 打包配置可解析） | 退出 0 → PASS；非 0 → FAIL（附输出尾部） |
| `node` | `process.version` 对比 workspace 根 `engines.node` | 满足 → PASS；不满足 → FAIL |
| `pnpm` | `pnpm --version` 对比根 `packageManager` 钉住版本 | 一致 → PASS；偏差 → WARN（历史上偏差版本也能跑通） |
| `dotenv` | 本地 `.env.windows`/`.env.macos`（或预设 `presets/<preset>.env`）存在性、键白名单、策略自洽 | 文件缺失 → FAIL（指向 `.example` 模板或预设目录）；未知键 → FAIL；预设名与部署不一致 → FAIL；策略违规 → FAIL；test 部署缺 `DOWNLOAD_TEST_ORIGIN` 或 `DOWNLOAD_TEST_RELEASE_ID` → FAIL（附「照 `.env.<platform>.example` 抄哪两行」的指引）；`DOWNLOAD_TEST_RELEASE_ID`（或其环境覆盖 `PACKAGE_TEST_RELEASE_ID`，见 `desktop-package-environment.mjs:71-76`）不是 32 位小写十六进制 → FAIL；深判定仍归 `check:package` |
| `disk-repo` / `disk-temp` | 仓库盘与临时盘剩余空间 | ≥3GB PASS；1–3GB WARN；<1GB FAIL |
| `mirrors` | `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 与 electron 缓存体积 | 已设镜像 → PASS（附说明）；未设 → WARN |
| `proxy` | 代理 + `NO_PROXY` 回环绕过 | 未设代理 → PASS；设了代理且回环全绕过 → PASS；缺 localhost/127.0.0.1/::1 → FAIL。`NO_PROXY` 按逗号切分、trim、大小写归一后做精确主机匹配（含点后缀语义），单独识别 `*` 与 `<-loopback>`；子串包含不算绕过证据 |
| `paths` | 仓库路径 ASCII、长度 | ASCII 且 ≤120 字符 → PASS；否则 FAIL |
| `defender` | Defender 实时扫描（查询需权限，失败降级为 WARN） | 已关闭 → PASS；开启/未知 → WARN（附排除命令） |
| `git` | 工作树脏状态（仅 Git 仓库内） | 干净 → PASS；脏 → WARN（`dshBuildDirty` 会写进产物清单）；无 Git 仓库 → 不产出结果，交由 `source-commit` 分类 |
| `source-commit` | 无 Git 历史时的构建提交号回退（镜像 `readDesktopBuildCommit`：git → `CADRE_SOURCE_COMMIT` → `unknown`） | Git 可读 HEAD → PASS（附提交号）；无 Git 历史且 `CADRE_SOURCE_COMMIT` 未设 → WARN（unsigned/test 以 `unknown` 继续但客户端构建仍需真实提交号，release 失败）；`CADRE_SOURCE_COMMIT` 非 40 位十六进制 → FAIL；git 其他失败（如未安装）→ FAIL |

## 退出码

- `0` — 全部 PASS。
- `1` — 有 WARN、无 FAIL（可以打包，但有注意事项）。
- `2` — 有 FAIL（先修 FAIL 项再打包）。
- `64` — 调用无效：参数错误或所选目录不是 desktop 工作区根。

## 关键机制说明

- **镜像与缓存耦合**：`@electron/get` 的缓存键是下载目录 URL 的 sha256，改 `ELECTRON_MIRROR`
  会让整份缓存失效、全部重新下载，症状是「卡十几分钟然后超时」。镜像一旦选定就不要再换。
- **代理回环绕过**：打包机通常要代理才能下载，但 127.0.0.1/localhost/::1 的回环流量必须直连。
  1.5.3 启动崩溃的机制是回环会话被推进代理；缺 `NO_PROXY` 绕过是诱因之一，未证实为该机的
  根因；1.5.3 已带降级防御：回环认证失败不再直接退出，而是保留欢迎页并提示
  `backend-unavailable`。不要把本检查项的 FAIL 直接当成那次事故的定论。
- **策略自洽**（镜像自 `desktop-policy-environment.mjs:4-39`）：origin 必须 https、不带凭据/路径/
  查询/片段；test 部署要求非空 `allowedAuthOrigins`；production 禁止设置 `allowedAuthOrigins`。
- **git 脏树**：构建会把 `dshBuildDirty`/`dshBuildCommit` 写进产物清单，发布前必须干净。
- **无 Git 历史的源码树**：`source-commit` 检查按 `readDesktopBuildCommit` 的回退顺序分类；
  unsigned/test 构建以 `unknown` 提交号继续（打包时附 WARN），release（签名）构建要求真实
  提交号——Git 仓库或 `CADRE_SOURCE_COMMIT`；真实提交号还会经 `DSH_CLIENT_COMMIT_HASH`
  交给客户端构建（该构建无 Git 时自身无法解析提交号）。该检查的正则与回退顺序须与
  `apps/desktop/scripts/desktop-build-commit.mjs` 保持同步。
- **键白名单是双维护镜像**：本工具的 `SHARED_SETTING`/`WINDOWS_SETTING`/`MACOS_SETTING`/
  `PRESET_SETTING`/`PUBLIC_PLATFORM_SETTING` 正则镜像
  `apps/desktop/scripts/desktop-package-environment.mjs` 的键白名单（:17-21 共享与平台键、
  :58-60 预设键）。两份名单人工保持同步，**以仓内 `desktop-package-environment.mjs` 为准**；
  那份变更时必须同步这里的正则。

## 扩展

新增检查项：在 `doctor.mjs` 里加一个 `checkXxx` 函数并在 main 段调用，用
`record(id, status, detail, fix)` 记录结果即可；`fix` 参数写可直接粘贴的修复命令。

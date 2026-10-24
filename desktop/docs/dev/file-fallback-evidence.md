# 0.6.0 装机 file:// 现象取证报告

> 结论先行：**file:// 是加载暂态，不是 fallback 终态**。0.6.0 装机 UI 终态为
> `dsh-app://app/`（title="Cadre Heihei"），与 0.5.2 形态一致；协作面板/花名册/台账
> 完整呈现。s61 汇报中的「file:// fallback」是**取证时机过早**（启动后 ~40 秒内抓取）。
> 所有证据取自安装态 `%LOCALAPPDATA%/Programs/Cadre Heihei/`，env 指向模拟旧
> profile（sim-userdata + sim-dsh/profiles）。

## 1. Host 日志（host-stdout.log，stdout 分管道抓取）

```
cadre-ledger roster project=proj-demo size=1
cadre-ledger open path=...\sim-userdata\cadre.sqlite mode=readwrite actor=sup-1/supervisor
cadre-ledger open path=...\cadre.sqlite readOnly=true tables=10
cadre-ledger default-project=proj-demo
cadre-providers open path=...\cadre.sqlite rows=0
cadre-employees open path=...\cadre.sqlite project=proj-demo rows=0
dsh web: http://127.0.0.1:62958/?token=G1z5YbP-_hVcy9sLu34xxuKcEipf5d1flsBJBbjH-54
cadre-providers sync routes=0 managed=0
desktop tray: theme=light icon=...\resources\tray-light.ico
desktop tray: theme=dark  icon=...\resources\tray.ico
cadre:listEmployees project=proj-demo count=0
```

- **Host ready 行存在**（`dsh web: http://127.0.0.1:62958/...`），端口随机、无占用冲突。
- **stderr 只有 `DevTools listening on ws://...:9338/...`**，无任何 Host 错误——
  `host-process.ts:204` 的缓冲拼接在本次没有内容可拼（无异常），**无需为取证改落盘**。
- **`profile bundles +=` 为 0 行**：不是缺失——sim profile 已在 0.5.2 验证时被
  `applyRelease` 补齐（s59 实证 `desktop project: profile bundles += @deepseek-ai/dsh-bundle-cadre`），
  0.6.0 幂等跳过。**判据需改为「profile 内含该 bundle」而非「打印 += 行」**。

## 2. UI 终态（CDP，启动后 ~2 分钟抓取）

- `/json`：`[{title:"Cadre Heihei", url:"dsh-app://app/"}]` ——**非 file://**。
- DOM：`协作 ✓ 默认工作区 ✓`；点开协作面板后（verify-5-collab-panel.png）：
  `台账 · 项目 proj-demo`、`花名册 1 人`、`主管 sup-1 · 调度（只读，不执行）/ 空闲 / 6 小时前`、
  `新建主管`、`本项目已有主管（sup-1），每项目最多一个`、`暂无任务`。
- s61 抓到的 `file:///C:/Users/xuxua/AppData`（verify-0-ui.png）为 **dsh-app ready 前的
  暂态页**；窗口 URL 终态已切 `dsh-app://`。

## 3. host-collab 装机产物检查

| 位置 | 结果 |
|---|---|
| asar 文本 `dsh-host-collab` | **命中 20 处**（已进 asar） |
| `app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-host-collab` | 不存在（同 bundle-cadre：asar 内形态，未触发 unpack，正常） |
| `packed/dsh/deepseek-ai-dsh-host-collab-0.6.0.tgz` | **存在**（去 private 修复生效，进 pack public 成员） |

## 4. 与 dev 启动的对比

| 维度 | 安装态（本次取证） | dev（`run start`） |
|---|---|---|
| dsh web | ✅ :62958 | ⚠️ 无法对比——dev 环境 primary-runtime python venv 残缺（s60），`run start` 卡 ensurepip |
| Host stderr | 空（无错误） | 未取得 |
| file:// 暂态 | 有（ready 前数秒） | 未取得 |

> dev 对比**缺失**：dev 环境待 primary-runtime 修复（见 playbook「primary-runtime 残缺自检
> 与恢复」与 s60 汇报的「单跑静默退出」问题）。修复后建议补一次同口径抓取。

## 5. 初步判断

1. **不存在 file:// fallback 缺陷**：dsh-app 终态正常，Host ready 正常，host-collab 进包正常。
   s61 的 file:// 判定是**截图/CDP 抓取时机**（<40s）早于 dsh-app 切换所致。
2. **`profile bundles +=` 判据不可靠**：幂等场景下不打印；应检查 profile 内容本身
   （`$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`）。
3. **真正的待验证项**（0.6.0 新能力）：W8 项目绑定文件夹的「＋」三步创建交互
   （面板级未见「绑定」文案，需走项目行「＋」流程人工点验）；W3 汇报卡在有任务后
   的完整形态（当前台账为空，只验证了空态）。
4. **安装目录名为 `%LOCALAPPDATA%/Programs/Cadre Heihei/`**（productName 大写形态），
   与 0.5.1 的 `cadre-heihei`（小写连字符）不同——**老用户升级会产生并存目录**，
   与 §5 Q5 身份清零清单相关，建议登记。

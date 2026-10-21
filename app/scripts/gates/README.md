# A 档四门禁

从 cc-heihei v1.7.9（`8ab1c24`）只读迁移，路径与 import 已适配 `app/` 结构；
旧 baseline 一律未沿用，按空仓重新生成。

| 门禁 | 命令 | 判定 |
|---|---|---|
| file-size | `node scripts/gates/check-file-size.ts` | 新文件 >2500 行红；基线只许降；allowlist 过期红 |
| import-semantics | `node scripts/gates/check-import-semantics.ts` | L2/L3 形态不符红；§1.6 边界违规红；L1 需显式基线 |
| tsc-baseline | `node scripts/gates/check-tsc-baseline.ts` | 新增签名/计数超红；真空检查红 |
| smoke | `node scripts/gates/smoke.ts` | Node test runner + JUnit；**0 例红、skipped>0 红、fail>0 红** |

`acceptance-lib.ts` 是 smoke 门禁的 JUnit 解析/判定库，其单测在 `app/tests/acceptance-lib.test.ts`。

## §1.6 adapter 边界（W1-07）

`check-import-semantics.ts` 同时执行 R1-R3 与 adapter 方向检查，覆盖静态 import、
`export ... from`（含 `export type`）和动态 `import()`：

| 规则 | 判定 |
|---|---|
| R1 | 仅 `src/adapters/engine/harness/**` 可 import `@deepseek-ai/dsh-*` 或 `vendor/deepseek-harness` 源码路径 |
| R2 | `src/ports/**` 零 harness import、零 harness 类型 re-export |
| R3 | `src/collab|main|preload|renderer/**` 不得 import harness |
| ADAPTER-DIR | `src/ports/**`、`src/collab/**` 不得 import `src/adapters/**`（adapter 可 import 二者） |

相对路径会先解析再判断是否落入 `vendor/deepseek-harness` 或 `src/adapters`，因此
`../../../vendor/deepseek-harness/...` 与 `../adapters/...` 均可识别。

坏样本：`fixtures/import-boundaries/{ports-harness,collab-harness,renderer-harness,ports-to-adapters}.fixture`；
允许样本：`allowed-harness.fixture`（注入 `src/adapters/engine/harness/` 应保持绿）。

证据（按 `.gitignore` 为本地运行产物，不入库；报告引用路径）：
- `evidence/import-boundaries-{ports,collab,renderer,reverse}-red.txt`（exit=1，指名文件）
- 对应 `-green.txt`（exit=0）
- `evidence/import-boundaries-allowed.txt`（R1 允许路径，exit=0）

### §1.6.1 已知漏报面（待修，2026-10-21 审查 00979930）

当前 parser 只覆盖「静态 `import ... from` / `export ... from` / 动态 `import()`」，以下边界**尚未覆盖**；本单只登记，不改脚本：

| 边界 | 当前行为 | 风险 | 待修方向 |
|---|---|---|---|
| 无 `from` 的副作用 import（`import './x.ts'`） | parser 只匹配带 `from` 的形式 | 该文件不被解析，边界/R1-R3 可能漏判 | parser 增加 side-effect import 分支 |
| `require()` / `import x = require()` | 不解析 | CJS/import-equals 可绕过边界 | 增加 CJS 与 import-equals 解析 |
| `src/**/*.test.ts` 豁免 | `collect()` 按 `TEST_RE` 排除测试文件 | 测试文件可绕过边界，且豁免范围未显式声明 | 显式声明豁免规则，或对测试纳入边界扫描 |
| symlink | 目录 symlink 不递归；文件 symlink 按链接路径读取，真实路径不校验 | 目标目录/文件可能漏扫或归属误判 | 用 `realpath` 解析并显式处理链接目标 |

> 在修复前，涉及上述写法的改动必须人工核对；验证时用 `git ls-files` 与扫描计数对账，不把「0 命中」直接当作无违规。

## 空仓基线

| 文件 | 初始状态 |
|---|---|
| `file-size-baseline.json` | `files: {}`（`--generate` 从零生成） |
| `tsc-baseline.json` | `total: 0`, `signatures: {}`（`--update` 从零生成） |
| `file-size-allowlist.json` | `entries: []`；新增条目必须带 `reason` / `decisionRef` / `expiresInVersion` |

旧 `cc-heihei/scripts/tsc-baseline.json`（约 902KB）与旧 file-size baseline **未复制、未引用**。

## 两态证据（ADR-0011）

`node scripts/gates/two-state-evidence.ts` 对四门禁分别：

1. 注入 `fixtures/` 坏样本；
2. 断言门禁退出码非 0，原始输出写入 `evidence/<gate>-red.txt`；
3. 删除注入文件复原；
4. 断言门禁退出码 0，原始输出写入 `evidence/<gate>-green.txt`。

汇总：`evidence/two-state-summary.json`；四门禁顺序全量：`evidence/run-all.{json,txt}`；
smoke 的 JUnit：`evidence/smoke.junit.xml`。

### 留存口径（2026-10-21 裁决）

1. **产物不入库**：`app/scripts/gates/evidence/` 由 `.gitignore` 排除，保持本地运行产物；
2. 纯 clone 下 `evidence/` 不存在是**预期状态**。验证必须运行 `npm run gates:evidence` 重建，
   **不得只对该目录 grep**，再以「无命中」判定通过/失败（静默漏搜风险）；
3. 每次门禁/证据机制变更或发布前，在本节**追加一条归档记录**（入库文本）：
   日期、commit、命令、结果、产物路径、生成时间、`two-state-summary.json` 的 sha256；
4. 红/绿原文留在本地；需要复核时按命令重建，用 sha256 与归档记录比对。

**归档记录**

| 日期 | commit | 命令 | 结果 | 产物 / 生成时间 | sha256 |
|---|---|---|---|---|---|
| 2026-10-21 16:21 (+08:00) | `dfff143` | `npm run gates:evidence` | **8/8 符合预期**：file-size、import-semantics、tsc-baseline、smoke、import-boundaries-{ports,collab,renderer,reverse}；全部 red exit=1 / green exit=0 | `app/scripts/gates/evidence/two-state-summary.json`；capturedAt `2026-10-21T08:21:10.389Z` | `91647da1394a8b2bae3fa9b3e8453b0cc909e203868f2775fb0ba519f8dc7f41` |

> 同日同 commit 的 `run-all` 四门禁顺序执行 exit=0（`evidence/run-all.txt`，生成 16:26），
> 扫描 37 文件、边界检查 37 文件；该文件同样不入库。

## 迁移改动与未适配

- Bun → Node：`spawnSync` / `writeFileSync` / `pathToFileURL` 主入口判定；Node 24 直接跑 `.ts`。
- 扫描根：`src/` + `desktop/**` → `app/src`；git 基线路径统一加 `app/` 前缀。
- file-size：`desktop/package.json` → `app/package.json`；`OWN_FILES` 置空；release 阈值保留但 0.x 不触发。
- tsc：新增 pnpm store 路径折叠；基线从零；`--baseline-ref` 保留。
- import-semantics：L1 保留，路径加 `app/` 前缀；本项目暂无 L1 基线，默认只跑 L2/L3。
- git-hooks：移除前身 legacy `quality.*` git config；pre-commit 只跑 file-size + import-semantics。
- preflight：build 阶段未适配（无打包配置），fail-closed；CC 业务字面量/desktop/sidecar 未迁移。

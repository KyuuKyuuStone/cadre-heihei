# A 档四门禁

从 cc-heihei v1.7.9（`8ab1c24`）只读迁移，路径与 import 已适配 `app/` 结构；
旧 baseline 一律未沿用，按空仓重新生成。

| 门禁 | 命令 | 判定 |
|---|---|---|
| file-size | `node scripts/gates/check-file-size.ts` | 新文件 >2500 行红；基线只许降；allowlist 过期红 |
| import-semantics | `node scripts/gates/check-import-semantics.ts` | L2/L3 形态不符红；L1 需显式基线 |
| tsc-baseline | `node scripts/gates/check-tsc-baseline.ts` | 新增签名/计数超红；真空检查红 |
| smoke | `node scripts/gates/smoke.ts` | Node test runner + JUnit；**0 例红、skipped>0 红、fail>0 红** |

`acceptance-lib.ts` 是 smoke 门禁的 JUnit 解析/判定库，其单测在 `app/tests/acceptance-lib.test.ts`。

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

## 迁移改动与未适配

- Bun → Node：`spawnSync` / `writeFileSync` / `pathToFileURL` 主入口判定；Node 24 直接跑 `.ts`。
- 扫描根：`src/` + `desktop/**` → `app/src`；git 基线路径统一加 `app/` 前缀。
- file-size：`desktop/package.json` → `app/package.json`；`OWN_FILES` 置空；release 阈值保留但 0.x 不触发。
- tsc：新增 pnpm store 路径折叠；基线从零；`--baseline-ref` 保留。
- import-semantics：L1 保留，路径加 `app/` 前缀；本项目暂无 L1 基线，默认只跑 L2/L3。
- git-hooks：移除前身 legacy `quality.*` git config；pre-commit 只跑 file-size + import-semantics。
- preflight：build 阶段未适配（无打包配置），fail-closed；CC 业务字面量/desktop/sidecar 未迁移。

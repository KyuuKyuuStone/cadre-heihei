# desktop 四门禁

从 `app/scripts/gates/` 迁入，适配 desktop 的目录与包结构（`apps/*/src`、`packages/*/*/src`、`cadre-collab`）。

| 门禁 | 文件 | 判据 |
|---|---|---|
| file-size | `check-file-size.ts` | 源文件 >2500 行失败；基线条目只许下调；豁免须带 reason/decisionRef/expiresInVersion |
| import-semantics | `check-import-semantics.ts` | L2/L3 node 内建模块 promise/回调套件混用；UI-ISO（`packages/client/ui-*/src`、`apps/desktop/src/client` 禁 `node:*`/`electron`）；COLLAB-ISO（`cadre-collab` 禁 electron、禁引用 `apps/**`/`packages/**`） |
| tsc-baseline | `check-tsc-baseline.ts` | host/client 两侧 tsc 诊断签名棘轮，只许降；新增签名/计数超即失败 |
| smoke | `smoke.ts` | vitest 冒烟子集，必须收集 >0 例且 skipped=0、fail=0 |

## 命令

```bash
pnpm run gates          # 四门禁顺序执行，结果落 scripts/gates/evidence/
pnpm run gates:file-size
pnpm run gates:imports
pnpm run gates:tsc
pnpm run gates:smoke
```

- `lint` 末尾接 file-size / import-semantics / tsc-baseline；`test` 末尾接 smoke。
- 基线文件：`file-size-baseline.json`、`tsc-host-baseline.json`、`tsc-client-baseline.json`。
- 基线只许下调（`--update` 重算须同提交并说明）；`--baseline-ref <rev>` 可做防倒转校验。
- `evidence/` 是本地留档，不入库。

## 判别力（改坏必判红）

三个静态门禁已做探针验证：新增 2601 行且 `import 'electron'` 的探针文件令 file-size 与 import-semantics 同时判红；`const probe: string = 1` 令 tsc-baseline 判红；删除探针后均复绿。smoke 的红路径沿用 vitest 失败即失败的语义，未单独做坏样本。

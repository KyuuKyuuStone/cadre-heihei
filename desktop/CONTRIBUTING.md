# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for your interest in Cadre Heihei, a multi-session collaboration distribution built on DeepSeek Harness.

## Current stage

The 1.0 cycle focuses on hardening the core loop. Issues and discussions are welcome; for code PRs, please open a discussion to align on scope first.

## Commit discipline

- Stage only your own files (shared working tree, multiple changes in flight); verify with `git diff --cached --name-only`.
- Do not stash/reset/checkout shared branches; `push` requires maintainer authorization.
- Changing `cadre-collab/**` requires rebuilding the CJS bundles (`pnpm run build:cadre`); the `cadre-build` gate rejects stale output.
- Tests describe behavior, not correctness; a failing sample (proves the bug) lands with its fix.

## Welcome contributions

- Bug reports: symptom → reproduction steps → expected behavior. The maintainers keep the internal defect ledger; external reporters can use an issue.
- Plugin ecosystem (`dsh-plugin` topic), documentation and translations, reproductions and minimal cases.

## Out of scope

- No cloud services or telemetry; do not change the "the writer and the acceptor are different people" role boundary; never commit credentials or internal documents.

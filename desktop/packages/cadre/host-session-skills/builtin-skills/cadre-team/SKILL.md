# Cadre Team Mode

Use this checklist when a dispatch is ambiguous or when handing work to another role.

## Dispatch template (mandatory)

1. HEAD anchor (short hash).
2. Prerequisite artifact paths.
3. Acceptance criteria.
4. Forbidden actions.

If a field is missing, report the gap before starting.

## Evidence

- Cite `file:line` and command output for every claim.
- Reference accepted reports by `§number`; do not re-run what they already proved.
- Confirm each delivery twice: ledger state plus the file/artifact on disk.

## Baseline

- Read `package.json` and `git rev-parse HEAD` before quoting a version.
- One delivery uses one version; never mix 1.2/1.3/1.1 labels.

## Permissions

- Actor and target are distinct: resolve both from the roster; supervisors dispatch/review, workers execute.
- Departed members lose role and tools; cross-project work is rejected.

## Environment

- EDR may block temp paths; use short clone paths and mirrors.
- Run long builds detached with log files; check logs rather than polling.
- Do not revert other agents' shared-worktree changes; use a worktree for parallel work.

## Release preflight

- Rebuild gitignored CJS from current sources.
- Run gates/evidence/smoke/build:check.
- Verify asar contains the expected migration and route strings.
- Report the artifact hash; do not push/tag without authorization.

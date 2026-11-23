# Cadre Team Mode

Use this checklist when a dispatch is ambiguous or when handing work to another role.

## Dispatch template (mandatory)

1. HEAD anchor (short hash).
2. Prerequisite artifact paths.
3. Acceptance criteria.
4. Forbidden actions.

If a field is missing, report the gap before starting.

## Verification moderation

- Default to spot-checks for every role, including review roles; do not re-verify every delivery exhaustively.
- Exhaustive checks only through three entrances: real run/compiler/test/editor errors; the same problem still failing after two fix rounds; an explicit user request.
- For an explicit user request, ask back once with the cost magnitude and a lighter spot-check alternative; after the user accepts, execute the named scope in full and never ask again.
- Carry the user request and the cost acceptance verbatim into the task packet as the authorization source.

## Evidence

- Cite `file:line` and command output for every claim.
- Reference accepted reports by `§number`; do not re-run what they already proved.
- Acceptance spot-checks the ledger state plus the delivered artifact on disk; escalate to exhaustive only through the entrances above.

## Baseline

- Read `package.json` and `git rev-parse HEAD` before quoting a version.
- One delivery uses one version; never mix 1.2/1.3/1.1 labels.

## Permissions

- Actor and target are distinct: resolve both from the roster; the team lead dispatches and reviews, workers execute.
- Departed members lose role and tools; cross-project work is rejected.

## Decisions

- The user is the final judge: report findings with options ordered by cost and let the user decide; never fix beyond the named scope silently.

## Environment

- EDR may block temp paths; use short clone paths and mirrors.
- Run long builds detached with log files; check logs rather than polling.
- Do not revert other agents' shared-worktree changes; use a worktree for parallel work.

## Release preflight

- Rebuild gitignored CJS from current sources.
- Run gates/evidence/smoke/build:check.
- Verify asar contains the expected migration and route strings.
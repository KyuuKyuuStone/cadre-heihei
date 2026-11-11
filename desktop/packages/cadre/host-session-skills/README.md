# @deepseek-ai/dsh-host-session-skills

Per-session Cadre skill packs. The roster's `members.skills_json` selects pack
ids; only those packs are registered into each agent's skill scope. An empty
selection registers nothing, and changed selections dispose the old
registrations before registering the new set.

## Catalog

Each immediate child of `CADRE_SKILLS_DIR` (default `~/.dsh/cadre-skills`) is an
`installed` pack; `@scope/<pack>` containers are also scanned. `builtin-skills/`
in this package is merged as read-only `builtin` packs. A pack has:

- `manifest.json` (optional for SkillHub packs): `id`, `name`, `description`,
  optional `descriptionI18n {zh,en}`, optional `author` and credential-free
  https `homepage`, `roles` (`supervisor`/`worker`), `tokenEstimate`, `tools`,
  `source`, `license`;
- `SKILL.md`: the model-visible body.

When `manifest.json` is absent, the catalog synthesizes the pack from
`SKILL.md` frontmatter (`name`, `slug`, `displayName`, `description`,
optional `description_zh`/`_en`, `roles`, `author`, `homepage`, `license`).
Missing roles default to `worker`; missing license is `unknown`; token estimate
is `ceil(chars / 4)`. Scope packs get a scope-qualified id
(`@indiv-guipi/find-skills` → `indiv-guipi-find-skills`), so equal slugs in
different scopes do not collide. Invalid frontmatter is skipped with a log;
manifest packs remain fail-loud. Builtin ids win over installed duplicates and
duplicate installed ids keep the first pack. No generated manifest is written.

Catalog entries carry `origin` (`builtin`/`installed`); builtin packs cannot be
overwritten or removed. A request `locale` starting with `zh` selects
`descriptionI18n.zh`, otherwise `.en`, falling back to `description`.

`roles` is metadata only: any selected pack registers for a member regardless of
supervisor/worker. The plugin reloads the catalog on every
pre-step, so edited pack content is hot-reloaded (the old registration is
disposed first).

## Model experience

- Skill packs: only the roster-selected packs enter the system prompt through the
  skill registry. An unselected session has zero skill tokens from this plugin.
- Conversational tools: eight tool schemas are registered once at the Cadre bundle
  root, so every agent scope inherits them. Their English descriptions are pinned
  verbatim by `tests/conversation-schema.spec.ts`, and the parameter limits are
  part of the model-visible JSON schema, so a disallowed value never reaches the
  executor. Schema tokens are paid by every session in every preset, including
  sessions that never touch skills; keeping the eight descriptions to one sentence
  each bounds that cost.
- Failures return `{ok:false, code, message, remediation}`. `message` and
  `remediation` are short Chinese sentences that name the next action, so a model
  recovers without parsing an error table.

## Conversational skill tools

`./conversation` mounts `skill_catalog`, `skill_search`, `skill_preview`,
`skill_install`, `skill_create`, `skill_check`, `skill_audit`, and `skill_plan`
once at the bundle root; every shipped preset inherits that registration and the
hidden `cadre-skill-admin` preset sees the same eight with its own eight shadowing
them inside its scope. Disposing the root fiber removes all eight.

- `skill_catalog` and `skill_preview` read the merged catalog; preview returns the
  `SKILL.md` body and estimate without writing.
- `skill_search` asks the injected provider first. Without a provider — or on a
  timeout, a non-2xx response, or malformed JSON — it returns `source:'local'`,
  `degraded:true`, local matches, and one Chinese `message`; only an unreadable
  local catalog root fails with `SKILL_SEARCH_UNAVAILABLE`. No provider means no
  remote request at all.
- `skill_install` takes exactly one of `name`, `url`, or `text`. A warning-bearing
  request (`missing-license`/`missing-hash`/`unknown-source`) returns
  `requiresConfirmation:true` plus a preview and writes nothing; a non-supervisor
  keeps getting `SKILL_CONFIRM_REQUIRED` even with `confirm:true`, and the
  supervisor's confirmed call installs and audits the warnings.
- `skill_create` writes a local pack; `overwrite:true` needs `confirm:true` and a
  supervisor, so a worker's overwrite is `SKILL_FORBIDDEN` and a supervisor's
  unconfirmed overwrite is `SKILL_INVALID`.
- `skill_check` walks both catalog roots read-only and reports broken manifests,
  empty `SKILL.md`, missing description, non-SPDX license, unknown roles,
  duplicate ids, an oversized estimate, declared-but-unused tools, an unreadable
  root, and builtin/installed conflicts. Every issue carries `code`, `message`,
  and an actionable Chinese `remediation`.
- `skill_audit` returns only rows visible to the calling actor's project;
  `skill_plan` is supervisor-only and never writes.

Authorization is per call, not per page: a session must belong to an existing
project (an off-roster session gets `SKILL_PROJECT_REQUIRED`), a session rostered
by another project is `SKILL_FORBIDDEN`, a departed member is `SKILL_FORBIDDEN`,
and audit rows stay inside the project. `tests/conversation-auth.spec.ts` asserts
each cell with its `code` and Chinese `remediation`; `skill-api-scope.spec.ts`
remains the proof that `requireSupervisorConfirmation` is not loosened.

## Settings IPC

POST JSON, project-scoped. `catalog`/`get`/`set` admit any session of an existing project: an off-roster session reads no selection and its `set` validates and echoes without persisting, a rostered session reads and updates its own row, and a supervisor may target any member. `add`/`remove`/`install-url`/`install-package` also admit any project session. A missing project, a session rostered by another project, and a departed member stay rejected. Existence is proven by a `members` row or a `projects` row: the schema creates `projects` without filling it, so a roster-only ledger still serves its project. `preview` remains supervisor-only; warning-bearing installs still need a supervisor confirmation; admin message/read/install admit project sessions, while plan/apply remain supervisor-only.

- `/cadre/skills/catalog` — `{projectId, actorSessionId, targetSessionId?}` →
  catalog entries with `selected`;
- `/cadre/skills/get` — `{projectId, actorSessionId, targetSessionId}` →
  `{skills}`;
- `/cadre/skills/set` — above + `{skills: string[]}`; validates ids, roles and
  dedupes before writing `members.skills_json`;
- `/cadre/skills/preview` — `{projectId, actorSessionId, packId}` → `SKILL.md`
  body and `tokenEstimate`; read-only;
- `/cadre/skills/add` — manifest fields + `content`; kebab-case id, valid roles,
  atomic directory write, `overwrite:true` only replaces;
- `/cadre/skills/remove` — `{packId, confirm:true}` deletes the pack directory;
- `/cadre/skills/install-url` — `{url, confirm?}` fetches `manifest.json` and
  `SKILL.md` from a public GitHub raw/tree URL over HTTPS (size/timeout bounded;
  no SkillHub/ClawHub API);
- `/cadre/skills/install-package` — `{name}` installs a SkillHub package through
  the fixed WSL CLI (`wsl -d Ubuntu-24.04 -- /root/.local/bin/skillhub install
  <name> --dir <skillsDir>`), 180s timeout, strict package-name validation, and
  an audit row without secrets;
- `/cadre/skills/install-any` — `{text}` extracts one strict package name or
  URL from free text; a SkillHub instruction URL plus a package routes to
  `install-package`, a lone URL to `install-url`, and multiple/ambiguous
  candidates fail with `SKILL_INSTRUCTION_UNSUPPORTED`.

## Skill administrator

`cadre-skill-admin` is a hidden ordinary preset for the skills-page conversation.
It never writes roster rows or team tools. Its backend routes are:

- `/cadre/skills/admin/session` — `{projectId, cwd?}` creates an ordinary session through the Host `sessionController`; the workspace (default `~/.dsh/cadre-skill-admin/workspace`) is created with `mkdir -p`, registered through `workspaceRegistry` as an internal `技能管理员工作区（内部）`, the session is attached to it, and `{cwd, workspaceId}` are returned. The project only has to exist: no roster row is required, so a project without members still gets an administrator. The session is bound to its project in `~/.dsh/cadre-skill-admin/sessions.json`, and a session missing from that file is rebound when the Host still lists it and the ledger has exactly one project;
- `/cadre/skills/admin/sessions` — lists sessions created for the project whose
  projection preset is `cadre-skill-admin`;
- `/cadre/skills/admin/delete-session` — removes one listed project session when
  the Host supports deletion;
- `/cadre/skills/admin/plan` — `{url}` or `{kind:'remove'|'update', packId}`;
  returns `planId`, hashes, target, actions and risk flags, plus a one-time
  `confirmToken`; it never writes;
- `/cadre/skills/admin/message` — `{projectId, actorSessionId, sessionId, text}`
  prompts an admin session; any active project member may send;
- `/cadre/skills/admin/messages` — GET query or POST body with `projectId`,
  `actorSessionId`, `sessionId`, and optional `afterSeq`; returns user/assistant
  text increments;
- `/cadre/skills/admin/apply` — `{planId, token}`; revalidates the operator as a
  supervisor and applies install/update/remove with backup, rollback and audit;
- `/cadre/skills/admin/audit` — append-only JSONL records without page bodies or
  secrets;
- `/cadre/skills/admin/diag` — GET query or POST body with `projectId` and
  `operatorSessionId`; returns the preset roster, whether `cadre-skill-admin`
  exists/is broken, `sessionController` availability and admin-service state.
  Failed session creation also appends a redacted record to
  `~/.dsh/cadre-skill-admin/session-error.log`.

Unknown/unsupported URLs return a plan with `kind: 'unsupported'` and a readable
reason. Admin message/read/install are project-member scoped; the conversation
itself carries no role prompt.

### Model tools (preset-scoped)

`./admin` is mounted only by the `cadre-skill-admin` preset. It registers `skill_catalog`, `skill_preview`, `skill_install`, `skill_plan`, and `skill_audit`; tools resolve the session's project from the admin session binding and, when that resolution cannot be recovered, fail with a `code` and the corrective `remediation` instead of an anonymous error. Authoring needs no supervisor: all four read/plan tools serve a project with no roster row, `skill_preview` reads the pack directories directly, and `skill_install` accepts one of `name`, `url`, or `text`, reusing `install-package`/`install-url`/`install-any`. A warning-bearing request (`missing-license`/`missing-hash`/`unknown-source`) installs nothing and returns `requiresConfirmation:true` plus a preview; the admin session calls again with `confirm:true` once the user agrees, and the audit records the warnings and the confirming session. `skill_plan` returns a one-time `confirmToken`; execution remains `POST /cadre/skills/admin/apply` after the user confirms in the UI, and that route still requires a supervisor operator. The preset mounts read-only fs and fetch tools only — no shell, write, team, or email tools.

## Known Limitations and Deferred Work

- No settings UI yet; the IPC above is the data surface.
- Pack selection is stored as JSON in `members.skills_json`; the schema migration
  is additive and defaults to `[]`.
- An off-roster session has no `members` row, so its `set` call validates the ids and echoes them back without persisting a selection; such a session reads every pack as unselected.
- A warning-bearing install is authorized by the skill API's confirmation gate, which still requires a roster supervisor actor. Without one, `skill_install` returns `SKILL_CONFIRM_REQUIRED` even from an admin session; lifting that needs `requireSupervisorConfirmation` in `src/ipc.ts` to accept an admin-vouched operator, which a follow-up on that file owns.
- The route error mapping forwards `code` and `message` only, so a recoverable failure carries its `remediation` inside the message rather than as its own response field.
- Binding recovery needs an unambiguous project: when the ledger holds several projects and the session is missing from `sessions.json`, the tools fail with `SKILL_ADMIN_SESSION_NOT_FOUND` and the remediation asks the caller to pass `projectId` explicitly.
- No keyless recorded-session snapshot was added for the new tool surface. The surface is pinned by `tests/conversation-schema.spec.ts` (names, verbatim English descriptions, limits) and by a real Loader composition spec whose log (`logs/fix/skill-conversational/composition.log`) lists all eight names per preset. A recorded-session replay needs a shipped profile prompt fixture owned by `snapshots/`, and this task builds none; tool-card rendering belongs to the UI task.

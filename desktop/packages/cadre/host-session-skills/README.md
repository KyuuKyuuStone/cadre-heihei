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

Only selected packs enter the system prompt through the skill registry. An
unselected session has zero skill tokens from this plugin.

## Settings IPC

POST JSON, project-scoped. `catalog`/`get`/`set` admit registered members:
a worker may read and update its own selection, a supervisor may target any
member. `add`/`remove`/`install-url`/`install-package` also admit any registered
member; `preview` and the skill-administrator conversation remain supervisor-only.

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

- `/cadre/skills/admin/session` — `{projectId, operatorSessionId, cwd?}` creates
  or resumes an ordinary session through the Host `sessionController`;
- `/cadre/skills/admin/sessions` — lists sessions whose projection preset is
  `cadre-skill-admin`;
- `/cadre/skills/admin/delete-session` — removes one listed session when the Host
  supports deletion;
- `/cadre/skills/admin/plan` — `{url}` or `{kind:'remove'|'update', packId}`;
  returns `planId`, hashes, target, actions and risk flags, plus a one-time
  `confirmToken`; it never writes;
- `/cadre/skills/admin/message` — `{sessionId, text}` prompts a bound admin
  session through `sessionController`;
- `/cadre/skills/admin/messages` — GET query or POST body with `sessionId` and
  optional `afterSeq`; returns user/assistant text increments;
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
reason. The admin operator is authorized from the roster on every call; the
conversation itself carries no role prompt.

### Model tools (preset-scoped)

`./admin` is mounted only by the `cadre-skill-admin` preset. It registers
`skill_catalog`, `skill_preview`, `skill_install`, `skill_plan`, and
`skill_audit`; those tools resolve the bound operator from the admin session.
`skill_install` accepts one of `name`, `url`, or `text`, reuses
`install-package`/`install-url`/`install-any`, and writes an audit row without a
plan/apply round trip. `skill_plan` still returns a one-time `confirmToken`;
execution remains `POST /cadre/skills/admin/apply` after the user confirms in
the UI. The preset mounts read-only fs and fetch tools only — no shell, write,
team, or email tools.

## Known Limitations and Deferred Work

- No settings UI yet; the IPC above is the data surface.
- Pack selection is stored as JSON in `members.skills_json`; the schema migration
  is additive and defaults to `[]`.

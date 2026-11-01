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

Role mismatches are rejected per pack. The plugin reloads the catalog on every
pre-step, so edited pack content is hot-reloaded (the old registration is
disposed first).

## Model experience

Only selected packs enter the system prompt through the skill registry. An
unselected session has zero skill tokens from this plugin.

## Settings IPC

POST JSON, supervisor-only and project-scoped:

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
  no SkillHub/ClawHub API).

## Known Limitations and Deferred Work

- No settings UI yet; the IPC above is the data surface.
- Pack selection is stored as JSON in `members.skills_json`; the schema migration
  is additive and defaults to `[]`.

# @deepseek-ai/dsh-host-session-skills

Per-session Cadre skill packs. The roster's `members.skills_json` selects pack
ids; only those packs are registered into each agent's skill scope. An empty
selection registers nothing, and changed selections dispose the old
registrations before registering the new set.

## Catalog

Each immediate child of `CADRE_SKILLS_DIR` (default `~/.dsh/cadre-skills`) is an
`installed` pack; `builtin-skills/` in this package is merged as read-only
`builtin` packs. Each pack has:

- `manifest.json`: `id`, `name`, `description`, optional
  `descriptionI18n {zh,en}`, `roles` (`supervisor`/`worker`), `tokenEstimate`,
  `tools`, `source`, `license`;
- `SKILL.md`: the model-visible body.

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

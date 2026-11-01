# @deepseek-ai/dsh-host-session-skills

Per-session Cadre skill packs. The roster's `members.skills_json` selects pack
ids; only those packs are registered into each agent's skill scope. An empty
selection registers nothing, and changed selections dispose the old
registrations before registering the new set.

## Catalog

Each immediate child of `CADRE_SKILLS_DIR` (default `~/.dsh/cadre-skills`) is a
pack with:

- `manifest.json`: `id`, `name`, `description`, `roles` (`supervisor`/`worker`),
  `tokenEstimate`, `tools`, `source`, `license`;
- `SKILL.md`: the model-visible body.

Role mismatches are rejected per pack. The plugin reloads the catalog on every
pre-step, so edited pack content is hot-reloaded (the old registration is
disposed first).

## Model experience

Only selected packs enter the system prompt through the skill registry. An
unselected session has zero skill tokens from this plugin.

## Known Limitations and Deferred Work

- No settings UI yet; the future IPC surface is documented in
  `后端-会话级技能包.md`.
- Pack selection is stored as JSON in `members.skills_json`; the schema migration
  is additive and defaults to `[]`.

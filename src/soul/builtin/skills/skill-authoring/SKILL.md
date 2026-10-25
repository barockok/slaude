---
name: skill-authoring
description: How to create, refine and retire your own skills.
trigger: Before write_skill or delete_skill
governs: [mcp__slaude_skills__write_skill, mcp__slaude_skills__delete_skill]
version: "{{SLAUDE_VERSION}}"
---
## Skill evolution (grow over time)
- You can author your own skills. Each skill is a markdown file at
  `~/.slaude/skills/<slug>/SKILL.md` invoked later as `/<slug>`. The
  `mcp__slaude_skills__*` server exposes: `list_skills`, `read_skill`,
  `write_skill`, `delete_skill`, `sync_manifest` — all usable freely,
  no approval card needed. Skills are agent-owned and reversible.
- At the end of a turn that took several steps and showed a procedure
  you would plausibly repeat, evaluate before your final reply:
  1. Call `list_skills` if you don't already know what exists.
  2. Did this turn demonstrate a repeatable procedure not yet captured
     in a skill? → `write_skill` (new slug, clear description,
     parameterised body using `${SLAUDE_SKILL_ARGS}`).
  3. Did this turn refine or contradict an existing skill? → `read_skill`,
     then `write_skill` to overwrite with the improved version. Preserve
     prior intent; don't silently truncate.
  4. Neither? → do nothing. Skill bloat is worse than skill absence.
- Messages wrapped in `<runtime-check ...>` come from the runtime, not a
  person. They never require a reply.
- Do not announce a skill save or update unless the user asked for the
  skill. Never narrate routine auto-evolve evaluations.
- Skills are for procedures (steps, checklists, tool sequences), not for
  one-off facts (those belong in memory). If the lesson is "remember X",
  write it to memory instead.
- Keep skill bodies short and operational. Reference inputs via
  `${SLAUDE_SKILL_ARGS}`, the working dir via `${SLAUDE_SKILL_DIR}`,
  the session id via `${SLAUDE_SESSION_ID}`.

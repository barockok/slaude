Weekly skill review for {{WEEK}}, over this agent's own skills.

`{{LIST_TOOL}}` lists the skills in this agent's skills root, one entry each: `slug`, `name`, `description`, `provenance` (`agent` = the agent wrote it with write_skill; `installed` = from slaude.lock, a personas repo or the operator; `bundled` = shipped with the release), `uses` (all-time loads), `last_used_at`, `tracked_since` (when usage counting began for it), `authored_at`, and `idle_days` (days since the latest of those three). You never see a skill's body. Built-in `slaude:` skills are not listed and are never reviewed.

Decide, per skill, whether it still earns its place:
- Unused: `idle_days` is at least {{UNUSED_DAYS}} (no load in {{UNUSED_DAYS}} days, counted only since tracking began).
- Harmful: the agent's own memory shows it misleads (a `correction` or `outcome` page, or a lesson in `self/lessons`, that names the skill). Look with `search`, `list_pages` and `read_pages` before calling a skill harmful.
- Anything else stays. When in doubt, keep it.

What to do with a skill that should go:
- `provenance: agent`: retire it with `{{RETIRE_TOOL}}` (slug and a one-sentence reason that says unused or names the evidence). Retiring is a soft delete: the skill moves aside and can be restored. At most {{MAX_RETIREMENTS}} retirements per review; leave the rest for next week.
- `installed` or `bundled`: never retire it (a sync would bring it back). `propose` kind `skill-removal` to `manager`, with payload `{ "slug", "provenance", "reason", "uses", "last_used_at" }`. The operator decides.

Write nothing else. When every skill earns its place, do nothing and stop.

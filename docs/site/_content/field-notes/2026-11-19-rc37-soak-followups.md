---
title: "Soak follow-ups: reload that reaches a node, skills callable by slug, a bucket sweeper, an honest loss counter"
date: 2026-11-19
---

# Soak follow-ups after the remote-storage releases

**Date:** 2026-11-19. **Status:** merged behind the existing settings; the sweeper is off by default.
Spec: `docs/superpowers/specs/2026-11-19-s3-followups-design.md`.

Running the remote-storage releases on one machine (a gateway, one node, Postgres, Redis and an S3-compatible server)
turned up seven loose ends. None was an outage. Each one is a mechanism worth writing down.

## A reload that stops at the gateway

`reload_session` (and every other reload the gateway starts: connecting an MCP server, a new session, an unlock) called
`agent.reload` on the **gateway's** `AgentManager`. That manager only holds the sessions it booted. With a node queue
the live query is in the node's manager, so the call answered false ("session not live") while the session was running.
The tool then told the user nothing had been reloaded, and a model that read "not live" went on to claim the session
was already up to date.

The fix follows the abort path: a per-session Redis channel plus a durable flag (with a 10 minute TTL, so a flag for a
session that is live nowhere cannot fire at a later, unrelated turn). The node subscribes for the length of a turn and
calls `reloadAfterTurn` (an idle query closes now, a busy one when its result arrives); at job claim it applies a flag
that was set while no node held the session. Every gateway reload goes through one `routeReload` helper, and a
source-scan test fails if a new `agent.reload(` call appears beside it. The tool now says "Reload requested", which is
true whether the reload ran here or was routed to a node.

## A skill is matched by its frontmatter name

The bundled CLI matches a skill by its command name (`<plugin>:<slug>`) or by its frontmatter `name`. `write_skill`
documented `name` as "human-readable" and wrote it as the frontmatter `name`, so a skill titled "Clone a repo by name"
could only be called as `<plugin>:clone-repo`; the bare slug answered "Unknown skill". In a real deployment 14 of 68
skills were like this, all agent-written (installed and bundled skills already used the slug). A slash command never
hit it (the gateway inlines the skill body without the `Skill` tool), and models usually pass the qualified name, so it
surfaced only when a model used the bare slug.

`write_skill` now always writes `name: <slug>` and keeps the human name as `title`; `list_skills` and the inlined
invocation show `title ?? name`. A one-time, idempotent migration at gateway start rewrites older agent-written skills
(provenance `agent` only, base and persona overlays), through the normal write path so the version log and the bucket
get the new version. An `agent.yaml` `skills` entry that spelled the old title still matches. A hook that rewrites the
tool input was considered and left out: whether the CLI applies `updatedInput` without a permission decision cannot be
confirmed without a live model call.

## A bucket that only grows

Per-directory history is trimmed as it syncs, but a directory nobody uses any more, and an attachment no node
collected, stayed forever. The storage layer stores **directories** ("units"), shared by every session that works in
them, so a session closing says nothing about whether its unit is garbage. The gateway can now sweep by age:
`SLAUDE_STORAGE_SWEEP=off|dry-run|on` (off by default), a unit deleted whole when its newest object is older than
`SLAUDE_STORAGE_RETAIN_DAYS` (90), an `inbox/` object older than `SLAUDE_STORAGE_INBOX_TTL_HOURS` (168). Age is the
newest object's modified time, so only writes count (hence the long window). Never swept: a unit with a pending flush, a
unit with any object that reports no modified time, anything outside `sessions/` and `inbox/`. One replica sweeps per
day (a Redis lock held for the interval). An unreadable setting is `off`, never `on`.

`removeSession` took a unit id, not a session id; it is now `removeUnit`.

## A loss counter that fired on every recreate

`slaude_storage_unflushed_loss_total` counted a loss whenever the node that owned a needs-flush mark was gone. A worker
recreated on the same disk is a new node, but its local files and its sync marker survive. When the marker still names
the newest stored manifest the hydrate is a warm no-op, the edits stay on disk and the next flush uploads them, so
nothing is lost and an alert on the counter would fire on every deploy. The dead-owner branch now reads the marker and
the latest manifest first; only a mismatch, or a read that fails, counts a loss.

## Smaller changes

- `.venv` joins the default sync ignore (a virtualenv is rebuilt from its requirements). `.git` stays synced: agents
  clone repositories into workspaces.
- The guide now says when the `Skill` tool sees a new skill: the file is current on every node at once, but the agent
  SDK reads its plugins when a query starts, so a session already running does not see it.
- A test for twenty nodes racing for one session lock (exactly one runs), proved able to fail by breaking the lock.

## Open

- A stalled or failing publish of a reload request is logged and still reported as requested; the caller is synchronous.
- The sweeper has no per-unit audit trail beyond the log line; run `dry-run` first.

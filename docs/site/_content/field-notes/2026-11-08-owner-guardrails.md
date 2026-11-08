---
title: "Owner guardrails: rules the owner defines, enforced by code, signed as a set"
date: 2026-11-08
---

# Owner guardrails: rules the owner defines, enforced by code, signed as a set

**Date:** 2026-11-08
**Status:** Phase A1 shipped in `v0.46.0-rc.9` (branch `feat/owner-guardrails`).
Phase A2 (tool approve cards, one outbound choke point, reply rules) is rc.10;
phase B (console editing, the Test box, moving the soul and access settings to
the agent's tabs) is rc.11. Design:
`docs/superpowers/specs/2026-11-08-owner-guardrails.md`. Operator reference:
[Guardrails](../reference/guardrails.md).

## Problem

rc.7 turned the console's Guardrails page into a view of the runtime's own
layer: the prompt stack, the hooks and gates, the deny lists. Every agent on
every deployment saw the same thing, and nothing on it was the owner's. The
operator wanted guardrails they define, like the soul: their own rules for
what an agent may do, say and accept, shared by every agent or specific to
some, narrowed to channels. The built-in layer stays "within the code only".

## What shipped

- **A resource with an authoring format.** One guardrail is a `GUARDRAIL.md`:
  YAML frontmatter (scope, agents, channels, enabled, load, triggers), prose
  (Guidance) and a fenced `rules` block (Enforced). Parsed with YAML and zod,
  never a model: exact rules need exact parsing. Every pattern runs on `re2js`
  (linear time, dotall by default), length capped, compiled once; matched text
  is size capped; tool input is matched per field or per string value, never
  as serialised JSON. A bad rule is reported and dropped; the rest still load.
- **The database is the only runtime source.** `guardrails`,
  `guardrail_overrides` and `guardrails_manifest` tables in both dialects. The
  deploy repo's `guardrails/` folder reaches them through `/deploy` (payload
  version 5); host files through `slaude guardrails import`. Sessions never read
  guardrail files: an agent session can write under `$SLAUDE_HOME`.
- **Two kinds of rule, loaded differently.** Enforced rules never enter the
  prompt; a PreToolUse hook (`hook.pre-tool.owner-guardrails`) applies tool
  rules in every permission mode, and inbound rules drop a message in
  `preTurnDropReason` (a new drop kind with a rate-limited reply). Guidance is
  an `<owner-guardrails>` block after `<persona>`, or, with `load: on-match`,
  delivered by code once per session when a trigger matches.
- **Nodes.** The effective documents ride in the runtime bundle with the set's
  version as an explicit ETag input. Nodes advertise a `guardrails/1`
  capability; the gateway refuses an agent with enforced rules to a node
  without it, and the dispatcher only routes such turns to capable nodes.
- **Console.** Resources > Guardrails is the owner's list and detail, each
  agent has a Guardrails tab, and a superadmin can switch a guardrail off and
  on. The rc.7 runtime-layer sections and API fields are gone; the registry
  (`src/agent/guardrails.ts`) and its agreement test stay as a code-only drift
  check, now with the two new hook ids.

## Findings and decisions

**Per-row HMACs do not cover the set.** The first design signed each row over
(slug, md, version, enabled). The final review caught that a deleted row, or a
replayed older row with its old (valid) signature, still verifies: deleting a
"never send email" guardrail would pass every check. A single manifest row per
tenant now signs the sorted (slug, version, enabled) list plus the overrides,
written in the same transaction as every change; versions only grow. The
check runs manifest first, then membership and versions, then each row. A
test deletes a row, replays an older one and adds an unlisted one; each fails
closed. What a manifest cannot stop: deleting everything (rows and manifest)
reads as "no guardrails". That needs database write access, which a session
has only on a single sqlite process, and the threat model says so.

**Fail closed means the session, not the gateway.** A set that does not verify
must not run sessions with fewer rules, but taking the whole gateway down
would turn one corrupted row into an outage for every agent. The snapshot
holds the failure; every session boot that needs it fails with
`GUARDRAILS_UNAVAILABLE` (audited `guardrail.integrity.failed`), the console
shows the reason, and a node's bundle fetch gets a 503 with the same code.

**Old nodes must not see the job at all.** A field in the job payload would be
ignored by an older node, which would then run the turn without the rules.
Two checks close it: the gateway refuses the runtime bundle (which every boot
fetches) to a node that does not send the capability header, and the
dispatcher routes an agent with enforced rules only to nodes whose heartbeat
advertises it. In a mixed fleet an older node still consumes the label queue,
so the turn goes to a capable node's own queue; with none, it waits up to the
unserved-label threshold, then the thread is told.

**A delivery refusal is not the agent's choice.** Refusing a tool call once to
hand over on-match Guidance costs the model a turn. In a wake or a background
pass that turn would come out of a cap the owner set for real work, so the cap
grows by one per on-match tool guardrail (each refuses at most once per
session).

**Inbound Guidance is matched where the message is.** The gateway sees the
text before any node does, so it matches inbound triggers and the Guidance
travels on the job's message; the node's session takes each guardrail at most
once per boot, which also dedupes a guardrail whose tool trigger already
delivered it.

**A tool `approve` is enforced as a deny in this release.** Approval cards
for tool rules need a spike (the SDK's hook timeout is shorter than a card's
life). Letting the call run until rc.10 would be the opposite of what the
owner wrote; denying it is the safe reading. Reply rules are parsed, stored and
shown as *Not yet enforced*: they need the single outbound choke point.

**Without a master key the HMAC key is a file, on sqlite only.** A single
process on sqlite may have no `SLAUDE_MASTER_KEY`; a random per-process key
(the ETag's fallback) would not survive a restart or match the import CLI's
process. The key is created on the first write under
`$SLAUDE_HOME/guardrails/.hmac-key` (0600, refused to the file tools for
writing and reading). A session's shell can still read it there, which is the
same limit the threat model already states for that mode. Postgres requires
the master key.

## Review fixes before merge

A review of the first push found ways around each layer; all fixed in the
same release:

- **Padding.** Strings were capped at 16 KB and the input walk at 200 values,
  8 levels deep, so a value past the cap (or at `to[201]`) was never checked.
  RE2 is linear, so strings are now matched whole up to 1 MB; past any bound
  (size, count, depth, total) the input is too large to check, which is a
  match for deny and approve rules and best effort for audit rules.
- **Laundering.** A write re-signed the manifest over whatever rows were
  stored, so the next legitimate write blessed a tampered row. A write now
  verifies the stored set first; only the owner's `import --repair` re-signs.
- **Delete-all and rollback.** A missing manifest read as "no guardrails" and
  a whole older signed set verified. A high-water mark (memory, a file beside
  the key, Redis) closes both; the cold-start case on a single process without
  Redis is the stated residual.
- **The key on deployments without guardrails** was created on the first
  snapshot read, so a read-only `$SLAUDE_HOME` broke boot. It is now touched
  only when a set exists or is written, and Postgres requires the master key.
- **Remote aliases.** The hook saw `mcp__remote__bash`, so a rule on `Bash`
  missed it in a remote thread; both names are matched now.
- **Inbound after a failed verification** fell back to no rules; it now drops
  the message with the unavailable notice.
- **The reaper** moved a dead capable node's job back to the label queue an
  older node consumes; jobs carry `requiresCaps` and are re-pinned to a
  capable node.
- **Node reports** chose their own `applied` value and were unbounded; the
  gateway now takes the action from its own rule, dedupes per job and
  rate-limits per session.
- **Broken rules** were stored silently dropped; they now refuse the deploy,
  the import and the render.

## What it does not do

Tool rules are a policy on named tools: a shell or fetch tool reaches the same
service another way, so a deny on an MCP send tool should be paired with a
Bash or WebFetch input rule. Inbound rules do not cover cron dispatch, panel
chat or `/compact`. The inbound reply's quiet window is per process.

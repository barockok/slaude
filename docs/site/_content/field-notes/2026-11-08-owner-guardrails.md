---
title: "Owner guardrails: rules the owner defines, enforced by code, signed as a set"
date: 2026-11-08
---

# Owner guardrails: rules the owner defines, enforced by code, signed as a set

**Date:** 2026-11-08
**Status:** Phase A1 shipped in `v0.46.0-rc.9` (branch `feat/owner-guardrails`).
Phase A2 (tool approve cards, one outbound choke point, reply rules) shipped in
`v0.46.0-rc.10` (branch `feat/owner-guardrails-a2`, section below);
phase B (console editing, the Test box, moving the soul and access settings to
the agent's tabs) shipped in `v0.46.0-rc.11` (branch `feat/owner-guardrails-b`,
section below). Design:
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

**A tool `approve` is enforced as a deny in rc.9** (rc.10 holds it on a card, below). Approval cards
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

**Moving from sqlite to Postgres needs the master key first.** Postgres has
no key-file fallback, so `SLAUDE_MASTER_KEY` must be set before the move (a
`/deploy` that changes guardrails without it is a 422, refused before any
persona is applied, never a half-applied 500). A `.high-water.json` that
survives the move remembers the sqlite version, so sessions refuse to start
until the owner runs `slaude guardrails import <dir> --repair` with the key,
which re-signs the set above that version. With `SLAUDE_REDIS_URL` set the
import reads and raises the Redis mark too, so a repair never lands below the
mark another replica saw.

## What it does not do

Tool rules are a policy on named tools: a shell or fetch tool reaches the same
service another way, so a deny on an MCP send tool should be paired with a
Bash or WebFetch input rule. Inbound rules do not cover cron dispatch, panel
chat or `/compact`. The inbound reply's quiet window is per process.

## Phase A2 (rc.10): approval cards and the outbound choke point

**The SDK premise was wrong, and the spike said so.** The design assumed the
SDK's hook timeout defaults to 60 s and that a timed-out hook lets the tool
run, so a card could never outlive its hook. A spike drove the real CLI
through `query()` against a small fake of the Messages API
(`tests/spike/`): an in-process callback hook waited 65 s with no matcher
timeout and its deny was honoured; a hook past its matcher timeout had its
signal aborted and the tool did not run. Two findings mattered more: a hook
that **throws** falls through and the tool runs, and hooks run concurrently
(a deny from any hook beats a slow allow). `ask` did reach `canUseTool` under
`bypassPermissions`, so both candidate approaches worked; the hook awaiting
the card won because it depends on the least SDK behaviour (an `ask` path
would also have had to force past our own auto-allow policy through a side
channel). Every finding is pinned by a test, so an SDK upgrade that changes
one fails CI. Full table: `docs/superpowers/specs/2026-11-08-owner-guardrails-a2-spike.md`.

**A timeout is our deny, not the SDK's.** The hook owns an inner deadline
(`SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC`, default 600 s) and the matcher timeout
sits 60 s above it, so the deny always carries the rule's message whatever the
SDK does at its own timeout. Every path out of the hook (the deadline, the
turn's abort, a thrown card, a resolver that answers nonsense) is a deny; the
whole hook body is wrapped so nothing can throw past it.

**On nodes the token is not extended.** The job token's 15 minutes is also
the node's hard turn deadline. Extending the token while a card waits would
have meant a second refresh path for a rare case; instead the node hands its
turn deadline to the hook, and a card ends 30 s before it (or is not opened
with under 5 s left). The node names the rule when it asks
(`force_card`, `rule_id`), and the gateway re-evaluates it from its own
verified set: a node cannot force a card the owner did not ask for.

**One card, not two.** Approving returns `allow` from the hook, which skips
`canUseTool`; otherwise in `default` mode the same call would ask again on an
ordinary card. The owner's card offers no *Always allow*: the rule asks every
time.

**The choke point is a registry as much as a function.** `outbound()` keeps
each path's old formatting (the surface and legacy slack tools convert to
mrkdwn and apply the soul's patterns; proactive posts and proposal previews
mask secrets; canvases were raw) so nothing changes until an owner rule
matches. What makes "every agent-authored path" checkable is
`OUTBOUND_SITES`: every Slack write call in `src/`, counted per file and
classified as agent text or runtime UI. A test scans the code and fails on a
new or moved call. The runtime's own texts that went through the surface (the
todo list, connect notices) pass `runtime: true` and are formatted only.

**A held reply must not appear where it was held from.** The approval card
goes to the session's thread, but the text goes to each approver privately;
an agent with no named approver (where the ApprovalGate would let anyone
click) refuses the hold instead. Wakes, proactive posts and proposal previews
have nobody to ask, so approve is a deny there.

**Streaming is edits.** There is no chunk stream to Slack: a "streamed"
reply is the agent editing one message. Each edit is judged on the whole new
text and replaces the message, so a pattern split across edits is caught and
redaction stays in sync. A pattern split across two messages is not, and the
reference says so.

### Review fixes before merge (A2)

- **A forced card skipped the policy's denies too.** Skipping the auto-allow
  policy for an owner card also skipped its hard denies (the synthesized OAuth
  tools, `voice_start`'s checks). Only the allows are skipped now, in the
  gateway's resolver, its node `open()` and the node resolver.
- **A held reply could outlive its turn.** The card now waits at most what is
  left of the turn (the job token's expiry less 30 s on the tool plane; the
  session's abort in mono), refuses with under 5 s left, and a reply is never
  posted after its turn ended, even when the approval comes later. A node that
  stops waiting on a tool card cancels it, so a late click cannot read
  *Approved*.
- **A streamed message re-held at every edit.** The decision is remembered per
  message and rule: an approved phrase stays approved while its matched text
  is unchanged; a declined one keeps the refusal note without new cards.
- **No approver meant a flashing placeholder.** Approvers are resolved first;
  with none named the reply is refused up front and audited as denied.
- **No guardrails, but every reply refused.** A failed or not-yet-loaded read
  refused replies on a deployment that has no guardrails at all. Only a set
  that exists (a stored version, or a high-water mark) fails closed now.
- **The trackers carried model text as runtime UI.** The todo and task lists
  go through the reply rules (kind `todo`).
- **Coverage by call, not by count.** Each Slack write line carries an
  `outbound:` or `runtime-ui:` marker, checked by the test.
- **Mixed versions.** An rc.9 gateway rejects a whole firing batch with the
  new `approved`/`refused` values; the node sends those separately. Upgrade
  gateways first.

## Phase B (rc.11): editing in the console, the Test box, the settings move out

**One write path, not a second one for the console.** Create, edit, override,
clear and delete all call `applyGuardrailChange`, the function `/deploy` and
the import already use. It grew three inputs (`setOverride`, `clearOverride`,
`expect`) instead of the console getting its own SQL; the old test seam that
wrote overrides by hand is now only a test seam. So everything the earlier
phases promised holds for console writes without being re-implemented: the
set re-signed in one transaction, the high-water mark raised, a write over a
set that fails to verify refused (the console answers 423 with the repair
command), and a rule that fails to parse refused (422) by the same `blocking`
list `/deploy` and the import use.

**A revision per guardrail, checked inside the transaction.** Optimistic
concurrency needed a version a writer can hold. The manifest version would
make every write conflict with any other; a per-guardrail revision is free:
the row and its override each already carry the manifest version of their
last write, so the guardrail's revision is the larger of the two. It moves
on a text change, an override and the switch. The check runs after the
locked read in the write's own transaction, so two concurrent saves cannot
both pass it.

**Edit what you own, override what you do not.** A console guardrail is
edited in place and can be deleted. A deploy repo or host-file guardrail is
never rewritten from the console: an edit is an override with the source's
sha, a delete is refused (switch it off, or remove it at the source). The
detail now carries the source text beside the override, so the console shows
a line diff against what the source says today, which is what an owner needs
when a sync marks the override behind source.

**Live validation is the server's parser, over the wire.** The parser uses
`Bun.YAML` and re2js; shipping a second YAML parser to the browser would be
a second parser that can drift. The editor posts the draft to
`/guardrails/validate` a moment after each change instead (no write, any
operator). It also measures the always-loaded prose cap with the draft in
place, and the answer was not what the obvious UI would say: prose loads in
name order, so the guardrail a draft "tips over" is often another one. The
editor names the guardrail actually left out, per agent.

**The Test box is the runtime, called without its side effects.** Rather
than a second matcher, `evaluateGuardrails` calls the same functions the hook,
the outbound choke point and the inbound check call (`sessionGuardrails`,
`toolHits`, `textHits`, `combine`, the on-match triggers); the redaction of a
reply and the inbound deny message moved into `match.ts` so all four share
them. A parity test puts the same tool calls, replies (formatted as real
replies are) and messages through the real hook, `outbound()` and
`inboundVerdict()` and checks the Test box reports the same decision, hits
and message. A draft replaces the stored guardrail of its name for that one
evaluation.

**The settings found their tabs.** The families folded under Guardrails since
rc.9 moved with their view-model functions unchanged (renamed
`settings-view.ts`) behind `GET /agents/:name/settings/:group`: approvals,
permission cards, admission and redaction on Access; the memory write tiers
and the profile guard on Memory; proactive restraint, wake tools and budgets
on Mandates, with the learned rules as their own request because their brain
read can time out and must not hold up the tab. The never-built *policy*
family is gone: owner guardrails are that policy now. With
`/guardrails/settings` gone, the reserved slug `settings` was dropped; `new`
and `test` are reserved instead because the console's own pages
(`/guardrails/new`, `/guardrails/test`) would otherwise be shadowed by a
guardrail of that name.

**Audit.** Console writes record `guardrail.created|updated|deleted` and the
new `guardrail.override.set|cleared` (no text), plus a `panel.guardrail.*`
row with the reload result; panel guardrail actions are console-wide rows now,
not the default agent's. The Test box leaves `guardrail.tested` with the
agent, kind, tool and decision, never the input or text it evaluated.


# Guardrails

> Rules you set for your agents, the way you set their souls: shared by every
> agent or for some, narrowed to channels if you like. Enforced rules are
> checked by code and never put in the prompt; Guidance is text the agent
> reads and is asked to follow.

This page is the operator reference for owner guardrails (`v0.46.0-rc.9`
onward). It mirrors `src/guardrails/*`; if code and this page disagree, code
wins and this page has a bug. The design is in the
[owner guardrails spec](https://github.com/barockok/slaude/blob/main/docs/superpowers/specs/2026-11-08-owner-guardrails.md)
and the [field note](../field-notes/2026-11-08-owner-guardrails.md).

On this page:

- [Two kinds of rule](#kinds)
- [GUARDRAIL.md](#format)
- [Examples](#examples)
- [Where guardrails come from](#sources)
- [What is enforced in this release](#enforced)
- [Tool rules are a policy on named tools](#named-tools)
- [Threat model](#threat-model)
- [Nodes](#nodes)
- [The console](#console)
- [Audit](#audit)
- [Limits](#limits)

The runtime's own layer (its hooks, gates and deny lists) is not an owner
guardrail. It lives in the code (`src/agent/guardrails.ts`, checked by a test
against the hooks real sessions are built with) and is not shown in the
console.

<a id="kinds"></a>
## Two kinds of rule

| | Enforced rules | Guidance |
|---|---|---|
| What | The fenced `rules` block: tool, reply and inbound rules | The markdown prose of the file |
| Who applies it | Code, on every event | The model, asked to follow it |
| In the prompt | Never. The model sees only the outcome: a refused tool call with the rule's message, a dropped message | Yes: always (`load: always`) or once per session when a trigger matches (`load: on-match`) |
| Console label | **Enforced** | **Guidance** |

Guidance with `load: always` sits in the system prompt as an
`<owner-guardrails>` block right after the soul (`<persona>`) and before the
channel mandate. Always-loaded Guidance is capped per agent
(`SLAUDE_GUARDRAIL_PROSE_MAX`, default 4000 characters): guardrails are taken in
name order while they fit, and one that would tip the total over is left out
of that agent's prompt. The console names it and the total. Its rules still
apply.

Guidance with `load: on-match` puts only a one-line index entry (`name:
description`) in the prompt. Code hands over the full text the first time a
trigger matches in a session, and only once per session (again after the
session restarts):

- a **tool trigger** refuses the first matching tool call once with "Read
  guardrail *name* first" and the text; the retry goes through. This refusal
  is delivery, not a decision: an enforced rule on the same tool still
  applies. In a wake or a background pass the turn cap grows by one per such
  guardrail, so a delivery never eats the budget.
- an **inbound trigger** adds the text to that turn's context once. The match
  happens on the gateway; on nodes the text travels with the job.

<a id="format"></a>
## GUARDRAIL.md

One guardrail is one `GUARDRAIL.md` in a folder named after it:

```
<deploy repo>/guardrails/<name>/GUARDRAIL.md
```

````markdown
---
name: no-outbound-email          # must equal the folder name
description: The agent drafts email but never sends it.
scope: shared                    # shared | agents
agents: []                       # agent names, with scope: agents
channels: []                     # only in these channel ids (empty: everywhere)
enabled: true                    # the author's switch (the console has its own)
load: always                     # always | on-match
triggers: {}                     # with on-match: { tool: [globs], inbound: pattern, channels: [ids] }
---

Guidance prose. Read by the model, advisory.

```rules
- id: no-send
  on: tool                       # tool | reply | inbound
  match:
    tool: "mcp__*__*send*"       # glob over the full tool name (or a list)
    input:                       # optional: a pattern per field (dot path) ...
      to: "(?i)@external\\.example$"
  action: deny                   # deny | approve | redact | audit
  message: "Sending email is not allowed; save a draft instead."
```
````

Fields and rules:

- `scope: shared` applies to every agent, the default agent included.
  `scope: agents` applies to the agents named in `agents`. A name that no
  agent has is flagged in the console, and so is a guardrail that applies to
  no agent.
- `channels` limits the whole guardrail (rules and Guidance) to those channels.
  A session with no channel (a background pass) gets only unlimited
  guardrails.
- `on` and `action` pairs: `tool` takes `deny`, `approve`, `audit`; `reply`
  takes `deny`, `approve`, `redact`, `audit`; `inbound` takes `deny`, `audit`.
- Tool `input` is either a map of dot paths to patterns (every listed field
  must match; a numeric segment indexes a list) or one pattern tried against
  every string value of the input. Never against the serialised JSON, so a
  pattern never matches a key name or another field.
- `text` (reply and inbound rules) is matched against the message text.
- In a remote thread the CLI reports a remote alias (`mcp__remote__bash`); a
  rule written for the builtin (`Bash`) matches it, and the other way round.
- Every pattern is an RE2 pattern (the `re2js` engine): linear time, no
  backtracking, so backreferences and lookaround are refused. Patterns run in
  dotall mode (`.` crosses newlines); use `(?i)` for case-insensitive.
- Strings are matched whole up to 1 MB each (RE2 is linear, so the cost is
  bounded). Padding cannot hide a value: a string over 1 MB, or a tool input
  over 10,000 values, 32 levels deep or 4 MB of text, is *too large to check*,
  and that counts as a match for `deny` and `approve` rules (refused with "too
  large for the owner's guardrail ... to check"). `audit` rules stay best
  effort.
- When several rules match one event, the strictest action decides (deny >
  approve > redact > audit); every match is recorded, and the message shown is
  the deciding rule's. An empty `message` gets a default naming the guardrail.

Parsing is deterministic (YAML and a schema, no model). A rule that fails to
parse, a rules block that cannot be read, or frontmatter that cannot be read
in a file with rules (its rules would apply to nobody) **refuses the write**:
`/deploy` answers 422, `slaude guardrails import` exits 1 and
`personas render` fails the pull request. An owner who wrote a rule meant it
to be enforced; storing it silently dropped would be the opposite. Other
problems (a name that differs from the folder, a trigger with the wrong
`load`) are warnings: the guardrail is stored, marked as having problems, and
its rules and Guidance apply.

<a id="examples"></a>
## Examples

**Enforced: no outbound email, paired with the shell** (see
[named tools](#named-tools)):

````markdown
---
name: no-outbound-email
description: The agent drafts email but never sends it.
---
Draft email for people to send. Never send it yourself.

```rules
- id: no-send
  on: tool
  match: { tool: "mcp__*__*send*" }
  action: deny
  message: "Sending email is not allowed; save a draft instead."
- id: no-mail-from-shell
  on: tool
  match: { tool: Bash, input: { command: "(?i)\\b(sendmail|mail|mutt|curl .*smtp)" } }
  action: deny
  message: "Sending email from the shell is not allowed either."
```
````

**Enforced: no passwords in messages to one agent:**

````markdown
---
name: no-secrets-in
description: People should not paste passwords to triage.
scope: agents
agents: [triage]
---
```rules
- id: no-passwords
  on: inbound
  match: { text: "(?i)password\\s*[:=]" }
  action: deny
  message: "Please do not paste passwords here."
```
````

The message is dropped before any turn and the person gets the rule's message
as a thread reply, at most once per person per thread per 10 minutes
(`SLAUDE_GUARDRAIL_REPLY_QUIET_SECS`); later drops are silent and audited.

**Guidance, always loaded:**

```markdown
---
name: house-style
description: How replies sound.
---
Sign replies as the team, never as yourself. Keep answers under ten lines.
```

**Guidance on match:**

```markdown
---
name: invoice-care
description: How invoices are handled
load: on-match
triggers: { inbound: "(?i)invoice", tool: ["mcp__*__*invoice*"] }
---
Invoices go to the finance team. Never promise a payment date.
```

<a id="sources"></a>
## Where guardrails come from

The database is the only runtime source: files are authoring input, and a
session never reads guardrail files.

- **The deploy repo.** A `guardrails/` folder next to `personas/`.
  `bun run personas render <dir>` carries it in the `/deploy` payload as a
  top-level `guardrails` list (payload version 5 when it holds any guardrail;
  a gateway older than this release refuses the payload instead of dropping
  them). A folder that exists, even empty, is the whole set: a guardrail it no
  longer lists is removed. No folder leaves the stored set as it is. A
  guardrail of the same name imported from host files is taken over by the
  deploy repo (reported); one held by the console is left alone (reported).
- **Host files.** `slaude guardrails import <dir> [--prune] [--dry-run] [--repair]` on
  the gateway or mono host stores `<dir>/<name>/GUARDRAIL.md` folders (or a
  deploy repo's `guardrails/` folder). `--prune` removes host-file guardrails
  the folder no longer has; deploy repo guardrails are never touched by an
  import. A running server picks the change up within its poll (about 10
  seconds). `--repair` is for the owner after the stored set failed its
  integrity check: it imports the folder and re-signs every stored guardrail
  as it is, at a version above any seen before (audited `guardrail.repaired`;
  the report lists what was re-signed without new text, to check, and a
  `/deploy` afterwards restores deploy repo guardrails).
- **The console** (phase B): editing, overrides, create and delete. An
  override is kept across syncs and flagged *behind source* when the source
  text changes after it was written, so a sync never silently drops a safety
  rule.

Every change bumps the set's version and announces a config reload: nodes drop
cached bundles and warm sessions reload after their turn.

<a id="enforced"></a>
## What is enforced in this release

| Rule | rc.9 | Later |
|---|---|---|
| tool deny, audit | Enforced in every session kind: threads, wakes, remote threads, background passes. A PreToolUse hook, so it holds in every permission mode, bypass included. | |
| tool approve | Enforced as **deny** until approval cards exist | rc.10: an approval card |
| inbound deny, audit | Enforced before the turn | |
| reply rules | Stored, parsed and shown as *Not yet enforced* | rc.10: one outbound choke point for every reply, edit, upload caption and proactive post |
| Guidance (always, on-match) | Delivered | |

Not covered by inbound rules: cron dispatch, panel chat and `/compact`.

A session that cannot read or verify the stored set does not start
(`GUARDRAILS_UNAVAILABLE`, audited as `guardrail.integrity.failed`); it never
runs with an empty set.

Defence in depth: the file tools (Write, Edit, MultiEdit, NotebookEdit) are
refused under `$SLAUDE_HOME/guardrails` and on the database file, and Read,
Grep and Glob of the signing key file are refused
(`hook.pre-tool.guardrail-files`; paths compare case-insensitively on macOS
and Windows). No MCP tool writes guardrail rows.

An inbound message that arrives while the stored set fails to verify is
dropped with the "guardrails could not be read or verified" notice; it never
falls back to an older snapshot.

<a id="named-tools"></a>
## Tool rules are a policy on named tools

A tool rule matches tool names. A shell or a fetch tool can reach the same
service another way, so a `send` deny on an MCP tool is best paired with a
`Bash` or `WebFetch` input rule (as in the first example), or with remote
mode's deny list. Owner guardrails narrow what the agent does through named
tools; they are not a sandbox.

<a id="threat-model"></a>
## Threat model

Every stored guardrail row carries an HMAC, and one manifest row signs the
whole set, written in the same transaction as every change. A deleted row, a
replayed older row, an added row or an edited one fails the check, and
sessions refuse to start. A write checks the stored set first and refuses one
that does not verify, so a later write can never re-sign tampering into a
valid set (only the owner's `--repair` re-signs).

The key comes from `SLAUDE_MASTER_KEY`. On sqlite without a master key, a key
file under `$SLAUDE_HOME/guardrails` is created on the first write; on
Postgres the master key is required. A deployment with no guardrails never
reads or creates the key, so it boots on a read-only `$SLAUDE_HOME` as before.

A whole signed set can still be replayed (an older manifest with its rows) or
deleted (no manifest at all). A **high-water mark** closes that: the highest
manifest version seen, kept in the process, in a file beside the key
(`.high-water.json`) and in Redis on cluster deployments. A set older than
the mark, or missing after one existed, fails closed. Residual risk on a cold
start of a single process without Redis: whoever can rewrite both the
database and the mark file can roll back or delete the set undetected.
`slaude guardrails import` (and `--repair`) reads and raises the mark in
Redis too when `SLAUDE_REDIS_URL` is set, so a repair never lands below it.

**Moving from sqlite to Postgres.** Set `SLAUDE_MASTER_KEY` first: on
Postgres guardrails are signed with the master key only, and a `/deploy` that
changes guardrails without it is refused (422) before any persona is applied.
The rows signed on sqlite with the key file do not verify under the master
key, and a `.high-water.json` that survives the move still holds the sqlite
version, so sessions refuse to start until the owner runs
`slaude guardrails import <dir> --repair` with the master key set (re-signing
the set above the remembered version), then a `/deploy` for the deploy repo's
guardrails.

- **Postgres, or turns on nodes:** a session cannot reach the database, so an
  agent cannot change its own guardrails.
- **One process on the default sqlite database under `$SLAUDE_HOME`:** a
  session's shell can reach the database file and the key file. There the
  design protects against drift and accidental edits, and tampering is
  detected (fail closed), but it does not stop an adversarial agent from
  stopping its own sessions. The console shows which mode the deployment is
  in.

<a id="nodes"></a>
## Nodes

The guardrails that apply to an agent ride in the tenant runtime bundle a
node already reads for the soul, and the set's version is an explicit input of
the bundle's ETag. Nodes advertise a `guardrails/1` capability on their
heartbeat and on every bundle fetch:

- the gateway refuses the bundle of an agent with enforced rules to a node
  without the capability (`guardrail.node.unsupported`), so an older node can
  never run that agent's turns without its rules;
- the dispatcher sends such an agent's turns only to capable nodes (in a
  mixed fleet, to a capable node's own queue). With none, the turn waits up to
  the unserved-label threshold (`SLAUDE_LABEL_UNSERVED_SECS`, default 60 s),
  then the thread gets a notice instead of a silent queue.

Firings on a node are recorded by the gateway, which accepts only guardrails
and rules its own verified set applies to that agent, takes the action from
its own rule (never the node's claim), records an identical event once per
job and rate-limits each session. When a node goes away, a turn that needs
the capability is moved only to another capable node's queue, never back to
the label queue.

<a id="console"></a>
## The console

**Resources > Guardrails** lists every guardrail: scope (*Every agent* or the
agents it names, and channels), rules by kind (*Enforced*, *Not yet
enforced*, *Guidance*), source (*Deploy repo*, *Host file*, *Console
override*, *Behind source*), status (on or off, problems, applies to no
agent, over the prose cap) and when it last fired. A guardrail's page shows
its `GUARDRAIL.md` (Rendered, Raw, Copy), the parsed rules, validation
problems, the agents and channels it applies to, its Guidance and triggers,
and its recent firings. Each agent page has a **Guardrails** tab with what
applies to that agent, shared and its own.

A superadmin can switch a guardrail off and on (one audited write, then a
config reload). Operators read everything and cannot switch. Editing is phase
B. The soul and access settings that used to be on this page are in a
collapsed *Soul and access settings* section until they move to the agent's
own tabs.

<a id="audit"></a>
## Audit

| Action | When |
|---|---|
| `guardrail.tool.denied`, `guardrail.tool.audited` | A tool rule matched (every match, the deciding one marked) |
| `guardrail.inbound.denied`, `guardrail.inbound.audited` | An inbound rule matched |
| `guardrail.guidance.delivered` | On-match Guidance was handed to a session |
| `guardrail.created`, `guardrail.updated`, `guardrail.deleted` | A sync, an import or the console switch changed the set |
| `guardrail.repaired` | An owner re-signed the set with `slaude guardrails import --repair` |
| `guardrail.node.unsupported` | A node without the capability was refused, or no capable node took a turn in time |
| `guardrail.integrity.failed` | The stored set did not verify; sessions do not start |

Target: `guardrail <name>#<rule id>`. Details name the agent, channel, tool
and rule, never the tool input or the message text: a row whose pattern
matched never stores the text it matched.

<a id="limits"></a>
## Limits

| Limit | Value |
|---|---|
| One `GUARDRAIL.md` | 64 KB |
| Rules per guardrail | 50 (the rest are rejected) |
| Pattern length | 512 characters; a tool glob 256 |
| Text a pattern sees | each string whole up to 1 MB; a tool input up to 10,000 values, 32 levels deep and 4 MB of text. Past any bound: a match for deny and approve rules |
| Input fields per rule | 20 |
| Guardrails per deploy repo or import | 200 |
| Always-loaded Guidance per agent | `SLAUDE_GUARDRAIL_PROSE_MAX`, default 4000 characters |
| Inbound reply quiet window | `SLAUDE_GUARDRAIL_REPLY_QUIET_SECS`, default 600 |

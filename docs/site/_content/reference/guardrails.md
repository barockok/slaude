# Guardrails

> Rules you set for your agents, the way you set their souls: shared by every
> agent or for some, narrowed to channels if you like. Enforced rules are
> checked by code and never put in the prompt; Guidance is text the agent
> reads and is asked to follow.

This page is the operator reference for owner guardrails (`v0.46.0-rc.9`
onward; tool approval cards and reply rules from `rc.10`; console editing,
overrides and the Test box from `rc.11`). It mirrors `src/guardrails/*`; if code and this page disagree, code
wins and this page has a bug. The design is in the
[owner guardrails spec](https://github.com/barockok/slaude/blob/main/docs/superpowers/specs/2026-11-08-owner-guardrails.md)
and the [field note](../field-notes/2026-11-08-owner-guardrails.md).

On this page:

- [Two kinds of rule](#kinds)
- [GUARDRAIL.md](#format)
- [Examples](#examples)
- [Where guardrails come from](#sources)
- [What is enforced in this release](#enforced)
- [Tool approve: the approval card](#tool-approve)
- [Reply rules: the outbound choke point](#reply-rules)
- [Tool rules are a policy on named tools](#named-tools)
- [Threat model](#threat-model)
- [Nodes](#nodes)
- [The console](#console)
- [Editing in the console](#editing)
- [Overrides and behind source](#overrides)
- [The Test box](#test-box)
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
| In the prompt | Never. The model sees only the outcome: a refused or held tool call, a refused, held or redacted reply, a dropped message | Yes: always (`load: always`) or once per session when a trigger matches (`load: on-match`) |
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
- **The console** (`rc.11`, superadmin): create a guardrail, edit one,
  override a deploy repo or host-file guardrail, clear an override, delete a
  console guardrail ([below](#editing)). An override is kept across syncs and
  flagged *behind source* when the source text changes after it was written,
  so a sync never silently drops a safety rule. A sync or an import never
  touches a guardrail created in the console (reported when one names it).

Every change bumps the set's version and announces a config reload: nodes drop
cached bundles and warm sessions reload after their turn.

<a id="enforced"></a>
## What is enforced in this release

| Rule | Since | How |
|---|---|---|
| tool deny, audit | rc.9 | Every session kind: threads, wakes, remote threads, background passes. A PreToolUse hook, so it holds in every permission mode, bypass included. |
| tool approve | rc.10 | The call waits on a permission card for the requester or an approver ([below](#tool-approve)). In rc.9 it was a deny. |
| inbound deny, audit | rc.9 | Before the turn |
| reply deny, approve, redact, audit | rc.10 | At the outbound choke point, on every agent-authored post ([below](#reply-rules)). In rc.9 these were stored and shown as *Not yet enforced*. |
| Guidance (always, on-match) | rc.9 | Delivered |

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

<a id="tool-approve"></a>
## Tool approve: the approval card

A tool rule with `action: approve` holds the call on a permission card in the
session's thread, with the rule named and only **Allow once** and **Deny**
(no *Always allow*: the next matching call asks again). The person who asked
(the sole Slack sender of the turn), the thread's /1on1 owner, or an approver
or manager of the agent decides, as for any permission card; anyone else's
click is refused. The card is shown in every permission mode, bypass
included, and whatever the auto-allow list says: the rule skips the
auto-allow policy's allows. It never skips its denies: the synthesized OAuth
tools and `voice_start`'s checks are still refused with no card.

- **Allowed:** the call runs. No second, ordinary permission card follows.
- **Denied, timed out, or the turn stopped:** the call is refused with the
  rule's message and the reason ("Not approved: denied by ...", "no decision
  in time"). A timeout or any error is always a deny, never an allow.
- **Nobody to ask:** in a wake or a background pass approve is a deny at once,
  with no card.
- **How long:** `SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC` (default 600, at most
  3600). The hook that holds the call owns this deadline and denies when it
  passes; the SDK's own hook timeout is set above it.
- **On nodes** the card is capped by the turn: the job token lifetime (15
  minutes) is also the node's turn deadline, and the token is not extended
  while a card waits. A card ends 30 seconds before the turn's deadline or at
  the timeout above, whichever is first; with less than 5 seconds left no card
  is opened and the call is refused. The node asks the gateway for the card
  naming the rule, and the gateway opens it only when its own verified set
  says that rule applies to the agent and channel, is a tool approve rule and
  matches the call. When the node stops waiting (its deadline, the turn
  stopped) it cancels the card, so a late click cannot show *Approved* on a
  call that was refused.
- On-match Guidance for the same tool is delivered first; the card comes on
  the retry.
- Another hook (the skill gate, the file protection) can still refuse a call
  while its card is open; the call stays refused.

How this was decided: [the A2 spike](https://github.com/barockok/slaude/blob/main/docs/superpowers/specs/2026-11-08-owner-guardrails-a2-spike.md)
(the SDK behaviour it relies on is pinned by `tests/spike/sdk-hooks.test.ts`).

<a id="reply-rules"></a>
## Reply rules: the outbound choke point

Every post the agent writes goes through one function,
`outbound()` in `src/gateway/slack/outbound.ts`. It formats the text as that
path always has (markdown to Slack's format, the soul's redact patterns,
secret masking), then applies the agent's reply rules to the text as it would
be posted. With no rule matching the result is exactly what the path posted
before.

| Action | What happens |
|---|---|
| deny | Nothing is posted. The tool returns an error with the rule's message. |
| redact | Every match becomes `[REDACTED]` (the soul's marker), then it is posted. Every matching redact rule applies, whatever action decides. |
| audit | Posted as is; recorded. |
| approve | The agent's approvers are resolved first: with none named, the reply is refused at once (audited as denied, nothing posted). Otherwise a *waiting for approval* placeholder is posted, an approval card goes to the approvers in the session's thread, and the held text is sent to each approver privately (never into the thread). Allowed: the placeholder becomes the reply. Denied, timed out or the turn stopped: it becomes a short *Not posted* note. The tool returns the outcome. A wake, a background pass and a proactive post have nobody to ask, so approve is a deny there. |

**A held reply lives no longer than its turn.** The card waits the
persona's approval timeout, `SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC`, or what
is left of the turn, whichever is shortest: on nodes the turn ends 30 s
before the job token expires; in mono a stopped turn cancels the card. With
under 5 s left nothing is held (the reply is refused), and a reply is never
posted after its turn ended, even when the approval arrives afterwards.

A reply that is edited as it is written (a streamed message) is judged on the
whole new text at every edit, and the whole message is replaced, so a pattern
split across edits is still caught and redaction stays in sync. A held phrase
is asked about once per message: once approved, later edits that keep the same
matched text go out without a new card (a changed phrase is asked again); once
declined, the message keeps its *Not posted* note and later edits that still
match are refused with no new card. A pattern split across two separate
messages is not caught.

Covered, in mono and on nodes (a node's posts run on the gateway through the
tool plane's surface executor, which is the same code):

| Path | Kind |
|---|---|
| `reply` (surface and legacy slack tools) | `reply` |
| `edit` | `edit` |
| `upload` caption | `upload_caption` (a held caption waits for the card, then the file goes out with it) |
| `post_message` | `post_message` |
| `post_ephemeral` | `ephemeral` (cannot be held in place: posted after the card) |
| `proactive_post` (wakes and the heartbeat round) | `proactive_post` (approve is a deny) |
| proposal previews on digest and DM cards | `proposal_preview` (deny or approve hides the preview) |
| `create_canvas`, `append_canvas`, `prepend_canvas` | `canvas` |
| `set_topic`, `set_purpose` | `topic` |
| the todo and task list messages (the runtime renders them from the model's items) | `todo` (redact applies; a list a rule refuses or would hold is shown as hidden) |

Not covered (runtime UI, not written by the agent): permission and approval
cards, the status line, slash command and
`/remote` replies, connect cards and notices, the turn failure text, the
inbound guardrail reply, the panel hand-off notice, the promise check's fixed
line, the feedback acknowledgement and the digest's own text. Every Slack
write in the code (chat, file writes, canvases, topic and purpose, views,
`apiCall` and an interaction's `respond`) carries an `// outbound:` or
`// runtime-ui:` marker on its line, and a test
(`tests/gateway/outbound-sites.test.ts`) fails on any write without one.

A stored set that exists and cannot be read or verified refuses every agent
post (the same notice as a session that cannot start); runtime UI still goes
out. A deployment with no guardrails (no stored set, never had one) posts
exactly as before, even when a read fails or no snapshot has loaded yet.

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
agents it names, and channels), rules by kind (*Enforced*, *Guidance*;
*Not yet enforced* only from an rc.9 gateway), source (*Deploy repo*, *Host file*, *Console
override*, *Behind source*), status (on or off, problems, applies to no
agent, over the prose cap) and when it last fired. A guardrail's page shows
its `GUARDRAIL.md` (Rendered, Raw, Copy), the parsed rules, validation
problems, the agents and channels it applies to, its Guidance and triggers,
and its recent firings. Each agent page has a **Guardrails** tab with what
applies to that agent, shared and its own.

A superadmin can switch a guardrail off and on (one audited write, then a
config reload), and edit ([below](#editing)). Operators read everything,
validate a draft and use the Test box; every write answers them 403.

The soul and access settings that were folded under this page until `rc.10`
now live where they apply: approvals (with scope words and the approval
timeout), permission cards (who decides, threads per permission mode),
admission and grants, and redaction on the agent's **Access** tab; the memory
write tiers and the profile guard in the **Memory** page's *Write rules*
section (per agent); proactive restraint and caps, the wake tool allow-list,
budgets and the learned rules on the agent's **Mandates** tab. They come from
`GET /panel/api/agents/:name/settings/:group` (`access`, `memory`,
`mandates`, `learned-rules`; the learned rules have their own request because
reading them from the brain can time out). `/panel/api/guardrails/settings`
is gone.

<a id="editing"></a>
## Editing in the console

Superadmin only. Every write goes through the same storage function as
`/deploy` and `slaude guardrails import`, so the same rules hold: the set is
re-signed in one transaction (rows, manifest, high-water mark), a rule that
fails to parse refuses the write, and a write while the stored set fails to
verify is refused. After a write that changed something, the console
announces a config reload exactly like the switch: nodes drop cached bundles
and warm sessions reload after their turn.

- **New guardrail** (*Resources > Guardrails > New guardrail*): a name (it
  becomes the folder name and cannot change later) and a template to start
  from: *Enforced rule examples* (deny a tool, ask an approver before a tool
  runs, redact or hold replies, refuse an incoming message) or *Guidance*
  (in every prompt, or when it becomes relevant). The source is *Console*.
- **Edit.** A console guardrail's own text changes. A deploy repo or host-file
  guardrail is edited as an **override** ([below](#overrides)); its source
  text stays as synced.
- **Clear override.** The source text applies again.
- **Delete.** Console guardrails only. A deploy repo or host-file guardrail
  cannot be deleted from the console: switch it off, or remove it at its
  source.

The editor checks the text as you type with the server's own parser
(`POST /panel/api/guardrails/validate`, no write): errors that refuse a save
are shown inline and disable *Save*; other problems (a name that differs, a
trigger with the wrong `load`) are shown and do not block; names in `agents:`
that no agent has are flagged; and the always-loaded Guidance is measured
against the prose cap, naming per agent the guardrail the draft would leave
out (prose loads in name order, so the one that tips the total over may be
another guardrail, not the draft). The server checks again on save.

Each write carries the guardrail's **revision** as the editor loaded it (the
set version of its last change: text, override, clearing an override or the
switch; it only ever goes up, since clearing an override re-signs the source
row at the new version). If someone else
changed it in between, the save is refused and the editor offers to reload
the saved version, keeping your edits to copy.

| Route (superadmin) | Does |
|---|---|
| `POST /panel/api/guardrails` `{ slug, md }` | Create a console guardrail (201) |
| `PUT /panel/api/guardrails/:slug` `{ md, revision }` | Edit; a deploy repo or host-file guardrail gets an override |
| `DELETE /panel/api/guardrails/:slug/override?revision=` | Clear the override |
| `DELETE /panel/api/guardrails/:slug?revision=` | Delete a console guardrail |
| `PUT /panel/api/guardrails/:slug/enabled` `{ enabled }` | The switch (since rc.9) |

| Refusal | When |
|---|---|
| 403 | Not a superadmin |
| 404 | No such guardrail; clear: it has no override (`code: no-override`) |
| 409 `code: stale` | The revision moved since it was loaded (the body has the current one) |
| 409 `code: exists` | Create: the name is taken |
| 422 `code: invalid` | A rule or the file fails to parse (`blocking` lists why), or the name is bad or reserved |
| 422 `code: not-deletable` | Delete: a deploy repo or host-file guardrail |
| 423 `code: integrity` | The stored set does not verify; the body's `hint` is the repair: find what changed it, then `slaude guardrails import --repair <dir>` on the host |

The names `new` and `test` are reserved for the console's own pages
(`/guardrails/new`, `/guardrails/test`): a **new** guardrail cannot take them,
from the console, the deploy repo or an import. A guardrail already stored
under one of them (from before they were reserved) keeps working: `/deploy`
and imports update it, the API reaches it at its usual routes, and the
console shows it at `/guardrails/~/<name>`. `settings`, reserved in `rc.9`
and `rc.10` for the route that is now gone, is a valid name again.

<a id="overrides"></a>
## Overrides and behind source

An override is a console edit of a deploy repo or host-file guardrail, stored
beside it (`guardrail_overrides`) with the sha of the source text it was
written against, signed and listed in the manifest like every row. Its text is
what applies. A `/deploy` or an import that changes the source keeps the
override and marks it **Behind source** (the source sha no longer matches),
in the list and on the guardrail's page. The page shows the override as a
line diff against the current source text, so an owner sees what the sync
brought and what the override still changes; then either edit the override
(saving it records the new source sha, and it is no longer behind) or clear
it.

<a id="test-box"></a>
## The Test box

On every guardrail's page, under the editor (with the unsaved text) and as
*Test a guardrail* on its own page. Pick the event (a tool call with its name
and JSON input, a reply text or an inbound message), the agent and
optionally a channel, and optionally an unsaved draft that replaces the
stored guardrail of the same name (or is added when it is new). A draft of a
guardrail that is switched off is tried as if it were on, and the result
says so. For a tool call, *In a thread bound with /remote* matches every name
the tool goes by there, as the session does (a rule on `Bash` holds for
`mcp__remote__bash` and the other way round); a remote alias name implies it.
The input and the text are accepted up to just past what a pattern checks
(1 MB), so *too large to check* still shows. While the stored set does not
verify, the Test box answers 423 with the runtime's fail-closed result (no
session starts, every agent post is refused) instead of evaluating an older
set. It shows:

- every rule that matches across the agent's effective set there, and the
  deciding action (the strictest wins: deny > approve > redact > audit) with
  the message the agent or the person would see;
- what the runtime would do (refused, held on a card, posted as redacted,
  not passed on), and a reply as it would be posted;
- the Guidance that loads in that agent's prompt, what the prose cap leaves
  out, and on-match Guidance the event would deliver;
- **too large to check** hits: past a size bound a deny or approve rule
  counts as matched.

It is the runtime's own code (`evaluateGuardrails` in
`src/guardrails/evaluate.ts` calls the same resolution and matcher functions
as the PreToolUse hook, the outbound choke point and the inbound check; a
test puts the same inputs through all of them). A reply is formatted as a
real one first. Nothing is posted, held, run or delivered; the only trace is
a `guardrail.tested` audit row naming the agent, kind, tool and decision,
never the text or input tested. Any operator can use it
(`POST /panel/api/guardrails/test`).

<a id="audit"></a>
## Audit

| Action | When |
|---|---|
| `guardrail.tool.denied`, `guardrail.tool.audited` | A tool rule matched (every match, the deciding one marked) |
| `guardrail.tool.approved`, `guardrail.tool.refused` | An approve rule held a call: approved on the card, or not (denied, timed out, nobody to ask). The card's own `gate.*` rows name who decided. |
| `guardrail.reply.denied`, `guardrail.reply.held`, `guardrail.reply.redacted`, `guardrail.reply.audited` | A reply rule matched a post; details name the kind of post. A held reply's decision is the approval card's own row. |
| `guardrail.inbound.denied`, `guardrail.inbound.audited` | An inbound rule matched |
| `guardrail.guidance.delivered` | On-match Guidance was handed to a session |
| `guardrail.created`, `guardrail.updated`, `guardrail.deleted` | A sync, an import or the console (an edit, a create, a delete, the switch) changed the set |
| `guardrail.override.set`, `guardrail.override.cleared` | A console override was written or cleared |
| `guardrail.tested` | The Test box ran (agent, kind, tool and decision only) |
| `guardrail.repaired` | An owner re-signed the set with `slaude guardrails import --repair` |
| `guardrail.node.unsupported` | A node without the capability was refused, or no capable node took a turn in time |
| `guardrail.integrity.failed` | The stored set did not verify; sessions do not start |

Target: `guardrail <name>#<rule id>`. Details name the agent, channel, tool
and rule (and the kind of post), never the tool input or the message text: a
row whose pattern matched never stores the text it matched. A console write
also leaves a `panel.guardrail.*` row (the panel action and the reload
result); neither stores the guardrail's text.

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
| Approval card wait (tool approve, held replies) | `SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC`, default 600, at most 3600; on nodes also 30 s before the turn deadline (15 minutes) |

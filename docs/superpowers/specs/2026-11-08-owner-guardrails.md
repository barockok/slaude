# Owner-defined guardrails (design)

Status: approved after review 2, revised after an independent review (review 3) and the operator's loading model. Supersedes the console part of the rc.7 "guardrails runtime layer" work and the
unbuilt Tier 2/3 policy design (field note 2026-05-21), keeping only its `policyCheck` hook shape.

## Problem

The console's Guardrails page shows slaude's built-in runtime layer (prompt stack, hooks, deny lists). Every
agent on every deployment sees the same thing, and nothing on it is the owner's. The owner wants guardrails
they define, like they define the soul: their own rules for what an agent may do, say and accept. A guardrail
is a resource, like a skill: it can be shared (every agent of the deployment) or attached to specific agents,
and narrowed to channels.

## Decisions taken with the operator

- Owner guardrails are reusable resources (Resources > Guardrails, next to Skills), shared or per agent.
- First version enforces four kinds: tool rules, reply rules, inbound rules, plain-language rules.
- The built-in runtime layer leaves the console. It stays in code: `src/agent/guardrails.ts` and its
  agreement test remain as an internal drift check; the console sections and the API fields added in rc.7
  (`promptStack`, `baseline`, `builtinSkills`, `guardrails`) are removed.
- GUARDRAIL.md is the authoring format, used in the deploy repo's `guardrails/` folder and by
  `slaude guardrails import`; the database is the only runtime source (never a file watcher).

## 1. The guardrail resource

One guardrail = one `GUARDRAIL.md` (authoring format; stored in the database, see section 2):

```
<deploy repo>/guardrails/<slug>/GUARDRAIL.md
```

```markdown
---
name: no-outbound-email
description: The agent drafts email but never sends it.
scope: shared            # shared | agents
agents: []               # persona names when scope: agents
channels: []             # optional: limit to these channel ids (empty = everywhere)
enabled: true
load: always             # always | on-match (Guidance delivery, section 1b)
triggers: {}             # with load: on-match, e.g. { tool: ["mcp__*__*send*"], inbound: "(?i)invoice" }
---

Guidance (prose). With load: always it is added to the prompt of every agent this guardrail applies to,
right after the soul; with load: on-match it is delivered once per session when a trigger matches.
Advisory: the model is asked to follow it; nothing in code enforces prose. The rules block below is Enforced.

```rules
- id: no-send
  on: tool                       # tool | reply | inbound
  match:
    tool: "mcp__*__*send*"       # glob over the full tool name
    input:                       # optional: regex per input field (dot path into the tool input)
      to: "(?i)@external\\.example$"
  action: deny                   # deny | approve | redact | audit
  message: "Sending email is not allowed; save a draft instead."
- id: no-prices
  on: reply
  match:
    text: "(?i)\\b(price|quote)\\b.*\\$\\d"     # patterns run with (?s): . crosses newlines
  action: approve
  message: "Replies with prices need an approver."
- id: no-secrets-in
  on: inbound
  match:
    text: "(?i)password\\s*[:=]"
  action: deny
  message: "Please do not paste passwords here."
```
```

- Frontmatter and the fenced `rules` block are parsed deterministically (YAML, zod schema). No LLM
  extraction: exact rules need exact parsing (unlike the soul's extraction pass).
- Tool `input` matching: either a map of dot paths to patterns (each matched against that field's string
  value), or a single pattern matched against every string value of the input. Never against the serialised
  JSON. Patterns run in dotall mode by default.
- `on`/`action` combinations in v1:
  - `tool`: deny, approve, audit. (redact on tool input is out of scope.)
  - `reply`: deny, approve, redact, audit.
  - `inbound`: deny, audit. (approve on inbound would hold a person's message; out of scope for v1.)
- Regexes run on a linear-time engine (`re2js`), so no pattern can backtrack catastrophically; patterns are
  length-capped and compiled once. Strings are matched whole up to a large cap (1 MB each); the walk over a
  tool input is bounded (values, depth, total text). Past any bound the input is too large to check, and that
  counts as a match for deny and approve rules (fail closed, "too large to check"); audit rules stay best
  effort. Padding therefore cannot hide a value. Each guardrail has a rule-count cap. A rule that fails to
  parse refuses the write (a `/deploy` 422, an import exit 1); other validation problems mark the guardrail
  invalid while its rules and prose still apply.

## 1b. Two kinds of rule, and how each loads

- **Enforced rules** (the `rules` block: tool, reply, inbound) are never put in the prompt. Code checks them on
  every event and applies the action; the model only sees the outcome (a denied tool with the rule's message, a
  refused or redacted reply). Labelled **Enforced** everywhere in the console.
- **Guidance** (the markdown prose) is read by the model and is advisory. Labelled **Guidance**. Frontmatter
  `load` picks how it reaches the model:
  - `load: always` (default): in the system prompt as `<owner-guardrails>` after `<persona>` and before
    `<channel-mandate>`. A deployment-wide size cap on always-loaded prose (default 4000 characters per
    agent) keeps the prompt lean; over the cap the guardrail that tips it over is not loaded and the console
    names it and the total, so it does not look like a parse error.
  - `load: on-match` with `triggers:` (`tool:` globs, `inbound:` text pattern, `channels:`): the prompt carries
    only a one-line index entry (`name`: description). Code delivers the body the first time a trigger
    matches in a session and marks it delivered for that session, so it is delivered at most once per session
    (again after a session reboot):
    - tool trigger: the first matching tool call is refused once with "Read guardrail <name> first" and the
      body in the refusal (the SkillGate pattern, `src/agent/skill-gate.ts`); the retry proceeds. This
      refusal is delivery only, not a decision; an enforced rule on the same tool still applies. A delivery
      refusal does not count against a wake's or background pass's turn budget.
    - inbound trigger: the body is added once to that turn's prompt as additional context (the session-notes
      path, `src/agent/session-notes.ts`). The match happens on the gateway, so on node deployments the
      delivery travels with the job payload rather than being looked up on the node.
  - Delivery is code-driven, never left to the model choosing to load it.

## 2. Sources and precedence (the database is the authority)

The agent must never be able to change its own guardrails. Agent sessions can write under `$SLAUDE_HOME`
(skills live there by design), so files on disk are never read at runtime.

- **Authority:** a `guardrails` table (slug, md, sha, source, version, enabled, hmac, updated) plus a
  `guardrail_overrides` table (slug, md, base_sha, version, author, hmac). The effective set is resolved
  only from these. Each row carries an HMAC over (slug, md, version, enabled), keyed like the runtime bundle
  ETag (`src/gateway/api/tenants.ts`); resolution verifies it and fails closed on a mismatch: the affected
  agent's session boot fails with an audit row `guardrail.integrity.failed`, the same as a missing snapshot.
  Per-row HMACs alone do not cover the set (a deleted row or a replayed older row would still verify), so a
  single `guardrails_manifest` row carries an HMAC over the sorted list of (slug, version, enabled) plus the
  override set, written in the same transaction as every row change. Resolution verifies the manifest first,
  then each row; a row missing from or extra to the manifest, or a version mismatch, fails the boot the same
  way. A whole older signed set (a rollback) and a deleted set (no manifest after one existed) verify on their
  own, so a per-tenant high-water mark of the manifest version is kept outside the database (in memory, in a
  file beside the key, and in Redis when the deployment has one); a set below it fails closed. Residual risk:
  on a cold start of a single process without Redis, whoever can rewrite both the database and the mark file
  can roll back undetected. A write verifies the stored set before re-signing, so it can never launder
  tampering; the owner's explicit `slaude guardrails import --repair` re-signs a set that failed (audited).
  The key is the master key's subkey; on sqlite without a master key a key file is created on the first write,
  and Postgres requires the master key. A deployment with no guardrails never reads or creates the key.
- **Threat model, stated honestly:** on a single-process deployment with the default sqlite database under
  `$SLAUDE_HOME`, a session's Bash can reach the database file. There the design protects against drift and
  accidental edits, and the HMAC makes tampering detectable (fail closed), but it does not stop an
  adversarial agent from denying service. The stronger claim (an agent cannot change its guardrails) holds
  with Postgres or node mode, where the session cannot reach the database. The console shows which mode the
  deployment is in.
- **Snapshot:** rules resolve into an in-memory snapshot at session boot, the same lifecycle as the soul,
  re-read only on reload. A boot that cannot read or verify the snapshot fails (as node boots already do),
  never runs with an empty set.
- **Sources that write the table:**
  1. Personas-as-code: a `guardrails/` folder in the deploy repo; `/deploy` carries a top-level
     `guardrails: []` (payload version 5 when non-empty; `payloadVersionFor` in `src/persona/sync/payload.ts`
     extended beyond persona fields).
  2. Console edits (phase B), superadmin only, audited.
  3. Operator CLI `slaude guardrails import <dir>` for host files (explicit, run by a person, audited;
     `--repair` re-signs a set that failed its integrity check).
- **No MCP tool writes guardrail rows.** Defence in depth: a tagged PreToolUse deny
  (`hook.pre-tool.guardrail-files`) refuses `Write|Edit|MultiEdit|NotebookEdit` under
  `$SLAUDE_HOME/guardrails` and the database file path. Bash is not covered, which is why files are never the
  authority and rows carry an HMAC.
- **Overrides on sync:** unlike the soul (whose overrides are wiped on sync), a console override is kept and
  flagged "behind source" when `override.base_sha != source.sha`, so a sync never silently drops a safety
  rule. Every change bumps a version that is an explicit input of the runtime bundle's ETag, so an override
  change on its own busts node caches.
- **Delivery to nodes:** the effective rules join the tenant runtime bundle the node's soul resolver reads
  (not `NodeManifest`), and `publishConfigReload` invalidates node caches on any guardrail change.
- **Version skew:** nodes advertise a `guardrails` capability (with a version) on register. The gateway never
  dispatches a turn for an agent that has enforced rules to a node without the capability; it audits
  `guardrail.node.unsupported` and the turn waits for a capable node up to the existing dispatch timeout,
  after which the thread gets a visible notice instead of a silent queue. An older node can never silently run
  an agent's turns without its rules.
- **Kill switch:** each guardrail has an `enabled` flag a superadmin can toggle from the console (one audited
  write plus `publishConfigReload`), available from phase A1.
- **References:** `agents:` names are validated against the persona registry; a guardrail that applies to no
  agent is flagged in the list. `scope: shared` includes the default agent.

## 3. Combining rules

All applicable rules are evaluated. Per event, the strictest action wins: deny > approve > redact > audit.
Every rule that matches is audited, even when a stricter one decides. The message shown is the deciding
rule's.

## 4. Enforcement points

- **Tool rules:** a new PreToolUse hook `hook.pre-tool.owner-guardrails`, tagged in the registry. PreToolUse
  runs in every permission mode (including bypass), so owner rules cannot be skipped by `/mode`. It runs in
  mono and on nodes (nodes run AgentManager and get the rules in the bundle).
  - deny: `permissionDecision: deny` with the rule's message.
  - audit: allow, emit an audit row.
  - Scope note, stated in the docs and console: tool rules are a policy on named tools. A shell or fetch tool
    can reach the same service, so a `send` deny is best paired with a Bash or WebFetch `input` rule, or
    with remote mode's deny list.
  - Background passes build their own hooks (`src/background/runner.ts`); owner tool rules are added there
    too.
  - approve (phase A2, decided by the spike in `2026-11-08-owner-guardrails-a2-spike.md`): the hook awaits
    the card itself. The spike found no 60 s default for in-process hooks and that a timed-out hook does not
    run the tool, but that a thrown hook does; the hook therefore catches every error as a deny and owns its
    deadline (`SLAUDE_GUARDRAIL_APPROVE_TIMEOUT_SEC`, default 600 s; the matcher timeout is 60 s above it).
    On nodes the job token is not extended: the card ends 30 s before the turn deadline (the token's 15
    minutes). An approval returns allow (one card, `canUseTool` skipped); the card offers no "always allow".
    The original plan, kept for the record: the SDK's hook timeout defaults to 60 s and a timed-out hook lets the tool run, while
    a card lives up to an hour. Approach, to be confirmed by a spike before building: set this matcher's
    `timeout` to the card TTL plus a margin and call the gateway's resolver wrapper (which already refuses in
    a wake) with the requester stamp (`stampFromSenders` / `liveTurnStamp`), aborting on session abort. On
    nodes the call goes through `/v1/tools/runtime/can_use_tool` with `force_card` and `rule_id`, and the
    gateway re-evaluates the rule from its own snapshot before opening the card. Alternative under the same
    spike: return `permissionDecision: "ask"` and let `canUseTool` raise the card, only if the SDK proves it
    reaches canUseTool under bypassPermissions. A timeout is a deny, never an allow: the hook owns an inner
    deadline strictly shorter than the matcher timeout and than the node turn budget. On nodes a held tool
    approval is therefore capped below the job token lifetime (15 minutes today) unless the token is
    extended while a card is pending; the spike decides which, and the console states the cap.
- **Reply rules (phase A2):** today agent text leaves through several paths (`slack/surface.ts`,
  `slack/mcp-tools.ts` second formatter, approval-gate, `background/proposal-cards.ts` posting with secret
  masking only, and direct `chat.postMessage` sites in the gateway). Phase A2 first introduces one
  `outbound(text, {persona, channel, kind})` in `src/gateway/slack/outbound.ts`, called by every
  agent-authored path: reply, edit, upload caption, `proactive_post`, `post_message`, proposal previews. Runtime
  UI (permission and approval cards, status line) is not covered and is listed as such. Node replies already
  funnel through the tool plane's surface executor.
  - deny: the tool returns an error with the rule's message; nothing is posted.
  - approve: a "waiting for approval" placeholder is posted, an approval card goes to the agent's approvers,
    and the placeholder is edited to the reply on allow or to a refusal note on deny or timeout. (Built in
    rc.10: the held text goes to each approver privately, never into the thread; an agent with no named
    approver, a wake, a proactive post and a proposal preview have nobody to ask, so approve is a deny
    there. The covered paths and the runtime UI that is not covered are enumerated in `OUTBOUND_SITES`
    in `src/gateway/slack/outbound.ts`, checked by a test.)
  - redact: matches replaced with `[REDACTED]`.
  - Streamed replies (a message edited per chunk): rules run on the full accumulated text at each edit and
    the whole message is replaced, so a pattern split across chunks is still caught and redaction stays in
    sync.
- **Inbound rules:** in `preTurnDropReason` after admission (shared with the decision gate's ingress drops).
  A new drop kind `{reason: "owner_guardrail", reply}`: `handleMessage` posts the rule's message as a thread
  reply (ephemeral where the surface supports it) and the message is not dispatched. The reply is
  rate-limited per person and thread (at most one per person per thread per 10 minutes; later denies are
  silent and audited). The decision gate's read-only `ingressDrops` path records the drop and never posts. Not covered, and documented: cron dispatch, panel chat and `/compact`.
- **Plain-language rules:** an `<owner-guardrails>` block in the system prompt after `<persona>` and before
  `<channel-mandate>`. Channel-scoped prose only when the session's channel matches. A change reloads warm
  sessions after their turn (`publishConfigReload` then `reloadAfterTurn`).

## 5. Audit

Action names: `guardrail.tool.denied|approved|refused|audited`, `guardrail.reply.denied|held|redacted|audited`,
`guardrail.inbound.denied|audited`, plus `guardrail.created|updated|deleted|override.set|override.cleared`.
Target: `guardrail <slug>#<rule id>`. Details: agent, channel, tool name (never full tool input or message
text). At most a 120-char excerpt, always passed through the existing secret masking (`src/redact`) and the rule's own
redaction; inbound denies and any rule whose pattern matched never store message text at all (tool name and
rule id only).

## 6. Console (Resources > Guardrails)

- **List:** name, description, scope (Shared, or agent chips), channels, rule counts by kind, enabled, source
  (file, git, console override, "behind source"), last fired (from audit).
- **Detail:** GUARDRAIL.md with the shared Markdown component (Rendered / Raw / Copy), the parsed rules as a
  table, validation errors, applies-to (resolved agents and channels with names), recent firings.
- **Edit (superadmin):** edit the markdown in place with live validation; enable/disable; delete (console
  overrides and console-created only; file and git guardrails can be disabled by override, not deleted);
  create from a template. A "Test" box: paste a tool name and input, a reply text, or an inbound text, pick an
  agent and channel, see which rules match and the deciding action, without side effects.
- **Agent page:** a Guardrails tab listing the effective guardrails for that agent (shared and specific),
  linking to each.
- Operators (non-superadmin) can read everything except edit actions.
- The rc.7 runtime-layer sections and API fields are removed. The old soul/access families currently below
  them move to the agent's Access tab, Memory page and Mandates tab (the rc.7 spec's phase 2), so the
  Guardrails page shows only owner guardrails.

## 7. Phasing

- **Phase A1 (rc.9):** format and parser (re2js), DB storage and the import CLI, `/deploy` payload v5,
  effective resolution, HMAC integrity and the boot snapshot, delivery to nodes in the runtime bundle with
  reload and the node capability check, the guardrail-files deny hook, Guidance (`load: always` and
  `load: on-match` with tool and inbound triggers), tool deny and audit (interactive, wake and background),
  inbound deny and audit with the rate limit, audit rows, read API, console list and detail and the agent
  Guardrails tab, the superadmin enable/disable toggle, and removal of the rc.7 runtime-layer console
  sections.
- **Phase A2 (rc.10):** spike then build tool approve (card); the single outbound choke point; reply deny,
  redact, audit and hold-and-approve.
- **Phase B (rc.11):** console editing (overrides, create, delete), the Test box, and moving
  the old soul and access families to Access, Memory and Mandates.
- **Later:** semantic matching, approve on inbound, redact on tool input.

## 8. Testing

- Parser: frontmatter, rules block, invalid regex, catastrophic regex rejected, unknown action/on combos.
- Resolution: shared vs agents vs channels, disabled, invalid, override precedence, behind-source flag.
- Combining: strictest wins, all matches audited.
- Enforcement: tool deny in bypass mode; approve card decided by requester or approver; approve in a wake
  denies; node path re-evaluated on the gateway; reply deny, hold-and-approve, redact, including proactive
  posts; inbound deny replies with the message and does not dispatch; prose reaches the prompt and reloads.
- Agreement test: both new hook ids are in the registry and tagged.
- Self-edit: a session cannot Write/Edit under $SLAUDE_HOME/guardrails; a file dropped there by Bash has no
  effect at runtime; no MCP tool writes guardrail rows.
- API and console (Playwright, stubs): list, detail, agent tab; operator cannot edit (phase B).
- Audit rows carry no full input or message text.

## Risks

- A wrong rule can block an agent's work broadly; mitigations: validation, the Test box (phase B), audit of
  every firing, and enable/disable per guardrail.
- Regex cost on every tool call and reply: precompiled, capped, measured in a benchmark test.
- Held replies (approve) add latency and need clear "waiting for approval" feedback in the thread.

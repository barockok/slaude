# Engagement, Approvals & Slash Commands

Every Slack message either reaches the model or it does not. This guide explains exactly when it does, how the human stays in the loop for risky work, and which slash commands give you direct control without talking to the agent.

> **Prerequisites:** You have deployed slaude, the bot is in your workspace, and you have edited `SOUL.md`. If not, start with [Getting Started](../start/getting-started.md).

---

## 1. Engagement model

One Slack thread is one Claude session. But not every message in the thread is for the agent. Slaude uses a three-rule engagement gate that is cheap to reason about and persisted so it survives restarts.

### 1.1 The three rules

1. **@mention the agent to engage.** A message that contains `<@BOT_ID>` (or a persona user ID in multi-persona mode) engages the thread. From that point, plain follow-ups in the same thread are delivered to the model without another mention.

2. **@mention someone else to disengage.** A message that mentions a different user (and not the bot or any persona) disengages the thread. The user is now talking to a colleague, not the agent.

3. **DMs are always engaged.** `channel_type === "im"` skips the gate entirely. No mention needed.

All other messages follow from these: plain replies in an engaged thread are handled, plain replies in a disengaged thread are dropped or silently recorded (see below).

### 1.2 Step-by-step flow

Imagine a public channel `#platform` where slaude is installed.

**Step 1 — Engage the thread:**

```
you:  @slaude can you review the bulk-corpus ingest job?   ← mentions bot → engaged
slaude: On it — looking at the latest run now…
```

The gateway adds `channel:threadTs` to the in-memory `engaged` set **and** flips `sessions.engaged = 1` on the row so the state survives a restart. Both `app_mention` and `message` events with a bot mention drive this path.

**Step 2 — Stay engaged without another mention:**

```
you:  focus on the error rate spike at 14:00 UTC           ← plain reply → handled
slaude: Found it — error rate 12% at 14:03, retries exhausted on shard-3…
```

The message had no `@slaude`, but the thread is in `engaged`, so it is forwarded to the model.

**Step 3 — Disengage by mentioning a colleague:**

```
you:  @jane can you take a look at shard-3?                ← mentions other user → disengaged
```

The gateway does two things: `engaged.delete(key)` and `sessions.engaged = 0`. If a session already exists for the thread, the disengaging message is still **recorded into the transcript as a suppressed turn** (the `UserPromptSubmit` hook returns `continue:false` so the model does not run, but the user message is persisted). On re-engage the model sees the gap already in history. If no session exists, the message is dropped.

**Step 4 — Plain messages while disengaged are recorded, not answered:**

```
you:  jane — did you restart the worker?                   ← plain, but disengaged → suppressed
# no reply from slaude; message is in history for next engage
```

**Step 5 — Re-engage with another mention:**

```
you:  @slaude shard-3 is fixed, continue the review         ← mentions bot → re-engaged
slaude: Got it — picking up where we left off. Shard-3 recovered at 14:12…
```

The model resumes with the two gap messages already in context. No re-fetch, no synthetic preamble.

### 1.3 Example transcript (annotated)

```
Thread: #platform — "bulk-corpus ingest review"

[@slaude can you summarize today's ingest?]        → ENGAGED  → model runs
[Here's the summary… 3 shards ok, 1 degraded]      ← reply
[what about the degraded one?]                      → ENGAGED  → model runs
[@jane can you check shard-3's disk?]              → DISENGAGED (suppressed turn, transcript keeps it)
[jane: on it]                                       → DISENGAGED (suppressed)
[@slaude jane fixed disk, resummarize]             → RE-ENGAGED → model sees both gap messages
```

### 1.4 Do / Don't

| Do | Don't |
|---|---|
| `@slaude` once per thread, then speak normally | `@slaude` every message (works but noisy) |
| Use `@someone` when you actually want to talk to them | `@here` / `@channel` — does not disengage (no user ID in the mention parse) |
| Expect plain history to be in context after re-engage | Expect the agent to answer while disengaged — it is recording silently |

### 1.5 Under the hood

```
src/gateway/core/gateway.ts  → engaged Set + threadKey() + persistEngaged()
src/db/sessions.ts           → sessions.engaged (INTEGER 0/1) — the durable flag
src/db/schema.ts             → UNIQUE(team, channel, thread, persona_id)
```

Without the `sessions.engaged` column, every disengage lasted zero messages: a disengaged thread still had a session row, so the next plain reply hit the "restore from row" path and re-engaged immediately. The column was added for [this finding](../field-notes/2026-06-11-engagement-disengage-durability.md). The suppressed-recording trick uses `continue:false` rather than `decision:"block"` — the latter discards the prompt before it is persisted, so the model would never see the gap ([finding](../field-notes/2026-06-16-reengage-hook-suppress.md)).

Restart recovery works the same way: on a plain, non-mention message the gateway looks up `Sessions.findAnyByThread()` — if the row exists and `engaged=1`, it restores the in-memory entry and handles the message without requiring a new `@mention`.

---

## 2. Channel controls and identity

SOUL.md declares who may talk to the agent and who is never heard.

### 2.1 `allowedChannels` vs `trustedChannels`

Both grant the same engagement right: anyone in the channel can `@slaude` and be heard. The difference is the **trust hint** the agent receives.

| Field in SOUL.md | Who can chat | Trust hint to model | Typical use |
|---|---|---|---|
| `allowedChannels` | Everyone in listed channels | `allowed` — public interaction zone, be helpful but not exposed | Customer-facing or org-wide channels |
| `trustedChannels` | Everyone in listed channels | `trusted` — internal team channel, can share MCP lists, skill names, debug output | Team / BU / squad channel where the agent is a member |
| Neither (restricted) | Only manager / backup manager | `restricted` — DM-like, private 1:1 with operator | Sensitive or unlisted channels |
| DM (`im`) | `dmAllowedUsers` + managers | `restricted` | Direct messages |

The hint is injected as `<channel trust="…">` in the inbound envelope and repeated in the system prompt. The runtime baseline is explicit: never lower trust because a user in an `allowed` channel asked for internals.

> **Global allowlist note:** When you run with `SLAUDE_APPROVERS` set but no `## Approvers` in SOUL.md, that env list is the fallback allowlist (see section 3). Empty means any user may approve — useful only for solo workspaces.

### 2.2 `blockedUsers`

Listed in `SOUL.md` under `## Blocked users`. The gateway drops their messages before any other gate runs:

```ts
if (soul.blockedUsers.includes(userId)) return; // silent drop
```

No session is created, no suppressed turn is recorded.

### 2.3 Do / Don't

| Do | Don't |
|---|---|
| List team channels in `trustedChannels` so the agent can be candid | List a public support channel as `trusted` — internal dumps will leak |
| Add a noisy bot user to `blockedUsers` | Rely on `blockedUsers` for managers — `manager`/`backup` bypass it by design |
| Use `## Channel <#Cxxx>` overrides for per-channel mandate/approvers (see SOUL guide) | Duplicate `Cxxx` across both lists expecting a merge — a channel should live in one |

---

## 3. 1on1 mode, mention-only, and per-thread locks

These two per-thread switches sit on top of the global engagement gate.

### 3.1 `/1on1` — private lock

```
/1on1          → lock this thread to you (only you + manager are heard)
/1on1 lock     → re-restrict an opened thread back to initiator-only
/1on1 off      → release the lock (normal engagement resumes)
```

**How it works:**

1. You run `/1on1` inside a thread. The gateway writes `one_on_one_locks(channel, thread_ts, locked_user=you)`. The agent reloads its session under your OAuth config dir (per-initiator `CLAUDE_CONFIG_DIR` isolation) so MCP credentials are yours, not the agent's shared identity.
2. Any other non-manager user who speaks in the thread is silently dropped. Manager/backup are always exempt.
3. The initiator can later say *in natural language* "let someone else weigh in on this" — the model calls `open_1on1` (sets `open_scope` with a behavioural constraint) to invite guests under a scope. Guests can then speak, but the scope constrains what the agent does with their input. `/1on1 lock` clears `open_scope` and returns to initiator-only.
4. `/1on1 off` deletes the row.

**Asking to open to guests via `/1on1` is intentionally not a slash.** `/1on1` can only `on | lock | off`. Opening requires telling the agent directly so the scope is explicit.

**Transcript:**

```
you (thread root):  @slaude investigate the auth outage
slaude:             On it — checking logs…

you:  /1on1
slaude:             :lock: 1on1 mode — only you and managers may speak here.

jane: can I see the logs?        → dropped (not initiator, not manager)
you:  slaude, let jane weigh in — she owns auth
slaude:             :unlock: opened — guests may speak under scope: "jane owns auth, constrain advice to her input"
jane: the error is E-442         → handled (open_scope active)
you:  /1on1 lock
slaude:             :lock: re-locked — back to initiator-only.
you:  /1on1 off
slaude:             1on1 mode off — normal engagement resumes.
```

Related: `src/db/one-on-one.ts` (`one_on_one_locks` table, `open_scope` column).

### 3.2 `/mention-only` — opposite of sticky engagement

```
/mention-only       → only @mentions trigger replies in this thread
/mention-only off   → restore normal sticky engagement
```

When `mention_only_threads` has a row for the thread, a plain (non-@mention) message is **suppressed** if a session exists (recorded for later context) or **dropped** if no session exists. The gateway never auto-continues in this mode. This is the agent-facing twin of the same flag: the model can also call `mcp__slaude_surface__set_mention_only` to toggle it mid-conversation.

**When to use it:** A long-running thread where you want the agent to stay quiet unless explicitly called. Without it, every follow-up after the first `@slaude` would trigger the model.

| State | Plain message in thread | `@slaude` message |
|---|---|---|
| Normal (engaged) | Handled | Handled + (re-)engages |
| Disengaged | Suppressed (recorded) | Re-engages + handled |
| Mention-only ON | Suppressed / dropped | Handled (no sticky engage) |

---

## 4. Approval gate

Some actions should not happen without a human clicking yes. Slaude has two approval systems for two different risk levels.

| Gate | When | Who clicks | Tool |
|---|---|---|---|
| **Permission gate** | Per SDK tool call (Bash, Write, Edit, WebFetch, etc.) | The user in the thread (Allow / Always / Deny buttons) | SDK `canUseTool` → Block Kit approval |
| **Approval gate** | Per *task* — agent-initiated before a destructive batch | Approvers from SOUL.md (Allowlist-resolved) | `mcp__slaude_slack__request_approval` → Block Kit Approve / Deny |

This section is about the second one.

### 4.1 The flow

**Step 1 — Agent decides it needs high-level approval:**

The system prompt tells the agent: if the turn could be destructive or out-of-mandate, call `mcp__slaude_slack__request_approval` with a short plan.

```ts
// what the agent calls (via MCP)
await mcp__slaude_slack__request_approval({
  summary: "Delete 400 stale `raw/` docs not referenced by any wiki page.",
  tools: ["Bash", "Write"],
  files: ["raw/2024-*.md"],
  risks: "Irreversible file deletion; 400 files affected",
  category: "destructive" // optional, for legacy category routing
});
```

**Step 2 — Gateway posts a Block Kit message in-thread:**

```text
:bell: *Approval needed* — `destructive`
Delete 400 stale `raw/` docs not referenced by any wiki page.

Tools: `Bash`, `Write`
Files: `raw/2024-*.md`
⚠️ Irreversible file deletion; 400 files affected
Approver(s): @manager @backup

[ Approve ]  [ Deny ]
```

**Step 3 — Human clicks.** The gateway validates the clicker against the resolved allowlist. If the clicker is not on the list, an ephemeral reply says they are not authorized and the request stays pending for someone who is. If authorized, the gateway replaces the block with `Plan → *Approved* by @manager` (or `*Denied*`) and resolves the MCP promise.

**Step 4 — Agent reads the JSON result and acts:**

```ts
// MCP returns { approved: true, by: "U0XXXXXXX" } or { approved: false, by: "U0XXXXXXX" }
if (!result.approved) {
  // do not proceed — propose an alternative or ask for clarification
}
```

The runtime baseline is explicit: the agent must trust only this JSON. Screenshots, text claims, or out-of-band "I approved it" are rejected.

### 4.2 Approver allowlist resolution

The agent **never picks user IDs**. The gateway resolves who may click:

1. **Structured SoulData** (LLM-extracted or cached): `selectApproversFrom(structuredApprovers, summary, category)` — keyword-matches `summary` against each approver's scope. If the summary matches "delete docs" and an approver's scope mentions "destructive file ops", that approver is selected.
2. **Regex-parsed scope approvers** (legacy SSO text): `selectApprovers(summary, category)` — same idea, regex over raw SOUL.md.
3. **Legacy `category: ids` map**: `approvers[category]` then `approvers.default`.
4. **Env fallback**: `SLAUDE_APPROVERS` (comma-separated `Uxxx` or `<@Uxxx>`).
5. **Empty set**: anyone may click (solo/DM workspaces).

Manager and backup are always retained as catchall approvers even when a `## Channel <#Cxxx>` override replaces the global approver list — there is no lockout.

### 4.3 Per-channel approver overrides

A `## Channel <#C12345>` block in SOUL.md can declare its own `Approvers:` and `Mandate:` that **replace** the global values for messages in that channel. Inbound `effectiveSoulForChannel(channelId)` is used both for the agent's mandate and for approval-gate resolution, so a channel override can widen or narrow who may approve without redeploying the container. Edits take effect after `bun run validate-soul` re-extraction or on next boot.

### 4.4 Do / Don't

| Do | Don't |
|---|---|
| Write narrow approver scopes in SOUL.md ("may approve *deploy* plans") | Leave scopes broad ("can approve anything") — every destructive plan matches |
| Require `request_approval` when `bypass` mode is on (persona mandate forces it) | Call `request_approval` and also ask the user to paste a screenshot — trust only the JSON |
| Set `Approval timeout` in SOUL.md (e.g. `600`) so pending blocks auto-deny | Assume an unclicked approval waits forever (it might, if timeout is `0`) |

Timeout is configured in SOUL.md (`## Approval timeout — seconds`). When positive, the gateway posts `Auto-denies in 600s` and auto-resolves with `{ approved: false, by: "system", note: "timeout-600s" }` after expiry.

---

## 5. Slash commands

Slash commands give the **human in Slack** direct control that does not depend on the model interpreting intent. They are parsed before the message reaches the model.

### 5.1 Command table

All commands below work inside a thread (they resolve `channel` + `thread_ts` from the event). Commands marked *thread-only* fail gracefully outside a thread.

| Command | Summary | Who may run | Per-session effect |
|---|---|---|---|
| `/mode <name>` | Set tool-permission mode for this thread's session | Anyone in the thread | Persists to `sessions.permission_mode`; next boot uses it |
| `/mode` (no arg) | Show current mode + available modes | Anyone | Read-only |
| `/abort` `/stop` `/cancel` | Cancel the current model turn | Anyone in the thread | Calls `AbortController.abort()` — stream ends with `aborted` |
| `/1on1` `/1on1 lock` `/1on1 off` | 1on1 private lock (see section 3.1) | Anyone (initial lock) / manager enforces | Writes `one_on_one_locks` |
| `/mention-only` `/mention-only off` | Mention-only toggle (see section 3.2) | Anyone in the thread | Writes `mention_only_threads` |
| `/help` `/h` `/?` | Show help table + mode list | Anyone | None |
| `/ingest` | Manually trigger KB ingest (`raw/` → wiki → brain sync) | Manager / approver only | Background job; reacts with `hourglass` |
| `/mcp` `/mcp connect <server>` `/mcp disconnect <server>` | List / connect / disconnect OAuth MCP servers | Status: anyone; connect/disconnect: `/1on1` → initiator, else manager/backup | Writes per-user OAuth config |
| `/soul trust|allow|dm|block add|remove <id>` | Runtime ACL override (shadows SOUL.md without redeploy) | Manager / backup only | Writes `soul_overrides` |
| `/soul list` | Show runtime overrides vs SOUL.md base | Anyone | Read-only |
| `/soul clear <field|all>` | Drop runtime overrides, revert to SOUL.md | Manager / backup only | Deletes from `soul_overrides` |
| `/model` `/model <id>` | Show or switch this thread's model | Anyone may list; manager/approver may set | Persists to `sessions.model` |
| `/bash <command>` | Run a shell command on the server (gated) | Manager / approver only | Same as agent Bash — requires approval |
| `/compact` | Summarize and compact conversation context | Anyone in the thread | Triggers pre-compact hook |
| `/ignore @user [dur]` | Ignore a user (optional duration `30m`, `1h`, `permanent`) | Manager / approver only | Writes `ignores` |
| `/ignore-thread [dur]` | Ignore this thread | Manager / approver only | Writes `ignores` |
| `/unignore @user` `/unignore-thread` | Remove an ignore | Manager / approver only | Deletes from `ignores` |
| `/cron-add "<expr>" "<prompt>" [channel] [passive]` | Schedule a recurring prompt | Manager / approver only | Writes `cron_jobs` |
| `/cron-list` `/cron ls` | List scheduled crons | Manager / approver only | Read-only |
| `/cron-edit <id> "<expr>" "<prompt>" [channel] [passive]` | Edit a cron's schedule/prompt/target | Manager / approver only | Updates `cron_jobs` |
| `/cron-pause <id>` `/cron-resume <id>` | Pause / resume a cron | Manager / approver only | Flips `paused` flag |
| `/cron-remove <id>` `/cron rm <id>` | Remove a cron (soft-delete) | Manager / approver only | Sets `active=0` |

The canonical list lives in `src/gateway/slack/commands.ts` (`AGENT_COMMANDS`). `/help` renders it — edit that array and every surface (Slack, sim REPL) picks it up.

### 5.2 `/mode` — per-session permission modes

Each session stores its own `permission_mode` in `sessions.permission_mode`. `/mode` switches it live.

**Supported names (aliases in parens):**

| You type | Stored as | Meaning |
|---|---|---|
| `ask` (`default`) | `default` | Prompt per tool via Block Kit Allow / Always / Deny |
| `accept-edits` (`edits`) | `acceptEdits` | Auto-allow Read / Write / Edit; still ask for Bash, WebFetch, etc. |
| `bypass` (`yolo`) | `bypassPermissions` | Every tool auto-allowed — persona mandate + approval gate are expected to gate risk instead |
| `plan` | `plan` | No execution — planning / read-only |
| `dont-ask` (`deny`) | `dontAsk` | Deny anything not pre-approved |

**How to use it:**

```
you:  /mode bypass
slaude: :gear: mode → *bypass (YOLO — every tool auto-allowed)* for this thread.
# every later turn in this thread starts with permissionMode=bypassPermissions
# until you switch again.

you:  /mode
slaude: Current mode: `bypass` — bypass (YOLO…)
      Available:
        • /mode ask — ask (default — prompt per tool)
        • /mode accept-edits — accept-edits (auto-allow Read/Write/Edit…)
        …
```

**Transcript example:**

```
you:  @slaude scaffold the new service        → session starts in default (ask)
slaude: [asks Allow for Write scaffold.ts]    [Allow] [Always] [Deny]

you:  /mode accept-edits
slaude: :gear: mode → accept-edits for this thread.

you:  keep going
slaude: [writes files without prompting for Write/Edit; asks for Bash]
```

Persistence: `Sessions.setPermissionMode(sessionId, mode)` on every `/mode`, and `AgentManager` reads `row.permission_mode` when booting the SDK `Options.permissionMode`. The SDK also respects `allowDangerouslySkipPermissions` when `bypassPermissions` is active.

> **Tip:** Set `SLAUDE_DEFAULT_MODE` in env to choose the initial mode for new threads. Docker compose defaults to `bypass`; local `.env.example` defaults to `ask`.

### 5.3 `/abort`, `/ingest`, `/help`

```
/abort          → aborts the live Query for this session (AbortController).
                  The stream emits type:"error" with "aborted"; the gateway
                  posts a :stop_sign: notice. Next message resumes normally.

/help           → prints AGENT_COMMANDS + the mode list. Same output in the
                  sim REPL — single source of truth.

/ingest         → manager/approver only. Starts a kb ingest job (Task 10).
                  Requires an active session (post one message first). The
                  gateway posts :hourglass: and schedules nightly maintenance.
```

### 5.4 How slash commands are dispatched

1. `gateway.ts` strips the bot mention (including persona mentions like `@Noah`) before parsing.
2. `parseSlashCommand(text)` tries `/mode`, then `/abort`, `/ingest`, `/ignore…`, `/cron…`, `/1on1`, `/mention-only`, `/soul`, `/mcp`, `/model`, `/bash`, `/compact`, `/help`. Returns `null` if no match — the message goes to engagement / model instead.
3. Each `kind` branches in the message handler, enforces auth (`isManagerOrApprover` where needed), touches the DB, and calls `reply()` without waking the model (except `/bash` which runs through the agent tool loop).
4. Unknown `/` commands are currently dropped (no help hint) — they do not reach the model.

---

## 6. Cron — scheduled prompts

Cron lets a manager schedule a prompt that fires on a cron expression and posts its result back to Slack.

### 6.1 Cron expression format

Standard 5-field UTC cron: `minute hour day-of-month month day-of-week`.

| Expression | Fires |
|---|---|
| `0 9 * * 1-5` | Weekdays at 09:00 UTC |
| `0 0 * * *` | Daily at midnight UTC |
| `*/30 * * * *` | Every 30 minutes |
| `0 9 1 * *` | First of every month at 09:00 UTC |

Parsing lives in `src/gateway/slack/cron-parser.ts` (`parseCron`, `getNextRun`). Search is capped at ~4 years to avoid infinite loops.

### 6.2 Two posting targets

```
# In a thread — post result in this thread:
you:  /cron-add "0 9 * * 1-5" "post standup summary for #platform" 
slaude: :alarm_clock: cron `a1b2c3d4` scheduled — next run: in 8 hours

# Broadcast to channel root instead:
you:  /cron-add "0 9 * * 1" "weekly platform health report" channel
slaude: :alarm_clock: cron `e5f6g7h8` scheduled (channel) — next run: in 6 days
```

`target` is `thread` (default, posts under the thread that created it) vs `channel` (posts at the channel root via synthetic `cron:<id>` thread). Channel jobs never bind a real thread, so their session key is always the internal cron id.

### 6.3 Passive vs fire

```
/cron-add "*/5 * * * *" "check for stale PRs" passive
```

`when_active="skip"` (opt-in via `passive` flag) defers that tick while a human is live in the target session (`AgentManager.isLive(sessionId)`). Default is `fire` — runs even while someone is chatting. The in-memory `#running` guard prevents same-job re-entry within a tick.

### 6.4 Lifecycle commands

```
/cron-list
# → :alarm_clock: *Scheduled crons* (3)
#   `a1b2c3d4` — `0 9 * * 1-5` — "post standup…" — next: in 8 hours — active
#   `e5f6g7h8` — `0 0 * * *` — "nightly ingest…" — paused

/cron-pause a1b2c3d4
# → :pause_button: cron `a1b2c3d4` paused

/cron-resume a1b2c3d4
# → :arrow_forward: cron `a1b2c3d4` resumed — next run: in 8 hours (recomputed)

/cron-edit a1b2c3d4 "0 10 * * 1-5" "new prompt" channel passive
# → reschedules + moves target + flips whenActive

/cron-remove a1b2c3d4
# → :wastebasket: cron `a1b2c3d4` removed (soft-delete, active=0)
```

Short 8-char prefixes are accepted where they unambiguously identify one job.

### 6.5 Scheduler internals (for operators)

- `CronScheduler` (`src/gateway/slack/cron-scheduler.ts`) polls `findDue(now)` every 60 seconds and on start.
- Each fire boots or resumes a session (`ensureSession(threadKey)`) and sends `envelope = "[scheduled] <prompt>\n\nReply with the result. This is a cron job."`
- Completion is tracked via `AgentManager` `event` (`done` / `error`); then `updateNextRun(id, getNextRun(expr), result)` is written.
- Missing legacy rows without `slackTeamId/slackChannelId` are skipped with `error: missing Slack keys`.
- Jobs created inside a `/1on1` carry `oauthUser` — the fire boots the child under that user's OAuth config dir (same isolation an interactive 1on1 session gets).

---

## 7. Attachments — both directions

### 7.1 Inbound: Slack → agent

When a user attaches files to a message, the gateway downloads them before forwarding the turn.

```ts
// gateway.ts → downloadAttachments(files, botToken, workingDir, inboundTs)
```

Files are streamed via `GET` on `url_private_download` with `Authorization: Bearer <bot_token>` and saved to:

```
$SLAUDE_HOME/workspaces/<sessionId>/attachments/<inbound_ts>/<safeName>
```

Non-deleted files from Slack Enterprise Grid with `url_private` fallback are also handled. Failures are logged (`[slack-attach]`) but do not drop the turn — the message proceeds with whatever subset downloaded successfully. The agent receives the download paths in the prompt and can `Read` them.

### 7.2 Outbound: agent → Slack

When the agent produces a file artifact, it must call `mcp__slaude_slack__upload` (not reply with a path or URL). The file is uploaded via `files.uploadV2` into the same thread — this survives expiring private URLs and renders in-thread.

```
agent:  [calls mcp__slaude_slack__upload { path: "/data/workspaces/<id>/report.csv", title: "Q2 report" }]
# → file appears in-thread as an uploaded attachment
```

The runtime baseline is explicit about this: pointers to local paths are useless to the user — the user cannot read the agent's filesystem.

---

## 8. Slack Agents API status

When the workspace's app manifest enables **Agents & AI Apps** (Assistant view) and the bot token carries `assistant:write`, slaude drives the animated status next to its name in a thread.

| Status text | When |
|---|---|
| `thinking…` | Model start, between tool batches |
| `running \`tool\`` or humanized status (e.g. "Searching the codebase…") | On `toolCall` events (via `humanizeToolStatus`) |
| `Task list` / `Todo list` rendering | When the agent drives `TaskCreate` / TodoWrite |
| Cleared (`""`) | On `done` / `error` / `aborted` |

Implementation is `src/gateway/slack/status.ts` → `client.assistant.threads.setStatus`. If the API returns `missing_scope`, `not_allowed_token_type`, or `not_in_assistant_thread`, status auto-disables and logs once so missing config is visible without spamming.

Suppressed (disengaged) turns set no status and never stamp a thinking indicator.

---

## 9. Idle TTL and resume

A session's SDK Query is not kept alive forever. After `SLAUDE_IDLE_MINUTES` (default `15`) with no new user message **and** no running turn, the gateway closes the prompt iterable and the Query exits cleanly.

```
Timeline (IDLE = 15 min):

t=0   @slaude hi                          → Query boots, permissionMode=default
t=1   … turn completes, session idle …    → #armIdle() re-arms 15-min timer
t=16  (no messages for 15 min)            → timer fires → iterable closed → SDK loop exits
                                            Sessions.status = "idle", #live entry dropped
t=25  you: still there?                   → Sessions.clearStarted? No — resume path:
                                            #startSession() boots new Query with { resume: <same-id> }
                                            Provider replays transcript; no history lost
t=25  slaude: Yes — still here…
```

**Key details:**

- `env.idleMs()` reads `SLAUDE_IDLE_MINUTES` and converts to milliseconds. Set `0` to disable (sessions live forever — not recommended for production).
- The timer is re-armed on every inbound user message (`handleMessage`) and on turn end (`#fanout` for `result`).
- Resume uses the provider-native transcript store keyed by `sessionId`. The local `sessions` row holds `claude_started` to track whether a transcript exists; on resume-miss (provider has no record — e.g. after swapping `ANTHROPIC_BASE_URL` across providers) the gateway clears `claude_started` and reboots without `resume`.
- `sessions` rows survive process restarts, so idle TTL is not the same as persistence — even a restarted gateway reuses the row id and resumes via the provider.

**Do / Don't:**

| Do | Don't |
|---|---|
| Leave idle at `15` for normal teams | Set `0` unless you know the container will not restart for days |
| Let the resume handle gaps — no need to `@slaude` again after idle | Assume resume lost history — the transcript is on the provider, not in RAM |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plain replies never reach the agent | Thread not engaged — no initial `@slaude` | `@slaude hey` once, then plain messages work |
| `@someone` did not disengage | Mention parse saw `<@Uxxx>` only; `@here` / `@channel` / email-style `@foo` are not user IDs | `@` the actual user — `<@Uxxx>` format is what the gate matches |
| After restart, plain replies broke again | `sessions.engaged` is `0` for that thread | `@slaude` once more to flip it to `1` |
| Approval button says "not on the approver allowlist" | Clicker not in resolved set (SOUL.md scopes / env) | Add them to `## Approvers` with a scope that matches the plan summary, or use `SLAUDE_APPROVERS` fallback |
| Approval block never appeared | `request_approval` not wired (missing `ApprovalGate` on transport) or `SOUL.md` has no approvers and `SLAUDE_APPROVERS` is empty | Check `SOUL.md` extraction (`bun run validate-soul`) and verify the ApprovalGate's `request` was awaited |
| `/mode` says "unknown mode" | Alias typo | `/mode` without args lists aliases; valid: `ask`, `accept-edits`, `bypass`/`yolo`, `plan`, `dont-ask` |
| `/ingest` says "Send a message first" | No session row yet for this thread | `@slaude hi` once, then `/ingest` |
| Cron never fires | Row missing `slackTeamId` (legacy job) or `paused=1` | `/cron-list` — look for `paused`; delete and re-add legacy jobs |
| Status never shows "thinking…" | App manifest missing **Agents & AI Apps** / Assistant view, or `assistant:write` not granted | Reinstall the app after regenerating `manifest.json` |
| Attachment not visible | Agent replied with a path instead of `upload` | Nudge the agent: "upload the file via mcp__slaude_slack__upload" |

---

## 11. Source map (where to read more)

| Area | Files |
|---|---|
| Engagement gate | `src/gateway/core/gateway.ts` (`engaged`, `persistEngaged`, `app_mention` + `message` handlers), `src/db/sessions.ts` |
| 1on1 lock | `src/db/one-on-one.ts`, `src/gateway/slack/commands.ts` (`/1on1`), `src/agent/manager.ts` (per-initiator `CLAUDE_CONFIG_DIR`) |
| Mention-only | `src/db/mention-only.ts`, `src/gateway/slack/commands.ts` |
| Channel controls | `src/soul/loader.ts`, `src/soul/extract.ts`, `src/db/soul-overrides.ts` |
| Approval gate | `src/gateway/slack/approval-gate.ts`, `src/soul/loader.ts` (`selectApprovers`, `effectiveSoulForChannel`) |
| Permission gate | `src/gateway/slack/permission-gate.ts` |
| Slash commands | `src/gateway/slack/commands.ts` (`AGENT_COMMANDS`, `parseSlashCommand`, `helpText`) |
| Cron | `src/gateway/slack/cron-parser.ts`, `src/gateway/slack/cron-scheduler.ts`, `src/db/cron-jobs.ts` |
| Attachments | `src/gateway/slack/attachments.ts`, `src/gateway/slack/surface.ts` (`upload`) |
| Status | `src/gateway/slack/status.ts`, `src/gateway/core/status-text.ts` |
| Idle TTL / resume | `src/config/env.ts` (`idleMs`), `src/agent/manager.ts` (`#armIdle`, `#startSession`, `resume`) |

Changes to engagement or approvals must preserve the two durable invariants: (1) `disengage → engaged=0` survives restarts, and (2) approval resolution never trusts user-supplied IDs — only the gateway's allowlist derived from SOUL.md / env.

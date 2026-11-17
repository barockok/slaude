# The heartbeat round: one agent, all its sources, learned reactions under the mandate

**Date:** 2026-10-27
**Status:** Design, approach A chosen, owner questions answered; not built.
**Builds on:** the teammate epic (`2026-10-25-teammate-agent-epic-design.md`, phase E), the live smoke test (`docs/site/_content/field-notes/2026-10-26-live-smoke-test.md`).

## Intent

A teammate does a check-in round: looks at everything that reached them since the last round (mail, tool notifications, the channels they are in), weighs it against what they know about each place and person, and either tells someone, asks, acts, or lets it go. How they react to a kind of thing is learned from how people answered them before, and never goes past what their job allows.

Today's heartbeat is a narrow version of this. It sees only the agent's own memory (the five pass tools: `read_pages`, `list_pages`, `search`, plus `memoize` and `propose`, with which it rewrites its own checklist), has no MCP tools and no Slack read, keeps no notion of "since my last check", and can only inform. A reply under its post becomes a fresh session that has never seen the post, so it cannot learn from the reply (the smoke test's "stop, I don't need reminders about this one" was answered with a promise to stop and no mute).

The goal of this design: the heartbeat has the continuity of a teammate, without being a session that grows forever.

## Decisions taken in the conversation

1. **The heartbeat acts as the agent.** The agent has its own identity: Slack bot, email, every MCP connection made with `/mcp global connect`. The heartbeat uses only those. It never runs as a person and never reads a person's connections or private slice.
2. **One heartbeat per agent, one round for everything.** Ten relevant channels still mean one round, which sorts what it found into destinations. It speaks in a channel only when that channel has proactiveness enabled (today's `proactiveFor(persona, channel)`).
3. **Reactions are learned, not configured.** It starts by only informing. People's answers ("next time just reply with the standard terms", "don't tell me about these", "ask me first") change how a kind of item is handled. This changes in both directions, at any turn, including ordinary threads, not only replies to proactive posts. What to watch grows the same way ("keep an eye on the auditors' emails").
4. **The mandate is the ceiling.** The global mandate and a channel's mandate bound everything learned. A learned rule never supersedes it. When a request goes beyond it, or the agent is in doubt, it escalates to that channel's approver (the warden, or the manager as the catch-all).
5. **A rule applies where it was taught.** It can be widened to everywhere when the person who taught it asks, or agrees when the agent asks, and that person's mandate allows a global rule.
6. **A proactive post carries its context.** A reply under it reaches a turn that already knows what was posted, why, from which source item, and under which rule, so the reply can change the rule. The context lives in the database (the existing `proactive_posts` ledger, extended); the gateway already stitches a reply to its post and now hands that context into the turn. Slack message metadata, if used, carries only a marker, never content (any app in the workspace can read it).
7. **Approach A** (below): short locked-down rounds plus saved state, reading kept apart from acting.

## Goals

- Each round sees what is new since the previous round on every watched source of the agent, and only that.
- Each round knows what it already handled, what it said where, and how people responded.
- Reactions per kind of item (inform / ask / act / ignore) are learned from interaction, scoped to where they were taught, and clamped in code to a ceiling the SOUL states.
- A reply under a proactive post is a turn with the post's full context that can change the rule behind it.
- Acting on an item uses the normal agent loop (tools, mandate, approval cards), never the triage run.

## Non-goals

- Acting as, or reading for, a person. Per-person inboxes are out.
- A long-lived heartbeat session or a standing session per channel (approaches B and C).
- New sources beyond the agent's own MCP connections and memory. A Slack channel-history read is a separate decision (smoke-test observation) and stays out; a channel can still be a destination.
- Real-time triggers (webhooks, push). The round stays on the timer.
- Replacing promise checks. Commitments keep their own path; a round may note them but does not re-check them.

## Anti-goals (a failure even if it works)

- Text from an email or notification can cause a post, a write or an action that the rules and ceiling would not allow. Untrusted content shapes at most a triage result that code then checks.
- Something learned lets the agent do more than the mandate allows, or a casual message from anyone turns on unattended outbound actions.
- Cost grows with the age of the deployment (a transcript resumed every round).
- The agent repeats itself, or forgets an item it said it would follow up.
- A person's private content (a /1on1 page, their profile) shapes a post to someone else.

## Constraints

- The pass runner (`src/background/runner.ts`) is locked down by construction: `tools: []`, `strictMcpConfig`, only `mcp__slaude_pass__*` pre-approved, a PreToolUse deny hook, `persistSession: false`, budgeted in `background_runs`. Triage stays inside that shape; anything it gains is added as named pass tools, not by loosening it.
- MCP has no generic read-only flag. Which tools of a source count as reads has to be listed per source.
- Agent-identity MCP credentials live on the gateway (`src/db/mcp-credentials.ts`). The bridge (`src/gateway/core/mcp-bridge.ts`) picks the agent's credential when a turn's signed job claims say `runAs = agent`, and covers only `type: "http"` servers. A pass has no job token or session, so it cannot reach the bridge as built. Its reauth path posts a connect card into the session's thread, which a pass does not have. A `privateServices` server is never read by the round (it is someone's).
- `runPass` always mounts the five base pass tools; `extraTools` only adds.
- `onProactiveReply` runs only for threaded replies (`thread_ts !== ts`) and only when the brain is ready; its `outcome` result is discarded and normal handling continues. `proactive_posts` stores a hash of the text, not the text.
- `## Proactive` is parsed deterministically from SOUL text (`src/soul/proactive.ts`); only the SOUL can raise it, profiles only lower it. The ceiling extends this parser and keeps that rule.
- A thread under a proactive *channel* post is not engaged today: a reply without a mention reaches only `onProactiveReply` (an outcome) and no turn.
- Public repo: placeholders only in docs, tests and examples.

## Approaches considered

**A. Short rounds plus saved state (chosen).** Every wake is a fresh one-shot pass. Continuity is state, not transcript: a per-source watermark, a short journal the heartbeat keeps for itself, rule pages, and recent posts with their outcomes. A round is triage (read-only tools) → code checks → inform via `proactive_post`, act/ask dispatched as a turn into a thread. Flat cost; untrusted content never sits next to an outbound tool; the model rebuilds its picture each round from compact state, so the journal must be good.

**B. One long-lived heartbeat session per agent.** Resumed every wake; verbatim memory. Rejected: every resume re-reads a growing transcript (the smoke test measured 116k–237k input tokens for one thread resume, here every 30 minutes); compaction drops details unpredictably; email content accumulates in a context that keeps posting tools in reach, so an injection persists across rounds; one stuck session blocks every channel.

**C. Triage round plus a standing proactive session per destination.** Richest per-channel context. Rejected: B's cost per channel, more sessions to keep alive, and full-tool sessions carrying email content. A's thread dispatch gets most of the benefit where it matters: in the thread people reply to.

## Design

### 1. The ceiling (SOUL)

`## Proactive` and a channel's `### Proactive` gain two keys, parsed in `src/soul/proactive.ts` with the same deterministic rules:

```
## Proactive
- Enabled: yes
- Watch: mail, tracker          # MCP server names the round may read; default none
- Highest: inform               # inform | ask | act — default inform

## Channel <#C0EXAMPLE>
### Proactive
- Enabled: yes
- Highest: act
```

- `Watch` lists server names from the persona's MCP config. A name that is not configured, or is in `privateServices`, is ignored with a boot warning. Channel blocks do not take `Watch` (sources belong to the agent, not to a channel).
- `Highest` is the most a learned rule may reach there. A channel's value replaces the global one for that channel (replace semantics, like channel mandates). The manager DM uses the global value.
- `ask` means the agent posts and asks before acting. `act` means it may act without asking, through the normal turn (which still hits approval cards wherever those already apply).

`ResolvedProactive` gains `watch: string[]` and `highest: Level`.

### 2. Read tools per source

A per-source allowlist of the MCP tools that only read. It is kept beside the MCP config as `readTools` on the server entry:

```json
{ "mcpServers": { "mail": { "type": "http", "url": "https://mcp.example.com", "readTools": ["search_threads", "get_thread"] } } }
```

No `readTools` means the server is not watchable even if `Watch` names it (boot warning). The round never sees a tool outside the list. The names are the server's own tool names; the list is the operator's statement that they do not write.

### 3. State that gives continuity

All of it lives in the agent's own slice (`agent-<id>`) or slaude's database, never in a person's slice.

- **Watermarks**: a table `heartbeat_watermarks (agent_id, source, since, updated_at)`. Code owns them, and the model never sets one: `since` is the start time of the last round that finished that source without error. The round's prompt and each `read_<server>` call carry it ("items since <time>"), with a small overlap. A failed, aborted or reauth-skipped source keeps its old `since`, so the next round sees the same items again. The journal's handled-item ids and "unchanged" keep that from becoming a repeat post. An injected item therefore cannot make the agent skip later items. *(My call: the builder check found that a mark reported by the model would let one email move the mark forward.)*
- **Journal**: one page `self/heartbeat-journal` (type `heartbeat-journal`), rewritten each round with a hard size cap (proposal: 4000 characters). It lists open items ("waiting on a reply from the auditors since Tuesday; told the manager"), recently handled item ids per source (so a re-read is not re-handled), and anything the next round should look at again. The previous journal is part of the next round's prompt. The nightly review may tidy it.
- **Rules**: pages `rules/proactive/<slug>`, type `proactive-rule`, in the agent's slice:
  - `kind`: a short description of the items it covers ("invoice emails from vendors"). Matching an item to a kind is the triage model's call.
  - `scope`: a channel id, a DM's user id, or `global`.
  - `level`: `inform` | `ask` | `act` | `ignore`.
  - `how`: free text for `act` ("reply with the standard payment terms").
  - provenance: `taughtBy` (user id), `taughtAt`, `thread` (channel:ts), `quote` (their words, verbatim, invariant 2).
  - Superseded by tag, like other typed pages, never rewritten in place.
- **Watch list**: the existing checklist `self/heartbeat` stays the place where "what to look for" lives, now including sources ("mail: anything from the auditors"). It still grows by `memoize` from conversations.
- **Posts**: `proactive_posts` gains a `text` column (the post as sent: the agent's own outbound message, already in Slack) and a JSON `context` column (migration): `source` and `itemId` of the item, a one-paragraph `summary` written by the round (not the raw item), `ruleSlug` (or null for the default), the `level` applied, and `evidence`. The raw item stays at its source. Older rows have neither column, and their replies get only what the row has.

### 4. One round

Same schedule, slot claim, budget kind (`heartbeat`) and HA leader rules as today.

1. **Load.** Code reads the checklist, the journal, the rules (not superseded), the agent's posts of the last 7 days with their outcomes, the open commitments (for awareness only), the watermarks, and `ResolvedProactive` for the global scope and every channel with proactiveness on.
2. **Triage (the pass).** A locked-down pass with:
   - the memory read tools it has today;
   - the memory *read* tools only (`read_pages`, `list_pages`, `search`). The runner gains a per-pass choice of base tools, and triage drops `memoize` and `propose`, because untrusted content must not sit next to a brain write or a proposal card. *(My call.)* The checklist is then kept current by ordinary turns (`memoize` from conversations, as today) and by the nightly review, not by the heartbeat itself;
   - one pass tool per watched source, `read_<server>`, which forwards only that server's `readTools`, returns results with secrets redacted, and is capped per round (calls and bytes). It calls the server through a new pass entry point on the bridge: agent credentials only, no session, no job token, the same origin pinning and outbound policy. Only `type: "http"` servers can be watched; a stdio server named in `Watch` gets a boot warning. *(My call.)* When the agent's credential for a source needs reauthorising, the source is skipped for the round, the journal notes it, and the manager gets one DM per source per day saying the agent's connection to it needs `/mcp global connect` again. *(My call.)*;
   - one output tool `route_item`, called once per item worth anything: `{source, itemId, kind, destination (channel id | user id | "none"), proposedLevel, ruleSlug?, summary, evidence}`;
   - `write_journal {body}`.

   It has no `proactive_post`, no brain write, no Slack tool and no say over watermarks. An instruction inside a read item can at most produce a wrong `route_item`, which step 3 checks, or a misleading journal, which is capped and only ever read by the next triage.
3. **Decide (code).** For each routed item:
   - Resolve the rule: the given `ruleSlug` if it exists and its scope covers the destination, else the destination's own rule for that kind, then the global one, else the default `inform`. The model's `proposedLevel` may only lower the rule's level, never raise it. A destination-scoped rule wins over a global one.
   - Clamp to the ceiling: `min(level, Highest for that destination)`. A destination where proactiveness is off yields nothing. `ignore` yields nothing.
   - `inform`: `proactive_post` as today (every restraint check unchanged), with the context written to the row.
   - `ask` and `act`: a post as for `inform` (the text says what the agent proposes to do, or did), then a turn dispatched into that post's thread through the cron path, like a promise check, with origin `heartbeat` and the post's context in a `<proactive-context>` envelope. For `act` the turn is told to do `how`. For `ask` it is told to wait for an answer. The turn runs as the agent, never as a person, with the normal agent loop: its tools, the channel mandate, approval cards. It is budgeted on the round's ledger kind.
   - Items over the per-round post cap stay in the journal as open. They are not dropped.
4. **Finish.** Store the journal, and advance the watermark of each source read without error, only when the pass ended without error.

### 5. Replies and other teaching moments

- **Stitching.** `onProactiveReply` already finds the post by `(channel, thread_ts)` for threaded replies. For a reply that is not a stop phrase, the gateway now (a) engages the thread for the agent, so a channel reply without a mention gets a turn; that reply and later ones in the thread skip the decision gate, because the agent started the thread and the engagement then lasts as for any engaged thread *(my call)*, and (b) adds the post's `context` to that turn as a `<proactive-context>` block: the post text, summary, source and item id, the rule applied (with its provenance), and the ceiling for that place. The stop-phrase fast path stays as it is.
- **Changing a rule.** A new built-in tool for agent turns, `proactive_rule`, with `{kind, scope, level, how?, quote}`:
  - Lowering (`ignore`, `inform`, `ask` below the current level) is applied at once by anyone the post counts for (the DM's recipient; any human in the channel).
  - Raising is checked in code against `Highest` for the scope. Above it: refused, and the agent says so. Within it: applied when the speaker is an approver for that scope (the channel's approvers, or the manager and backup for `global` and DMs). Otherwise the turn opens a session approval card (`approvals.request`) in the thread where the rule was asked for, addressed to that scope's approvers, and the rule is written when one of them approves. *(My call: the teaching always happens in a live turn, which is what that card needs; the 14-day background proposal card is addressed only to the manager or one person.)*
  - `global` scope needs the speaker (or approver) to be one the global mandate allows: the manager or a global approver.
  - The tool writes the rule page with provenance from the turn's own envelope (`taughtBy` is the signed sender, never a model argument).
- **Only threaded replies count (owner's decision).** A top-level answer in a DM is not linked to a post; it reaches the agent as an ordinary DM turn without `<proactive-context>`. Linking unthreaded answers to the latest post is deferred.
- **Private places (owner's decision).** Rules may be taught in a DM; that is where the manager mostly teaches. `proactive_rule` is refused in a /1on1 thread, with a line saying to teach it outside the /1on1. A rule taught in a DM keeps the verbatim `quote` only while its scope is that DM. Widening it to `global` writes the new rule page with `taughtBy`, `taughtAt` and `thread` but no `quote`, so a person's own words never sit in a rule that shapes posts to others.
- **Outside proactive threads.** The same tool works in any thread ("keep an eye on the auditors' emails, and just tell me"). A watch request still updates `self/heartbeat` through `memoize`.
- **Natural stop phrasings.** These reach the agent turn and now carry the context, so the agent can lower the rule with `proactive_rule`, or mute the topic, instead of only promising to stop.

### 6. Message metadata

Each proactive post is sent with Slack `metadata` `{event_type: "slaude_proactive", event_payload: {post: <id>}}`. It is a marker only. The database row is the source of truth, and nothing reads the metadata in this design.

## What is left to the builder

- Exact migration numbers, table and column names, and the size caps (journal characters, read calls and bytes per round).
- The prompt text for triage and for the dispatched act/ask turn.
- How `read_<server>` tools are surfaced in mono vs gateway. Both run passes on the leader; the bridge already exists on the gateway, while mono has no bridge, so the builder decides whether mono connects the server in process.
- Whether the act/ask turn uses the promise dispatch transport directly or a sibling of it.
- How the nightly review treats rule pages and the journal (tidy, flag stale rules).

## Verification

- Unit: the parser for `Watch`/`Highest`; rule resolution and clamping (scope precedence, `proposedLevel` only lowering, ceiling); `proactive_rule` authorisation (lowering by a recipient, raising by an approver, raising past the ceiling refused, global scope).
- Pass shape: the triage pass offers only the memory tools, the `read_*` tools, `route_item` and `write_journal` (no watermark tool: code advances watermarks, §4 step 4), checked with the real CLI against the mock LLM, as the existing runner test does.
- Injection: a fixture email that tells the agent to post to a channel or to raise a rule produces at most a `route_item`, and code refuses whatever goes past the rules.
- Continuity: two rounds over the same fixture source. The second sees only new items, does not repost a handled one, and carries an open item forward. An aborted round does not move a watermark.
- Replies: a top-level DM answer after a post gets no `<proactive-context>`; `proactive_rule` in a /1on1 is refused; widening a DM rule to global drops the quote and keeps the provenance; a channel reply without a mention under a proactive post gets a turn with `<proactive-context>`; "just reply to these from now on" from a non-approver produces an approval card, and from an approver produces a rule page with provenance.
- Live smoke (as in the 2026-10-26 run): the agent's own test inbox connected as an MCP server, one channel at `Highest: act`, one at `inform`.

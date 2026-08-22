# Decision notes with Slack provenance

**Date:** 2026-08-22
**Status:** implemented behind `SLAUDE_DECISION_NOTES_ENABLED` (default off)

## Summary

Add an explicit, durable decision-note ledger to Slaude. A user can ask the
agent to summarize decisions already made in the current Slack thread, save the
summary under a tag, and later list the saved notes with links back to the
original Slack discussions.

The confirmed command names are:

```text
/note-add #task-framework [optional summarization instruction]
/note-list [optional limit]
/note-history #task-framework [optional limit]
```

Decision notes are not ordinary agent memory and are not gbrain pages. They are
structured, append-only records whose source, author, creation time, and Slack
permalink remain available for deterministic retrieval.

## Problem

Important decisions are often made inside long Slack threads. Later, a team
member must remember the right search terms, locate the thread, and reconstruct
what was decided. General memory or semantic search can help rediscover a
discussion, but neither is a reliable decision register:

- semantic retrieval can omit records or rank them inconsistently;
- conversational memory may be compacted or scoped to one agent session;
- a generated answer may lose the link to its source discussion;
- Slack search finds messages, not a curated sequence of decisions.

Slaude needs an explicit capture action and an exact history operation.

## Goals

1. Capture decisions from the current Slack thread only when a user explicitly
   invokes `/note-add`.
2. Generate a concise, evidence-bound summary of the discussion before the
   command message.
3. Store the note durably with a stable tag and Slack provenance.
4. Discover available note tags and their activity through `/note-list`.
5. List notes newest-first with direct Slack links through `/note-history`.
6. Let the agent answer natural-language decision-history questions using the
   same authoritative ledger.
7. Prevent summaries from private discussions leaking into broader channels.
8. Make command retries idempotent.

## Non-goals for the first version

- Automatically detecting decisions without an explicit command.
- Replacing gbrain, knowledge pages, or episodic memory.
- Editing, deleting, merging, or moving existing notes from Slack commands.
- Summarizing arbitrary channel history outside the current thread.
- Searching decision notes semantically.
- Importing historical decisions in bulk.
- Creating a project-management or task-tracking system.

## User experience

### Add a note

The command is invoked inside the Slack thread containing the decision:

```text
@slaude /note-add #task-framework
```

With an optional focus instruction:

```text
@slaude /note-add #task-framework Focus on ownership and rollout timing.
```

If a decision is found and saved:

```text
:white_check_mark: Decision note added to `#task-framework`

*Use one owner for each task*
Every task has one directly responsible owner. Contributors may assist, but
ownership does not become shared.

<https://workspace.example/slack/permalink|View Slack discussion>
```

If the thread does not contain an explicit decision:

```text
:information_source: I couldn't find a clear decision in this thread, so no
note was saved. Add the decision to the thread or provide a more specific
instruction and try again.
```

If `/note-add` is posted as a channel root message rather than inside an
existing thread:

```text
:warning: `/note-add` must be used inside the thread that contains the
decision. I won't infer context from unrelated channel messages.
```

### Discover note tags

```text
@slaude /note-list
```

Example response:

```text
*Decision note tags* (3 visible)

• `#task-framework` — 5 notes · latest <t:1787360400:R>
  Use one owner for each task
• `#release-process` — 3 notes · latest <t:1786755600:R>
  Require a rollback plan before release
• `#api-design` — 2 notes · latest <t:1786150800:R>
  Version breaking response changes
```

`/note-list` is the discovery view: one row per visible tag, ordered by the
most recent visible note. It does not print every historical note. A user picks
a tag from this list and opens its chronology with `/note-history #tag`.

The optional numeric argument controls the number of tags:

```text
/note-list 30
```

Recommended default: 20. Recommended maximum: 50. Counts include only notes
the current command is allowed to reveal.

### List note history

```text
@slaude /note-history #task-framework
```

Example response:

```text
*Decision history — `#task-framework`* (3 notes)

• *Use one owner for each task* — <t:1787360400:d>
  Every task has one directly responsible owner.
  Added by <@U123> · <https://workspace.example/slack/permalink|View discussion>

• *Use four task states* — <t:1786755600:d>
  Tasks move through pending, active, blocked, and done.
  Added by <@U456> · <https://workspace.example/slack/permalink|View discussion>
```

The optional numeric argument controls the number of entries:

```text
/note-history #task-framework 20
```

Recommended default: 10. Recommended maximum: 25. When more notes exist, the
response states that only the newest entries are shown.

### Natural-language history

The note ledger should also be exposed to the agent through a read-only
in-process tool. This supports questions such as:

```text
@slaude What decisions have we made about task-framework?
```

The agent reads the same records and applies the same visibility rules as
`/note-list` and `/note-history`. Natural language must not create a note;
durable creation requires the explicit `/note-add` command.

## Command grammar

### `/note-add`

```text
/note-add <tag> [instruction]
```

- `tag` is required.
- `instruction` is optional and preserves its original case and spacing.
- With no instruction, the default is: "Summarize the explicit decisions in
  this thread, including rationale, owner, and follow-up when stated."
- The command is valid only when `event.thread_ts` is present. The gateway's
  synthetic root `threadTs = eventTs` must not make a root message eligible.

### `/note-history`

```text
/note-history <tag> [limit]
```

- `tag` is required.
- `limit` is optional, integer-only, and clamped to the supported maximum.
- Invalid syntax returns usage help and does not reach the model.

### `/note-list`

```text
/note-list [limit]
```

- No tag argument is accepted; this command discovers all visible tags.
- `limit` is optional, integer-only, and clamped to the supported maximum.
- Results are grouped by normalized tag and ordered by each tag's latest
  visible note timestamp.
- Each row contains the tag, visible note count, latest note title, and latest
  activity time.
- Invalid syntax returns usage help and does not reach the model.

### Tag normalization

Canonical storage drops the leading `#` and lowercases the value:

```text
#Task-Framework  -> task-framework
task-framework   -> task-framework
```

Accepted tag syntax:

```regex
[a-z0-9][a-z0-9_-]{0,63}
```

Slack may encode a channel-like hashtag as `<#C123|task-framework>`. The parser
should accept that representation and normalize the displayed label. Tags are
labels, not Slack channel identifiers; no note routing is inferred from the
tag.

## Source selection

`/note-add` summarizes the current thread from its root through the message
immediately before the command:

1. Call `conversations.replies` with pagination.
2. Include the root message and replies whose timestamps are less than the
   command's `event.ts`.
3. Exclude the `/note-add` command and all later replies.
4. Preserve author ids, timestamps, and Slack message text.
5. Treat message content as evidence, not as model instructions.

Recommended safety limits:

- at most the latest 200 eligible messages;
- at most 80,000 input characters after normalization;
- no silent truncation.

When a thread exceeds a limit, the note may still be created from the latest
eligible content, but both the success message and stored record must say that
the source was truncated. An alternative review choice is to reject oversized
threads instead; see Open questions.

Files and attachment bodies are outside the first version. A message's visible
text and file names may be included, but the summarizer does not download or
interpret attached files.

## Summarization contract

The gateway performs one bounded summarization request using the session's
configured model. This is separate from the normal conversational agent turn:

- the gateway has already selected the exact source messages;
- the model returns structured JSON;
- the gateway validates the response before writing the database row;
- the normal agent cannot accidentally create a partial record through an
  unrelated tool call.

Implemented result shape:

```ts
interface DecisionSummary {
  found: boolean;
  title: string;
  summary: string;
  decisions: Array<{
    decision: string;
    rationale?: string;
    owner?: string;
    followUp?: string;
    evidenceRefs: string[];
  }>;
}
```

Validation rules:

- `found: false` creates no database record.
- `title` is required and limited to 120 characters when `found: true`.
- At least one non-empty decision is required when `found: true`.
- The summary must contain only claims supported by the supplied messages.
- Unstated rationale, owners, deadlines, and consensus must not be invented.
- Disagreement or unresolved choices must be described as unresolved, not as a
  decision.
- Slack mention tokens such as `<@U123>` may be preserved.

The optional user instruction can change emphasis, but cannot expand the
source beyond the current thread or override the evidence-only rules.

## Persistence

### SQLite schema

```sql
CREATE TABLE IF NOT EXISTS decision_notes (
  id                   TEXT PRIMARY KEY,
  tag                  TEXT NOT NULL,
  title                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  decisions_json       TEXT NOT NULL,
  instruction          TEXT,
  slack_team_id        TEXT NOT NULL,
  slack_channel_id     TEXT NOT NULL,
  slack_thread_ts      TEXT NOT NULL,
  source_message_ts    TEXT NOT NULL,
  source_permalink     TEXT NOT NULL,
  source_message_count INTEGER NOT NULL,
  source_truncated     INTEGER NOT NULL DEFAULT 0,
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  persona_id           TEXT NOT NULL DEFAULT 'default',
  summarizer_model     TEXT NOT NULL,
  UNIQUE (
    slack_team_id,
    persona_id,
    tag,
    slack_channel_id,
    source_message_ts
  )
);

CREATE INDEX IF NOT EXISTS idx_decision_notes_history
  ON decision_notes (
    slack_team_id,
    persona_id,
    tag,
    created_at DESC
  );
```

`source_message_ts` is the `/note-add` command timestamp. It gives each explicit
capture action an immutable source point and makes retries idempotent. The
permalink should also point to that command reply, because Slack opens it with
the surrounding thread context.

The history display may use a short prefix of `id`, preparing for a possible
future edit, retract, or inspect command without adding those operations now.

### Why this is not memory or gbrain

The SQLite table is the authoritative decision ledger:

- `/note-list` is an exact grouped query over visible records;
- `/note-history` is an exact indexed query, not semantic retrieval;
- provenance fields are required, not best-effort metadata;
- records do not disappear through context compaction;
- identical tags produce a chronological list every time.

After the feature is stable, notes could optionally be mirrored into gbrain for
semantic discovery. The mirror must not become authoritative and is outside
this version.

## Slack permalink

Before saving, call `chat.getPermalink` for the `/note-add` command message:

```ts
client.chat.getPermalink({
  channel: channelId,
  message_ts: eventTs,
});
```

Do not construct workspace URLs manually. If Slack cannot return a permalink,
the recommended behavior is to fail the command without writing a note. This
preserves the invariant that every decision note has working provenance and
lets an idempotent retry succeed later.

Implementation must extend the gateway's `WebClientLike` contract and the sim
transport with `chat.getPermalink`.

## Scope and visibility

### Record scope

Recommended scope is `(slack_team_id, persona_id, tag)`. Notes created by one
persona are not automatically exposed through another persona. This matches
the existing per-persona session and brain isolation.

### Recommended creation ACL

- Trusted channel: any user who passes the existing inbound gates may add a
  note.
- Allowed or restricted channel/DM: manager, backup manager, or the effective
  channel approver may add a note.
- Existing blocklist, ignore, 1on1, and channel gates run before note handling.

This permits collaborative capture in the team zone while reducing ledger
spam from broader surfaces.

### Recommended read privacy

Posting a private decision summary into a broader channel leaks information
even if the requester personally has access to the source link. Therefore:

- In a channel, `/note-list` and `/note-history` use only notes sourced from
  that same channel. They may aggregate across threads in the channel.
- In an actual DM, both commands may aggregate notes across channels, but only
  after confirming the requesting user belongs to each source conversation.
- A locked 1on1 inside a channel still uses same-channel visibility. A thread
  lock controls who the agent hears; it does not make the Slack channel or the
  agent's response private from other channel members.
- Inaccessible notes are omitted without exposing their title, summary, tag,
  count, or source channel.
- Natural-language tag discovery and history use the identical filtering
  function.

Private-channel membership checks use `conversations.members`, including
cursor pagination. Results may be cached briefly in memory, but a cache miss or
Slack error must fail closed.

## Data flow

### `/note-add`

```text
Slack thread command
  -> existing inbound gates
  -> parse tag + optional instruction
  -> require a real parent thread
  -> paginate replies before command timestamp
  -> get permalink for command message
  -> summarize selected messages into validated JSON
  -> found=false: reply, do not write
  -> INSERT decision_notes (idempotent unique key)
  -> reply with saved summary + Slack link
```

### `/note-history`

```text
Slack command
  -> existing inbound gates
  -> normalize tag + parse limit
  -> query exact tag in current team/persona
  -> apply channel/DM visibility filter
  -> render newest-first with source links
```

### `/note-list`

```text
Slack command
  -> existing inbound gates
  -> parse limit
  -> query notes in current team/persona
  -> apply channel/DM visibility filter before aggregation
  -> group by tag with visible count + latest note metadata
  -> render tags ordered by latest visible activity
```

### Natural-language history

```text
Agent turn
  -> in-process read-only list_note_tags or list_decision_notes tool
  -> exact DB query + shared visibility filter
  -> agent answers with returned tags, summaries, and links
```

## Components

| File | Responsibility |
|------|----------------|
| `src/db/schema.ts` | Create and migrate the `decision_notes` table and index. |
| `src/db/decision-notes.ts` | Typed insert, idempotent lookup, visible tag aggregation, count, and newest-first list operations. |
| `src/gateway/slack/commands.ts` | Parse `/note-add`, `/note-list`, and `/note-history`; add all three to generated help. |
| `src/gateway/core/gateway.ts` | Enforce gates, load history, obtain permalink, invoke summarizer, save, and render responses. |
| `src/notes/summarize.ts` | Evidence-bound provider request and strict structured-response validation. |
| `src/notes/visibility.ts` | Shared channel/DM note visibility rules for slash and agent-tool reads. |
| `src/notes/read.ts` | Shared visibility-scoped payloads for natural-language reads. |
| `src/notes/render.ts` | Slack-safe escaping and bounded command responses. |
| `src/notes/mcp-tools.ts` | Read-only `list_note_tags` and `list_decision_notes` tools for natural-language questions. |
| `src/gateway/core/transport.ts` | Add `chat.getPermalink` to `WebClientLike`. |
| `src/gateway/sim/transport.ts` | Simulate thread replies, membership, and permalinks. |

Exact placement of the read tools can follow the existing in-process MCP
naming convention. A proposed server name is `slaude_notes` with two tools:

```text
mcp__slaude_notes__list_note_tags
mcp__slaude_notes__list_decision_notes
```

No agent-facing write tool is proposed. `/note-add` remains the sole creation
path.

## Idempotency and concurrency

- A repeated delivery of the same Slack event is already stopped by gateway
  deduplication.
- Database uniqueness also protects against retries after a restart or a
  timeout whose final response was not observed.
- On a unique-key conflict, load and return the existing note instead of
  creating a second summary.
- The database insert occurs only after history, permalink, and summary
  validation all succeed.
- Two different `/note-add` command messages intentionally create two notes,
  even if their tags and source thread are the same.

## Failure behavior

| Failure | Result |
|---------|--------|
| Command used outside a thread | Explain thread-only requirement; no model call or write. |
| Invalid or missing tag | Show command usage; no model call or write. |
| Thread history unavailable | Report Slack read failure; no write. |
| Permalink unavailable | Report provenance failure; no write. |
| Summarizer unavailable or invalid JSON | Report summarization failure; no write. |
| No explicit decision found | Explain that nothing was saved. |
| Database write fails | Report failure; do not claim the note was saved. |
| No visible tags exist | Reply "No decision note tags found" without revealing hidden counts. |
| History tag has no visible notes | Reply "No decision notes found" without revealing hidden counts. |
| Membership check fails | Omit cross-channel note; fail closed. |

Status/reaction cleanup must follow the normal gateway lifecycle even though
the command does not run a conversational agent turn.

## Observability

Recommended metrics:

```text
slaude_decision_notes_total{result="created|no_decision|duplicate|error"}
slaude_decision_note_list_total{result="found|empty|error"}
slaude_decision_note_history_total{result="found|empty|error"}
```

The three counters are implemented. A summary-duration histogram is deferred
because the current metrics registry exposes counters and gauges only.

Logs may include note id, normalized tag, team/channel identifiers, message
count, truncation state, and failure category. They must not log thread text,
the generated summary, private permalinks, or provider credentials.

## Testing

### Parser tests

- `/note-add #task-framework` parses with the default instruction.
- `/note-add #task-framework Focus on ownership` preserves instruction case.
- `/note-add <#C123|task-framework>` normalizes the label.
- Invalid and oversized tags return no command hit or a usage error.
- `/note-history #task-framework` uses the default limit.
- `/note-history #task-framework 20` accepts the explicit limit.
- `/note-list` uses the default limit and accepts no tag.
- `/note-list 30` accepts an explicit limit.
- Non-numeric, zero, negative, and excessive limits are handled consistently.

### Database tests

- Insert and list newest-first by exact normalized tag.
- Team and persona scopes do not cross.
- Same command message and tag returns the existing record.
- Different command messages in the same thread create distinct notes.
- Structured decision JSON round-trips safely.

### Summarizer tests

- Explicit decision produces valid structured output.
- Debate without resolution returns `found: false`.
- Missing rationale or owner remains absent rather than inferred.
- A Slack message containing prompt-like text is treated as evidence only.
- Invalid JSON and unsupported claims fail without a database write.
- Truncation metadata is preserved.

### Gateway and sim tests

- Root-channel `/note-add` is rejected.
- The command message and later messages are excluded from the source.
- Successful add returns the saved summary and simulated permalink.
- Provider, Slack, and DB failures never produce a false success reply.
- Retry returns the original note rather than adding a duplicate.
- Note list groups by normalized tag, uses visible counts, and orders tags by
  latest visible activity.
- Channel history contains only same-channel notes.
- DM list and history include only source conversations the requester can
  access; channel-hosted 1on1 threads remain same-channel only.
- Hidden notes do not affect the visible count.
- Natural-language tools and slash commands apply identical filters.
- All three commands appear automatically in Slack and sim help surfaces.

## Rollout

1. Ship behind `SLAUDE_DECISION_NOTES_ENABLED=false` by default.
2. Exercise add/list/history in the sim with fixed summarizer responses.
3. Enable for one test persona and verify Slack pagination, permalink behavior,
   idempotency, and private-channel filtering.
4. Enable by default after the canary period.
5. Consider gbrain mirroring, edit/retract lifecycle, and semantic search only
   after the ledger has real usage data.

Disabling the feature hides the commands and read tools but retains existing
rows. Re-enabling restores access without migration or data loss.

## Acceptance criteria

- `/note-add #tag` in a real thread creates exactly one durable note from
  messages preceding the command.
- A saved note contains a validated title, summary, structured decisions,
  creator, timestamp, source identifiers, model, and working Slack permalink.
- A thread with no explicit decision creates no row.
- `/note-list` returns visible tags with visible counts and latest activity.
- `/note-history #tag` returns exact, newest-first, source-linked results.
- Retrying the same command cannot create a duplicate.
- Cross-channel summaries cannot be posted into ordinary channels.
- DM cross-channel list and history fail closed for inaccessible sources;
  channel-hosted 1on1 threads never aggregate across channels.
- The conversational agent can read, but cannot implicitly create, decision
  notes.
- Existing Slack command help and sim completion include all three commands.

## Implemented decisions

The command names are confirmed:

- `/note-add`
- `/note-list`
- `/note-history`

1. **Creation ACL:** anyone in trusted channels; manager, backup, or effective
   approver elsewhere.
2. **Read privacy:** same-channel results in channels; access-checked
   cross-channel results only in actual DMs. Locked 1on1 threads do not weaken
   channel visibility boundaries.
3. **Persona scope:** notes are isolated by persona rather than shared by every
   agent identity.
4. **Oversized threads:** summarize the latest bounded portion and disclose
   truncation, rather than rejecting the command.
5. **Append-only first version:** no edit or delete command; a later note may
   supersede an earlier decision, but both remain in history.
6. **Permalink invariant:** fail without writing when Slack cannot produce the
   source permalink.
7. **Dedicated summarization call:** validate structured output before the DB
   write instead of asking the conversational agent to call a write tool.

## Implementation verification

The implementation includes parser, storage, summarizer, rendering, visibility,
permission-gate, sim, and end-to-end gateway tests. Security-specific coverage
verifies bounded source input, strict evidence references, fail-closed
membership checks, validated Slack HTTPS permalinks, escaped Slack markup,
non-mentioning author display, generic tool failures, and a read-only agent MCP
surface. The feature remains disabled until explicitly enabled for canary use.

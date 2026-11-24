# Memory boundaries: a trusted channel is its own boundary

**Date:** 2026-11-24
**Status:** design, not built. Issue: #247. Follows the removal of the agent-level round (rc.44, field note `2026-11-23-proactive-per-channel-only.md`).

## Problem

One persona, two trusted channels. Work started in one channel reached the other without anyone choosing that. Four paths carried it (see #247): the global mandate filling in for a channel with no scoped one, the per-channel checklist, `memory_search`, and `read_channel`. Sessions did not leak. The memory and the reads did.

rc.44 closed the round's journal and the global `Read:` list. The paths that remain are below.

## Principle

A trusted channel is its own boundary. Nothing crosses from one trusted channel to another unless it is promoted. Promotion is the only way across, and a person who may decide it (a manager) decides it.

## What the code does today (checked on `origin/main`, rc.44)

- A turn's memory scope is one **source slice**, never a channel. `resolveBrainScope` (`src/knowledge/scope.ts`) gives a turn the persona slice `agent-<id>` (plus the legacy `agent`), `shared`, `public`, KB sources and the speaker's profile. `channelTrust` (`trusted`, `public`, `unknown`) only decides which slice, not which channel.
- Every trusted turn of the persona, in any channel, reads and writes that one slice. So `memory_search` and `memory_think` in channel B return what was saved in channel A.
- gbrain enforces scope in SQL by source: `buildScopedCtxAuth` (`src/knowledge/brain.ts`) passes `sourceId` (write) and `allowedSources` (read). Sources are created on first write by `ensureSource`. Every reader (search, think, get, list, graph, per-turn context) already works from `allowedSources`.
- Per-turn conversation pages (`conversations/<session>`) are written to the persona slice (`src/memory/scope.ts`), the same slice `memory_search` covers.
- `self/heartbeat/<channel>` (the checklist) already lives per channel by name, but in the persona slice, so a search in another channel can read it.
- `read_channel` reaches every channel the agent works in on its own (`proactiveRead`), so one proactive channel can read another.
- A proactive channel with no scoped mandate runs on the global one: `m.channels[channel] ?? m.global` (`src/proactive/channel-wake.ts`).

## Design

### 1. The boundary is a brain source

One source per (persona, trusted channel): `bnd-<agent>-<channel>` (about 27 characters), hashed only when it would exceed the 32-character source id limit. The workspace is not part of the id: a cron job has no team, a single-app mono turn has an empty one, and the gate maps both differently, so one channel could otherwise hash to two sources. It gets its own `StoreKind` ("boundary") so `storeKind` does not read it as `agent-`.

Why a source and not a tag on each page: the brain enforces sources in SQL. A tag would need a filter in about eight readers that fails open, the think gather has leaked across sources before (see the `scopedThinkEngine` comment), and an untyped page passes through `composePage` unchanged, so the model could write its own tag. A new source needs no migration, because sources are created lazily on first write.

Code changes: add `channel` to `ScopeInput` and `GateInput`, set where the gate is built (`brainGateFor` in `gateway.ts`; nodes get it from the signed `claims.channel`), and add the boundary source to the scope.

### 2. Read and write rules

| Turn | Writes to | Reads |
|---|---|---|
| Trusted channel B (any speaker, manager included) | `bnd(B)` (auto: the gate treats the current boundary like the persona slice today) | `bnd(B)`, `agent-<id>`, legacy `agent`, `shared`, `public`, KBs, the speaker's profile |
| Wake or cron in B | `bnd(B)` | the same |
| Background turn with no channel (nightly, triage) | nothing by default | `agent-<id>` and shared tiers only |
| Manager DM | its own boundary (decided) | as a trusted channel |
| /1on1, non-manager DM | `user-<id>` (unchanged) | unchanged; never gains a boundary source |
| Public or unknown channel, non-manager | unchanged | `public` only |
| Manager in a public or unknown channel | `bnd(channel)` (was `agent-<id>`) | `bnd(channel)`, persona-wide tier, `shared`, `public` |
| Cron or wake with no team | `bnd(B)` by channel, never by team | as a wake in B |

Conversation pages move to `bnd(B)`. `agent-<id>` is now the **persona-wide tier**: what the persona knows across channels (identity, lessons, promoted pages). A boundary source is never readable from another channel's turn.

### 3. Promotion

Three separate acts, because the audiences differ (only the first ships in this work; publish is later, decided):

1. **Promote**: copy a page from `bnd(B)` to `agent-<id>`, readable by the persona in every trusted channel and /1on1. The original stays in its boundary. The copy carries `promoted_from`, `promoted_by` and `as_of` in its frontmatter.
2. **Share**: to `shared` (exists today, carded).
3. **Publish**: to `public`, which allow-listed non-managers read. No `memory_save` target writes `public` today, so this is new and waits.

Promote is tier `manager`, not `approval`: an approval-tier `put_page` is covered by a standing grant, and the approver is only checked for the manager tier (`gated-dispatch.ts`). Promote and demote take an explicit source, because `memory_delete` runs in the turn's own write source and could not reach the copy in `agent-<id>`. In `classifyBrainOp` the check sits before the `userId === null` automatic branch, as the /1on1 check does, or every wake could promote freely. Demotion deletes the promoted copy through the same explicit-source path.

### 4. The other paths in #247

- **Checklist.** Move `self/heartbeat/<channel>` into `bnd(channel)`; the channel job reads it from that one source.
- **`read_channel`.** Refuse any channel other than the one the turn runs in, in every turn. rc.44 already limits it to channels the agent works in; this narrows it to the current one.
- **Global mandate fill-in.** A proactive channel with no scoped mandate must not run on the global one. Warn at boot and skip the wake. Independent of memory; ships first.
- **Outbound actions in a proactive turn.** Sending mail, posting outside the channel and messaging people need approval unless the mandate in force for that channel allows them.

### 5. Existing pages

Pages in `agent-<id>` become persona-wide by default: no migration, nothing breaks. The cost is that historic channel pages stay visible everywhere until moved. A one-time operator job moves the attributable ones (`self/heartbeat/<channel>`, `conversations/<session>`) into the right boundary. Everything else gets a manager-run review listing, not an automatic guess.

### 6. Lessons

`self/lessons` stays persona-wide (capped at 40 lines, rewritten nightly, injected into every turn). The nightly pass that proposes lessons reads conversations from every channel and writes to the persona-wide page, so it is itself a crossing: a lesson sourced from one boundary must be generalised before it is written, or go through promotion. Open decision 1.

## Review findings (2026-11-24)

An independent review read the spec against the code. Findings that change the design (checked by me where marked):

1. **Four writes already cross tiers without a card.** A wake has `userId === null`, and `classifyBrainOp` returns `auto` for it before it looks at the target, so a wake's `memory_save target:"shared"` is not carded (checked, `gated-dispatch.ts:116`). A manager in a non-trusted channel resolves to `agent-<id>` and auto-passes. Agent-scope background passes write `self/lesson-proposals` to `agent-<id>` from every channel's transcripts. Proactive rules live in the agent slice. Each needs a decision before "promotion is the only way across" is true. The wake-to-`shared` write is a bug on its own and gets fixed in the gates change.
2. **Fixed-slice readers go blind once conversation pages move.** Nightly review reads timelines only from `agent-<id>` (checked, `nightly-review.ts:191`). `activityScopeOf` returns null for any source that is not `agent-<id>` or `user-` (checked, `thread-activity.ts:43`) and `passScopeOf` accepts only those (checked, `quiet-moment.ts:88`), so thread summaries stop. The design therefore needs a boundary scope in `thread_activity.scope` and the pass scope, and the nightly pass runs per boundary, writing its proposals into that boundary. A lesson from one boundary then reaches the persona-wide `self/lessons` only through promotion or generalisation (open decision 1).
3. **Thread history breaks at the flag flip.** Existing sessions' pages stay in `agent-<id>`, so `<recent-turns>` and `memory_thread_history` go empty until the move job runs. Read conversations from `bnd(B)` then `agent-<id>` during the transition instead of requiring the move job first.
4. **Source-kind checks that mishandle a new kind:** `storeKind` (returns `other`), `isPrivateStore` in the console API, `isAgentLike` in brain-migrate, and `runAsOf` in the commitment index.
5. **Supersede is per source**, so a turn in B cannot correct a persona-wide page and writes a shadow instead. `memory_about` skips `bnd-` sources.
6. **Federated reads cost.** The per-turn block scans commitments in every readable source under a 1.5 second deadline and drops the whole block on timeout, so many sources raise that risk. `gather` fans out one search per source.
7. **Rollback and manager DMs.** A manager-DM boundary cannot be enumerated from `trustedChannels`. Resolved: with the flag off, list sources by the `bnd-<agent>-` prefix. The reviewer would keep DMs persona-wide; that is rejected (decided).
8. **More leaks to list:** `list_cron_jobs` returns every active job, `read_channel` checks only the target channel and never the caller's, public-channel transcripts are stored in `agent-<id>`, and skills are persona-wide.

The review also recommended shipping the non-memory gates first. Decided: memory stays first (see Decisions).

## Rollout

- Flag `SLAUDE_MEMORY_BOUNDARIES=off|on`, off for one RC, then on. Reads include every `bnd-*` source of the persona's trusted channels even when the flag is off, so a rollback does not hide pages.
- It changes the agent loop, so it ships as an RC. No schema change.
- Order (decided: memory first): (1) boundary sources behind the flag, with conversation pages and the checklist moved into them; (2) promotion; (3) the move job for existing pages; (4) lessons; (5) the other #247 gates (mandate fill-in, proactive outbound approval, `read_channel` to the current channel). The gates do not depend on memory and can be pulled forward if the memory work slips.

## Tests

- A table test per row of section 2.
- Gate ordering: a wake cannot promote; a promote card is manager-only.
- Sim scenario: save a page in channel A, wake in B, search returns nothing, `read_channel` of A is refused, B's checklist is untouched. A real-brain variant beside `scenarios-real/brain-smoke.yaml`.
- A rollback test: flag off still reads the boundary sources.

## Leaks this does not close

- Channel B's live session context and checklist already hold A's work if the leak happened before; they need a manual clean.
- Persona-wide pages from before the change (until moved or reviewed).
- `shared/channels/<channel>` notes are readable from every channel by design.
- The speaker's profile follows the person across channels by design.
- Routes outside memory: mail search through MCP, workspace files, cron jobs.

## Not verified

- gbrain internals (an external dependency): the cost of many sources, whether links, graph or takes cross sources, whether search indexes timeline rows (this decides how much conversation pages leak today), and whether timeline rows can be migrated.
- That a mono turn's channel is stable inside a channel session.
- The commitment scheduler's read path (`indexWritten` is keyed by agent).
- Whether a durable approval audit log exists.
- The 32-character source id limit, taken from a code comment.

## Decisions

Decided on 2026-11-24:

- A manager DM is its own boundary.
- Existing pages stay persona-wide, and a one-time job moves the attributable ones (checklists, conversation pages). The rest get a manager review list.
- Publish to `public` is later. Only promote to the persona-wide tier ships now.
- Memory boundaries ship before the other #247 gates.

Decided after the review, 2026-11-24:

- **Order stays memory first.** The agent-level round and the global `Read:` are gone (rc.44), so a wake and `read_channel` are relative to the channel that switched proactive on. The part rc.44 did not finish: `read_channel` still reaches every channel the agent works in on its own, so one proactive channel can read another. It narrows to the current channel as part of this work (it is a few lines), not as a separate release. The mandate fill-in and proactive outbound approval stay on the list, after memory.
- **Wake writes to `shared`: create is automatic, modify needs a card.** A page that does not exist in `shared` is saved without a card. A write that changes an existing `shared` page (overwrite, supersede, delete) is approval tier. A wake has nobody to answer a card, so a wake's modify is refused with a message to ask in the channel. Interactive turns are unchanged (every `shared` write cards today).
- **A manager DM stays its own boundary.** Putting DMs in the persona-wide tier would make them readable by every trusted turn, close to public. The rollback cost is solved differently: with the flag off, the read union is built by listing sources with the `bnd-<agent>-` prefix (the brain admin already lists sources, `listBrainSources` in the scheduler), not from `trustedChannels`, so manager-DM boundaries stay readable.

Decided on the open items, 2026-11-24:

- **Every memory write is bound to a boundary by default.** `memory_save` with no target writes to the boundary of the turn. A page leaves it only by an explicit act: `target: persona` (promote, manager tier), `target: shared` (carded; create automatic for a wake, see above). A background pass is no exception: it writes into the boundary it read.
- **A manager in a public or unknown channel is bound to that channel's boundary for what it writes, and reads the promoted tiers.** Writes default to `bnd-<agent>-<channel>`. Reads are that boundary, the persona-wide tier (`agent-<id>`), `shared` and `public`: promoted memory is memory a manager approved for sharing, so it is readable wherever the manager is. What is not readable there is another channel's boundary. This replaces today's rule only on the write side: today a manager turn in any channel writes to `agent-<id>` (`scope.ts:198`). A non-manager in a public channel is unchanged (`public` only).
- **Lessons are generalised before they are written.** The nightly pass reads one boundary at a time and writes lesson proposals into that boundary. The lessons-upkeep pass then merges proposals from every boundary into `self/lessons`, rewriting each line so it names no channel, person, customer or task, only the behaviour to repeat or avoid. A proposal it cannot generalise stays in its boundary.
- **Proactive rules are not gone with the global round.** They are still read by the channel wake, `proactive_post` and reply context (`loadRules`, `rule-tool.ts`), and a rule's `scope` is already a boundary: a channel id, a DM user id, or `global`. Rules scoped to a channel or a DM live in that boundary. A `global` rule stays persona-wide, and teaching one already needs an approver. `loadRules` reads the boundary plus the persona-wide tier. Lesson proposals are unrelated to proactiveness (written by the nightly review) and follow the lessons rule above.

Open: none blocking the plan.

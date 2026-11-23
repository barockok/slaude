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

One source per (persona, trusted channel): `bnd-<first 24 hex of sha256(team:agentId:channel)>`, the same pattern as `profileSourceId` for long ids. It gets its own `StoreKind` ("boundary") so `storeKind` does not read it as `agent-`.

Why a source and not a tag on each page: the brain enforces sources in SQL. A tag would need a filter in about eight readers that fails open, the think gather has leaked across sources before (see the `scopedThinkEngine` comment), and an untyped page passes through `composePage` unchanged, so the model could write its own tag. A new source needs no migration, because sources are created lazily on first write.

Code changes: add `channel` to `ScopeInput` and `GateInput`, set where the gate is built (`brainGateFor` in `gateway.ts`; nodes get it from the signed `claims.channel`), and add the boundary source to the scope.

### 2. Read and write rules

| Turn | Writes to | Reads |
|---|---|---|
| Trusted channel B (any speaker, manager included) | `bnd(B)` | `bnd(B)`, `agent-<id>`, legacy `agent`, `shared`, `public`, KBs, the speaker's profile |
| Wake or cron in B | `bnd(B)` | the same |
| Background turn with no channel (nightly, triage) | nothing by default | `agent-<id>` and shared tiers only |
| Manager DM | its own boundary (open decision 1) | as a trusted channel |
| /1on1, non-manager DM | `user-<id>` (unchanged) | unchanged; never gains a boundary source |
| Public or unknown channel, non-manager | unchanged | `public` only |

Conversation pages move to `bnd(B)`. `agent-<id>` is now the **persona-wide tier**: what the persona knows across channels (identity, lessons, promoted pages). A boundary source is never readable from another channel's turn.

### 3. Promotion

Three separate acts, because the audiences differ:

1. **Promote**: copy a page from `bnd(B)` to `agent-<id>`, readable by the persona in every trusted channel and /1on1. The original stays in its boundary. The copy carries `promoted_from`, `promoted_by` and `as_of` in its frontmatter.
2. **Share**: to `shared` (exists today, carded).
3. **Publish**: to `public`, which allow-listed non-managers read. No `memory_save` target writes `public` today, so this is new and may wait (open decision 3).

Promote is approval tier. The approver must be a manager, and a standing grant never covers it. In `classifyBrainOp` the check sits before the `userId === null` automatic branch, as the /1on1 check does, or every wake could promote freely. Demotion is `memory_delete` of the promoted copy, already approval tier.

### 4. The other paths in #247

- **Checklist.** Move `self/heartbeat/<channel>` into `bnd(channel)`; the channel job reads it from that one source.
- **`read_channel`.** Refuse any channel other than the one the turn runs in, in every turn. rc.44 already limits it to channels the agent works in; this narrows it to the current one.
- **Global mandate fill-in.** A proactive channel with no scoped mandate must not run on the global one. Warn at boot and skip the wake. Independent of memory; ships first.
- **Outbound actions in a proactive turn.** Sending mail, posting outside the channel and messaging people need approval unless the mandate in force for that channel allows them.

### 5. Existing pages

Pages in `agent-<id>` become persona-wide by default: no migration, nothing breaks. The cost is that historic channel pages stay visible everywhere until moved. A one-time operator job moves the attributable ones (`self/heartbeat/<channel>`, `conversations/<session>`) into the right boundary. Everything else gets a manager-run review listing, not an automatic guess.

### 6. Lessons

`self/lessons` stays persona-wide (capped at 40 lines, rewritten nightly, injected into every turn). The nightly pass that proposes lessons reads conversations from every channel and writes to the persona-wide page, so it is itself a crossing: a lesson sourced from one boundary must be generalised before it is written, or go through promotion. Open decision 4.

## Rollout

- Flag `SLAUDE_MEMORY_BOUNDARIES=off|on`, off for one RC, then on. Reads include every `bnd-*` source of the persona's trusted channels even when the flag is off, so a rollback does not hide pages.
- It changes the agent loop, so it ships as an RC. No schema change.
- Order: (1) the #247 gates (mandate fill-in, proactive outbound approval, `read_channel` to the current channel); (2) boundary sources behind the flag; (3) promotion; (4) the move job; (5) lessons.

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

## Open decisions

1. A manager DM: its own boundary, or the persona-wide home?
2. Legacy pages: leave persona-wide, or require review before they stay visible?
3. Is publish to `public` in scope now?
4. Lessons: generalise before writing, or route proposals through promotion?
5. Whether the #247 gates ship first as their own RC.

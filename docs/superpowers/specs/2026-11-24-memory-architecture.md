# Memory architecture: place, person, persona

**Date:** 2026-11-24
**Status:** design, not built. Issue #247. Replaces the storage and enforcement parts of `2026-11-24-memory-boundaries.md`; the owner's decisions recorded there stand unless section 5 says otherwise.
**Checked against:** `origin/main` at rc.44. "Checked" means I read the code; "inferred" means I did not.

## 1. The model

### Kinds of memory

| Tier | Holds | Brain source | Who reads | How it is written |
|---|---|---|---|---|
| Place | What happened and what is in progress in one place: conversation pages, thread summaries, the checklist, commitments, pages saved there, rules scoped to it, lesson proposals | `mb-<28 hex>`, one per (agent, boundary) | Turns running in that boundary only | Default target of every write |
| Person | One person's private memory and profile | `user-<id>`, `profile-*` (unchanged) | That person's own turns | Unchanged (/1on1, own profile) |
| Persona-wide | What the persona knows everywhere: identity, generalised lessons, global rules, promoted pages | `agent-<id>` (plus legacy `agent`, read only) | Every trusted turn, any manager turn | Promotion (manager card) or the generalising pass. Never a default |
| Shared | Team knowledge across personas | `shared` | As today | Carded; a wake may create, never modify |
| Public | Later | `public` | As today | Not in this work |
| Library | Operator wikis | `kb-*` | As today | Read only |

### The unit of segregation

A memory boundary IS the domain boundary: a row in `boundaries`, keyed by its internal id, never by a platform id. The domain model already defines it as surface-neutral, and `first-sight` already creates one for every Slack channel and DM (kind `channel` or `dm`; checked, `src/domain/first-sight.ts`). A thread is a locator inside a boundary, not a boundary.

Working rule for any surface: **a boundary is the smallest place whose audience sees everything said in it.** A turn has exactly one place or none.

### Movement between tiers

- **Promote** (place to persona-wide): an explicit `memory_save target: "persona"`. The agent first rewrites the page to stand alone (no "as discussed", no thread references), a manager approves the exact text on a card, and a copy is written with provenance. The original stays.
- **Generalise** (place to `self/lessons`): the only automatic crossing by content. A code-owned pass turns proposals into lines that name no person, place, customer or task.
- **Share** (to `shared`): carded as today. A wake may create a new page, and is refused when it would change one.
- Nothing else crosses. There is no read path from one place to another.

### Defaults per turn

`P` is the turn's place source. "Tiers" means `agent-<id>`, legacy `agent`, `shared`, `public`, the persona's `kb-*`.

| Surface or turn | Boundary it maps to | Default write | Read set |
|---|---|---|---|
| Slack channel, root or thread (trusted) | The channel's boundary; the thread is the locator | `P` | `P`, tiers, speaker's profile |
| Slack DM, manager | The DM's boundary (kind `dm`) | `P` | `P`, tiers, profile |
| Slack DM, other person | Unchanged | `user-<id>` | Unchanged |
| /1on1 (any place) | Person overlay: the lock owner's slice | `user-<id>` | Unchanged; never `P` |
| Public or unknown channel, non-manager | The channel's boundary, for the transcript only | Durable writes denied; transcript to `P` (today it goes to `agent-<id>`) | `public`, own profile |
| Manager in a public or unknown channel | That channel's boundary | `P` | `P`, tiers |
| Wake or cron created in a place | The boundary stored on the job row | `P` | As a turn there |
| Job with no place (console-made, internal) | None | Durable writes refused | Tiers only |
| Nightly review, thread summary | One run per place, from the registry | That `P` | That `P`, tiers |
| Lessons upkeep | None (persona) | `agent-<id>`, `self/lessons` only | Proposal pages handed to it by code; no search over places |
| Voice inside a thread | The thread's boundary (it uses the thread's session) | `P` | As that thread |
| Voice, standalone call (future) | `direct` boundary on the caller's phone binding | `P` | `P`, tiers if the caller is a manager, else `public` |
| Email (future) | One boundary per thread (root message id); the audience is the recipient list | `P` | Same rule as a channel of that trust class |
| Web chat (future) | `direct` boundary on the signed-in user | `P` | Same |
| API caller (future) | Boundary on the API client credential | `P` | Same |

## 2. Access enforcement

Four layers. A rule lives in the lowest layer that can hold it.

| Layer | Rule enforced there |
|---|---|
| Place resolution: one function, `placeFor(turn)` | Returns `{ kind: "place", source }` or `{ kind: "none", reason }`. Reads the boundary id from the session or job row first (`sessions.boundary_id`, `cron_jobs.boundary_id`), else resolves the typed reference. The only code allowed to produce an `mb-` id |
| Scope resolution: `resolveBrainScope` | Builds the read list and write target from the table above. `place` is a required field of `ScopeInput` and `GateInput`, so a caller that does not supply one does not compile |
| SQL: `buildScopedCtxAuth` (checked: the single shape both the local engine and the remote brain server use) | Throws when a context names more than one `mb-` source, or an `mb-` source the registry does not bind to this agent. gbrain then filters by source in SQL as today |
| Gate: `classifyBrainOp` | Write to own place: auto. Target persona-wide: manager tier, tested before the `userId === null` branch (today that branch returns auto for any target; checked, line 116). Target `shared`: approval; a wake creates but may not modify. Destructive: unchanged |
| Tools | `memory_save` targets `here` (default, alias `mine`), `persona`, `shared`, `profile`. `read_channel` and `list_cron_jobs` answer for the current boundary only |

**Identity inputs.** The agent id; the boundary's internal id; the person through the access seam that exists (`managerAt`, `sameAt`, Rule G), never a string compare. `isDmChannel` (a check on the letter `D`; checked, `src/memory/scope.ts`) is replaced by the boundary's `kind`.

**Fail closed.** Unknown place (database timeout, no workspace, unknown surface, registry write failed) gives `none`: no place source is read, a durable save is refused with a retry message, the turn's transcript is not stored, and a counter moves. It never falls back to persona-wide, because that is the leak. Persona-wide and shared reads still work, so the agent keeps its identity and lessons.

**Adding a surface.** An adapter supplies three things: a typed reference for the place (`<service>:<kind>:<id>`, resolved to a boundary through `ensureBoundary`), a locator, and the acting person as a binding. Guards:

1. Type: `place` is required, and a `switch` over surface kinds ends in `never`.
2. A full-source test (same pattern as `tests/access/no-string-authority.test.ts`): no file but the resolver builds an `mb-` id, no `BrainScope` literal names one, and no memory code tests a platform id shape.
3. A table test with one row per surface kind and turn origin; adding a kind without a row fails.
4. A property test: two different boundaries of one agent never share a readable place source.

## 3. Retrieval and context

**Federation cost is constant.** A turn reads one place source plus the tiers, so one more source than today however many places exist. This is the main reason to split by source and not by tag.

**Search and think.** `gather` already fans out one search per source and merges by rerank score (checked), so the place source is guaranteed its own top-K and cannot be drowned by a large tier. Changes: put the place source first; on equal score prefer the more local tier (place, person, persona-wide, shared, public, library); return `source` kind with every hit so the model can tell local fact from promoted knowledge. `think` uses the same gather.

**Promoted copies.** A copy keeps its slug. `gather` dedups by slug (checked), so in the origin place the local page wins and elsewhere the copy is the only hit. A copy carries `origin_hash`; the nightly run of the origin place compares it and proposes a re-promotion to the manager when the original has moved on.

**Correcting persona-wide knowledge from a place.** Supersede is per source. Writing the same slug in the place shadows the persona-wide page there only; fixing it everywhere is a promotion of the corrected page.

**Per-turn block.** Order: profile, lessons, open commitments, place notes. Commitments are scanned in the place source and the person's sources; the legacy `agent-<id>` scan stays during the transition, dropping any commitment whose `thread` names another boundary. Each section gets its own slice of the 1.5 s deadline and a late section is dropped, not the whole block (today one slow source drops everything; checked). Registry lookups are cached for the process, since a binding never changes.

**Background passes.**

- `PassScope` gains `{ kind: "place", source }`; `thread_activity.scope` gains the value `place:<source>` (it is free text; no DDL). `activityScopeOf` and `passScopeOf` accept it, or summaries stop (checked: both return null for any other source today).
- Nightly review runs once per place with activity that day, reads that place plus tiers, and writes proposals into that place.
- Lessons upkeep is the one sanctioned cross-place reader. Code collects the proposal pages and hands the text to the pass; the pass has no search tool. Code rejects any output line holding an id, mention, address, URL or reference; the prompt handles the rest. A proposal that cannot be generalised stays where it is.
- Thread summaries are written beside the conversation page, in the same place.

**Rules.** A rule's scope becomes a typed reference or `global`; today's bare values are read as Slack references. New rules are stored by scope (place or persona-wide). Old rules stay put: they are already filtered by scope when used (checked, `resolveLevel`).

## 4. Data model, transition, rollout

**Naming.** `mb-` plus the first 28 hex characters of sha256(agent id, boundary id): 31 characters, inside gbrain's `[a-z0-9-]{1,32}` (checked in `node_modules/gbrain`). Deterministic, so replicas agree without coordination. New `StoreKind` `place`.

**Registry (one new table, the only migration).** `memory_scopes(source_id primary key, agent_id, boundary_id, kind, created_at, unique(agent_id, boundary_id))`. Written insert-or-ignore before the first write to a source. It gives reverse lookup, the list of places for passes and the console, and the binding the SQL-layer check needs. No column is added to an existing table. gbrain needs nothing: sources are created on first write (checked, `ensureSource`).

**Provenance frontmatter**, set by code on typed pages: `origin_scope`, `origin_kind`, `written_by` (turn, wake, pass). A promoted copy adds `promoted_from`, `promoted_by` (internal user reference), `origin_hash`, `as_of`. Used for audit, dedup and staleness only: an untyped page passes through unchanged, so frontmatter is never an access control.

**Transition.**

- Existing `agent-<id>` pages are persona-wide by default (decided). A one-time operator job moves attributable ones (checklists, conversation pages, commitments with a `thread`); the rest go on a manager review list.
- Thread history reads the place source, then `agent-<id>`, until the move job has run.
- The checklist is copied on the first wake after the switch, claimed in `background_slots` as the earlier checklist migration was.

**Rollback.** Flag off sends writes back to `agent-<id>` and keeps the current place's source in the read set. Pages saved while it was on stay readable where they were written and nowhere else.

**Rollout.** Flag `SLAUDE_MEMORY_BOUNDARIES=off|shadow|on`.

| RC | Ships | Gate to the next |
|---|---|---|
| 1 (alone, no behaviour change) | Registry table, `placeFor`, required `place` on the gate, guard tests, `shadow` default: counts where each write would have gone and how often the place is unknown. Also the wake-to-`shared` fix (create auto, modify refused) | Unknown-place rate near zero in soak. Memory becomes the first reader of `boundary_id`, which nothing reads today (checked) |
| 2 | `on`: saved pages, checklist, commitments and place-scoped rules write to the place; reads are place plus tiers; promote with a manager card; SQL-layer check. Closes the page and checklist paths of #247 | Sim: save in A, wake in B, search finds nothing |
| 3 | Conversation pages and summaries move to the place; pass scopes; history dual read; public-channel transcripts leave `agent-<id>` | Summaries and nightly runs still produce output per place |
| 4 | Lesson proposals per place, generalising upkeep, stale-copy proposals, demote | |
| 5 | Move job, review list, `read_channel` and `list_cron_jobs` narrowed, console store kind | |
| Later | Publish, a per-place brief page, the remaining #247 gates | |

## 5. Cut, rejected, not verified

**Changed from the draft.**

- `bnd-<agent>-<channel>` naming and `channel` on the gate input: both tie memory to a Slack id. Replaced by the boundary id and a resolved `place`.
- "No schema change": one small table is worth it for enumeration and the SQL-layer check.
- Rollback that reads every boundary source of the persona: it would make a manager DM readable in every channel at the moment of rollback. Replaced by "current place only".
- One flag flip for everything: split so the first behaviour change (RC 2) needs no pass changes.
- Promote as a raw copy: the page is rewritten to stand alone first, and the card shows that text.

**Rejected.** A tag per page in place of a source (fails open in every reader). One persona-wide index with a boundary filter at read time (same). Merging a person's DM, email and phone into one place now (a merge can be undone for 7 days, and memory cannot be unmixed); a read-time union of verified bindings can come later, as person slices did.

**Not verified.**

- How often `boundary_id` is null in production, and whether cron or single-app turns carry a workspace (the resolver answers "absent" without one; checked). RC 1 measures this.
- gbrain internals: whether links, graph traversal and takes cross sources; which source `get_page` picks when a slug exists in two readable sources; whether search indexes timeline rows; cost with hundreds of sources.
- That the remote brain server passes the scope through unchanged (stated in a comment, not traced).
- The voice and panel paths: I did not trace how each builds its gate input.
- Whether a durable audit log records approvals (needed for `promoted_by`).

## 6. Questions for the owner

1. **Should what a manager tells the agent in a DM also be available in that manager's /1on1 threads?** Default: no, kept separate. Other answer: one private memory per manager, simpler for them, but a /1on1 inside a busy channel then draws on DM content.
2. **May the agent learn lessons from manager DMs, written in general terms with no names or details?** Default: yes. Other answer: corrections given in a DM never improve behaviour elsewhere.
3. **When the agent cannot tell which place a message belongs to, should it refuse to save ("could not save that, try again") or save where every channel can read?** Default: refuse. Other answer: nothing is ever lost, and the original leak can come back during an outage.
4. **Who may approve making a page visible in every channel: only the manager and backup, or any approver of that channel?** Default: manager and backup only. Other answer: less waiting, more people able to widen visibility.
5. **When email arrives later, should the agent keep each email thread separate, or remember across all threads with the same person?** Default: separate; the person's profile still carries over. Other answer: better continuity, but something said in a thread with extra recipients can reach a thread without them.
6. **A scheduled job created from the console, not from a chat: where should it remember things?** Default: nowhere, unless the job names a place. Other answer: it saves persona-wide, visible in every channel.
7. **If we switch this off after it has run, pages saved meanwhile stay visible only in the channel they were saved in. Acceptable?** Default: yes. Other answer: they become visible everywhere, manager DMs included.
8. **The first release that changes behaviour fences saved pages, checklists and commitments; conversation transcripts follow one release later. Acceptable?** Default: yes. Other answer: one larger, riskier release that does both at once.

## 7. Owner decisions (2026-11-24)

Answers to the questions above. Where an answer departs from the recommended default, the consequence is noted.

1. **A manager's DM memory is available in that manager's /1on1 threads.** Yes (default was no). The DM place and the manager's person tier are read together in a /1on1 the manager holds. A /1on1 held by anyone else never reads a DM place.
2. **Lessons may be learned from manager DMs**, generalised, with no names or details. Yes (default).
3. **A new save in a turn whose place cannot be worked out lands in the legacy persona-wide tier**, not a refusal (default was refuse). The page is written with `place: unknown` in its frontmatter and counted in a metric, so the rate is visible and the pages can be moved later. This reopens the original leak during a lookup outage for content saved in a private place, accepted by the owner on the reasoning that a record with no source is already legacy. RC 1 measures how often the place is unknown before this matters.
4. **Only the manager and backup manager approve** making a page visible in every channel. Yes (default).
5. **Each email thread is its own place**, with the person's profile carrying over. Yes (default).
6. **A console-created cron with no place saves to the persona-wide tier** (default was nowhere). Such a job should still be able to name a place; if it does, that place wins.
7. **Turning boundaries off keeps pages saved meanwhile visible only in the place they were saved in.** Yes (default).
8. **Rollout is one larger behaviour-changing release** (default was two): saved pages, checklists, commitments, transcripts and the passes move together, after a first shadow-only release that adds the resolver, the registry and the guard tests and measures the unknown-place rate. Because the second release is larger, it keeps the flag `SLAUDE_MEMORY_BOUNDARIES` and a canary plan: turn it on for one persona first.

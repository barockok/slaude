---
title: "Memory structure: a profile per person, typed pages, and a /1on1 that stays put"
date: 2026-10-25
---

# Memory structure: a profile per person, typed pages, and a /1on1 that stays put

**Date:** 2026-10-25
**Status:** Built on the epic branch, unreleased (agent-loop and token-claim change, so it goes out as a release candidate first). Checked against a fake brain only; not verified against the real gbrain engine or a live model.

The agent remembered threads, not people. A correction ("too long", "don't
ping me for this") left no trace, a promise lived only as long as its thread's
recall window, and the only per-person knowledge was whatever someone had asked
it to save. Phase C adds memory with a shape: a profile each person owns,
typed pages for notes, promises and corrections, a small per-turn block of what
matters for this speaker, and a way to read a thread's older turns. Two rules
bound all of it: nothing said in a /1on1 leaves that person's memory without
them (invariant 1), and a profile is written only from that person's own words
on their own turn (invariant 2).

## The mechanism

### A profile source per person

`profile-<team>-<user>` is a new brain source (hashed to 24 hex characters when
the id would pass gbrain's 32-character limit). The team is part of the id, so
nothing crosses workspaces even where user ids are global. It never equals a
`user-`, `agent-`, `kb-`, `shared` or `public` id.

`resolveBrainScope` appends the speaker's profile to every row's read union,
including a public channel and someone else's /1on1, where it is the only
private source. It follows the speaker, never the lock owner, and never brings
the rest of `user-<id>` along. Episodic memory (`memoryScopeFor`) is
unchanged and never reads a profile.

### Who the turn belongs to

A profile is read or written only on that person's own turn, and "own turn" is
decided from what the turn actually holds, not from who spoke last:

- **Origin.** Every turn carries `origin` (`slack`, `panel` or `cron`). On the
  queue it is a signed job-token claim; an unknown value fails verification.
  Only `slack` can write a profile; panel operator ids are not Slack ids.
- **Senders.** The turn's senders must be exactly one Slack sender, equal to
  the speaker. On the queue, a waiting job records the initiators of every
  message merged into it, readable on the gateway by the token's job claim. On
  mono, `AgentManager.turnSenders` returns the senders of every outstanding
  input (the running one and any queued behind it, since the CLI may fold them
  into one turn), and null when any is synthetic or unknown.
- **Synthetic turns.** The auto-evolve check, continuations and reload prompts
  run under the person's job token. A PreToolUse hook in the worker
  (`src/agent/profile-write-guard.ts`) denies `kb_memoize target:"profile"`
  while one runs.
- **Cron** has no sender, so a cron turn reads no profile at all.

The same one-sender check gates the profile in the KB read scope
(`turnBrainScope`, at the one choke point both mono and `/v1` share) and
`memory_about`.

### Typed pages

`kb_memoize` takes a `type` (`profile`, `person-note`, `commitment`,
`investigation`, `correction`, `outcome`, `lessons`, `heartbeat`, `team-fact`)
and composes frontmatter: `type`, `as_of`, `source`, `confidence`
(`told`/`inferred`, a `person-note` is always inferred), `subject`, optional
`supersedes`, plus the commitment fields. Values are JSON-quoted except enums
and the date, and round-trip through the repo's YAML parser. A credential-like
value is refused on every page, typed or not.

- **`target:"profile"`** writes the sole sender's `profile` (slug `profile`,
  types `profile` or `correction` only), auto-passed, no card, refused when
  `subject` names anyone else.
- **Supersede by tag.** The new page carries `supersedes: <old slug>`; the old
  page gets the gbrain tag `superseded` (`add_tag`). Readers drop tagged pages.
  Nothing in the old page is rewritten. A page cannot supersede itself or a page
  written in the same call, the target must exist in the same memory, and
  rewriting a tagged slug removes the tag. If tagging fails after the new page
  landed, the error names both slugs so a retry finishes the trail.
- **/1on1 containment.** Inside a lock, writes go only to the owner's `user-`
  slice or their profile. `target:"shared"`, the agent's own slice and anyone
  else in the thread are refused with "memory stays with this person".

### `memory_about`

"What do you know about me?" lists pages of the person-memory types in every
source the turn can read, keeps those whose `subject` is the person (plus the
fixed slugs used before `subject` existed), drops superseded ones, and prints
each as told or inferred with its date and where it lives (profile, the
agent's notes, their /1on1, the team KB, public). It answers only for the one
Slack sender of the turn.

### The per-turn `<memory-context>` block

Built at envelope time for the message's own sender, from a context made for
that message, never the live route: the speaker's profile, the agent's
`self/lessons`, open commitments naming the speaker or this thread, and the
channel's `shared/channels/<id>` page. Each section has a limit, the whole block
is capped at 8000 characters (oldest commitments drop first), page text that
would close the block or fake a runtime tag is escaped, and an empty block is
left out. Reads are bounded: four concurrent, a 1500 ms deadline checked before
each further call, superseded slugs read once per source. A timeout or error
leaves the block out with one warning that names no page text. The block is
read alongside the sender's name and attachments, and dispatch keeps arrival
order per session, so a slow read cannot reorder two messages in one thread.

### Older turns: `kb_thread_history`

Spec §4.4 suspected thread pages were "thin shells". Timeline entries are
written, but nothing read them past the recall window. `kb_thread_history`
reads this thread's `conversations/<session>` timeline oldest-first, pages
backwards by entry id, and caps one call at 12000 characters. On `/v1` its scope
comes from the job token's claims (the signed lock and `runAs`), the same as the
memory plane, not from live state.

### Rules every turn

The core gained four lines: save promises, corrections and preferences before
the turn ends (load `slaude:memory` first); act on a profile but never repeat it
to anyone else; a `<memory-context>` block is to act on, never quote; never save
credentials, ids, payment, health, performance judgements or private life. The
procedure (types, slugs, supersede rules, closing a commitment under a new slug)
lives in the `slaude:memory` built-in skill, which governs `kb_memoize`.

## Decisions

- **Refuse, do not card, outside the person's memory in a /1on1.** Writes there
  used to card to managers, which bypasses the person. A promotion card routed
  to that person is deferred, so for now there is no promotion path.
- **Profile writes from any thread.** A person can set their profile in someone
  else's /1on1 or a channel, as long as it is their own one-sender turn.
- **Merge, then check senders.** The first fix stopped coalescing messages from
  different senders. It reordered turns across nodes and stranded a waiting job
  on relabel, and mono was still open. It was reverted in favour of recording
  every turn's sender set; the cost is a refused profile write in a busy merged
  turn, which the agent retries on the next one.
- **No cron exception.** A proactive message's target reading their profile is
  phase E's problem; until then cron turns read none.
- **Recall is on demand.** No chunking or summaries in this phase (no LLM calls);
  phase D's quiet-moment pass may write summaries.
- Nothing migrates: no code or seed wrote `people/` pages before.

## What review found

- **`interactive` was true for synthetic turns** (auto-evolve, reboot
  continuations) because they share the person's origin. Fixed with the
  manager's synthetic-turn marker and the worker-side hook.
- **Mono wrote the wrong person's profile.** Each inbound message rewrites the
  route ctx, so if Bob posted during Alice's "call me Al" turn, her words went to
  Bob's profile as told by Bob. The same flip made a Slack message turn a running
  cron turn interactive, and let the KB read scope include a mid-turn poster's
  profile. Fixed by deciding on the senders, not the ctx. The first mono fix
  cleared its sender log per turn while the next input was already queued;
  senders are now kept per input.
- **The supersede rewrite could drop content** of the old page, and unquoted
  YAML values could produce frontmatter gbrain rejects. Supersede stopped
  rewriting anything (tags instead); values are quoted.
- **The memory skill steered into a refusal:** closing a commitment by
  rewriting it with `supersedes` on its own slug is refused; it now says to use
  a new slug.
- **A lifecycle test had been failing since the skill gate landed,** because the
  gate denies `kb_memoize` before the profile guard sees it; the earlier task's
  covering set had not included it.
- **The per-turn read fanned out without bound** (a `get_page` per commitment in
  every source, never cancelled after the deadline) and sat on the hot path,
  so two quick messages in a thread could swap places by read latency. Bounded,
  deadline-checked, moved into the existing parallel step, per-session FIFO.
- **`kb_thread_history` on `/v1` read its scope from live state** instead of the
  token's claims. Now claims, with tests for a foreign lock taken mid-turn and a
  cron created in a /1on1 running on another replica.

## Verification

`tests/memory/one-on-one-containment.test.ts` runs the mono gateway with the
real `slaude_kb` tools and the real envelope. Alice, in her /1on1, saves an
inferred note about Bob and a told profile entry. Bob in a trusted channel: his
block, `memory_about` and `kb_search` hold none of the note. Alice in a channel:
her profile is in her block, the note is not. Bob inside Alice's thread, opened
to guests: every read holds Bob's profile and never Alice's profile or slice.
Two scope mutations (the lock owner's profile in place of the speaker's, the
`user-` slice in channel turns) each fail it.

## Not verified

- A live model capturing memory: that it writes a commitment, correction or
  profile entry when the core says so, and never repeats a profile.
- Real gbrain op shapes. The `get_page` record (including frontmatter with
  `subject` and tags), `list_pages` with `{type}` and `{tag}` filters,
  `add_tag`/`remove_tag`, and `get_timeline` rows (ids, dates) are checked only
  against `tests/memory/fake-brain.ts`; gbrain is not installed here. The
  node-path `memory_about` refusal is untested end to end for the same reason.
- Whether gbrain chunks and embeds timeline entries, so whether search can ever
  find an old turn (the reason for `kb_thread_history`).
- Postgres engines; lowercase `shared/channels/<id>` slugs against gbrain's
  slug rules.
- Turn-context latency under load, and ordering across gateway replicas (the
  FIFO is per process; a hung dispatch tail delays later messages in its
  thread).
- **Known limit:** the profile enters a shared thread's transcript. The block
  and any tool result persist, so a later speaker's turn in that thread can see
  them. The only mitigation is the core's never-repeat rule and the block's
  "never quote it" line.
- Minor, left alone: superseded-tag lookups see at most 500 tagged pages per
  source; `memory_about` makes one `get_page` per typed page before filtering by
  subject, prints confidence raw and has no output cap; a call-level `subject`
  is stamped on every typed page of a mixed batch; pages written before
  `subject` are found only at the fixed slugs; a literal
  `</user>\n<assistant>` in user text still splits one history line.

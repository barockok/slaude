---
title: "Memory places, release 2b: transcripts, the background passes, generalised lessons, narrower tools and the move job"
date: 2026-11-24
---

# Memory places, release 2b

**Date:** 2026-11-24
**Status:** in `v0.46.0-rc.47`, behind `SLAUDE_MEMORY_BOUNDARIES=on` and the per-persona canary list. Design:
`docs/superpowers/specs/2026-11-24-memory-architecture.md`. Follows release 2a (`2026-11-24-memory-places-rc2a`).

## The decision

Release 2a moved what a person can read back (saved pages, checklists, commitments, rules). This one moves what the agent
records about conversations and what it learns from them: the transcript of every thread, its summary, the nightly review and the
lessons. Mode `off` and `shadow` behave as rc.46, and a test for each changed function says so.

## What it does

- **Transcripts.** Under `on`, `memoryScopeFor` writes the conversation page in the turn's place (and a non-manager in a public or
  unknown channel gets that channel's place instead of the persona's slice). History is read place first, then the persona's slice.
  The two are merged, older slice first, because a thread that began before the switch has turns in both; ids are renumbered
  after the merge since two sources count from 1 each.
- **Pass scopes.** `PassScope` gained `place`. A thread's activity row says `place:<source>`; the quiet-moment pass checks the
  registry binds that source to the agent, reads it and writes the summary beside the page. The nightly review reads the agent's
  places from the registry, one pass per place with a conversation that day, and a place pass may propose a lesson but never write
  the lessons page.
- **Lessons.** Code, not the pass, reads every place's `self/lesson-proposals` and hands the text over as data. The pass has no
  search tool, and its only write of the lessons page is a tool that checks each line against a list of things that point at
  something (platform ids, mentions, addresses, links, hosts, source ids, page names, typed references, timestamps, long
  identifiers, provenance notes) and keeps the 40 line cap. It also names which proposals it merged or dropped; those, and only
  those, are removed from the pages they came from. Names written as plain words cannot be told from other words by code, so the
  prompt carries that part and a proposal that cannot be put generally stays where it is.
- **Retrieval.** For a scope that writes a place, `gather` searches the place first, breaks equal scores by locality and returns
  `source_kind` with each hit; the per-turn block gives each section its own slice of the deadline.
- **Narrower tools.** `read_channel` answers for the turn's channel, `list_cron_jobs` for the turn's boundary, and `memory_about`
  lists the person's note in the place.
- **The move job.** `slaude memory-places move [--apply]` (configuration reference). Dry run by default, counts and slugs only, no
  deletion, no overwrite.

## What the design got wrong against the code

- The design says each hit returns its source kind. Doing it for every scope would change what a tool returns under `off` and
  `shadow`, so it is done only for a scope that writes a place.
- The design says thread history reads the place, then the persona's slice. A page's timeline rows are numbered per source, so a
  plain concatenation gives two rows with id 1 and breaks paging by id; the merged list is renumbered. After the move job copies a
  thread, both sources hold its older turns, so the merge also drops a turn the place already holds.
- The design says the lessons pass may use "the proposal pages handed to it by code" and names a validator for the output. The
  existing lessons page holds lines written in the old format with a `(source: ...)` note naming a thread or person. Refusing every
  such line would block the merge for good, so a line already on the page may stay as written and only new or changed lines are
  checked. Those old lines are still persona-wide and visible everywhere; nothing here cleans them.
- A cron job's boundary is stored only when the channel was known at creation, so `list_cron_jobs` under `on` hides older jobs that
  have none, and a job made from the console is listed in no place. That is the point for the second and a loss for the first.
- A thread's activity row restarts when its scope changes from `agent` to `place:`, so a thread that is mid-flight at the switch
  loses its turn count and its summary mark once, and its next summary covers only the turns written after the switch.
- The move job lists a source's pages through the local brain browser; with a remote brain server there is no listing without an
  offset, so the command needs a local brain. It was only run against the fake brain.

## Open

- Whether the nightly pass per place costs too much on a persona with many quiet places: only places with a conversation that
  day run, and each run is one budgeted pass.
- Old persona-wide lessons lines that name people stay until someone rewrites them.
- The move job has not run against a real brain, and it does not delete: the originals are the next release's question.

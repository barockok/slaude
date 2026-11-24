---
title: "Memory places: a search from one place returned another place's old transcript"
date: 2026-11-25
---

# A search from one place returned another place's old transcript

**Date:** 2026-11-25
**Status:** fixed in `v0.46.0-rc.48`. Part of [the memory places series](2026-11-24-memory-places-rc2b.md).

## What the smoke found

rc.47 was switched on for one persona. A page was saved in one channel with the default target, and Sam found it there. A search for the same word from a direct message with the same person answered "not found" on rc.46 and "found" with the page's slug on rc.47.

## Why

The page itself was in the channel's place and the DM could not read it. What the DM read was the persona slice, which every place reads and where conversation pages written before the switch still sit. A transcript is a log of what was said: it held the sentence that asked for the save, with the slug and the text. The brain indexes those log entries, so a search hit them.

The rc.46 DM answer was "not found" most likely because those entries were not yet indexed. That makes the test a timing accident, not a proof: a positive control in the saving channel is needed beside every negative one.

## What changed

`gather`, which `memory_search` and `memory_think` use, drops a conversation page from any source except the turn's own place when the scope writes a place. Old transcripts stay readable through their own session's thread history. The move job still copies and never deletes, so the filter is what keeps them out of other places' search until an operator removes the originals.

## What stays open

- A persona-wide page that quotes a transcript (a lesson or a promoted page) is not filtered; the lessons validator and the promotion rewrite are the guards for that.
- `list_pages` and `memory_get` by slug are not filtered. They return a slug, or a page, only to a caller that already names it.
- Deleting the originals after the move job runs is a later release and an operator decision.

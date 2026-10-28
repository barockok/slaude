---
title: "Heartbeat: channel mandates in triage, one persistent proactive folder"
date: 2026-10-28
---

# Heartbeat: channel mandates in triage, one persistent proactive folder

**Date:** 2026-10-28
**Status:** Built on the epic branch, unreleased. It touches the agent loop and the node queue path, so it ships in a release candidate. Checked with unit tests, manager tests on the fake SDK, gateway dispatch tests and real-Redis lock tests. Not run against a live model or real node processes.

## What was wrong

Triage picked a destination channel for each item but saw only the channel ids. It could not tell which channel an item belonged to, and routing was close to a guess. Separately, every proactive ask or act thread started in a fresh working directory, so any repository the agent had cloned for one thread was cloned again for the next.

## What changed

- The triage prompt now carries the global mandate and, for each enabled channel, that channel's own mandate (or a pointer to the global one). Each is one line, has no `<`, and is cut at 600 characters with an ellipsis. Routing decisions in code are unchanged; the model only sees more.
- Heartbeat ask and act threads get `workspaces/agent-<id>/proactive/` as their working directory when the thread is created. The agent id is sanitised. Later human replies in that thread keep it.
- One turn at a time in that folder. In process, a claim (`WorkspaceClaims`) is FIFO and re-entrant per session. It is released at the turn's result, at session exit, or when a send fails. On nodes, a Redis lock (`withKeyLock`, key `lock:workspace:<hash of dir>`) is taken inside the session lock, and a held lock requeues the turn after 500 ms instead of failing it. The gateway marks the job with the folder; the mark is not signed, since a forged one only adds waiting.
- Auto-evolve skill checks take the folder only if it is free and are skipped otherwise. On mono a heartbeat dispatch does not wait for its turn, so a later failure leaves its ledger run to the stale-run sweep.

## Decisions

Approach A: keep routing in code and enrich the prompt, rather than let the model name any destination. One shared folder now, per-channel folders later, because the first goal was only to stop re-cloning.

## Review found

- A message could be dropped if its session was reloaded or went idle while it waited for the folder. A waiting send now re-reads the session after every wait.
- The turn start was announced before the folder was held. It is now emitted only once held.
- A failed send released the folder while the same session was still booting.

## Not verified

A live model routing by mandate; a real repository cloned and reused in the folder; two real node processes; the first review finding has no reproducing test and was fixed by inspection.

## Known limits

- One folder serves every channel, so an act turn for one channel can read another's leftovers.
- One turn at a time. A long act turn or a busy thread holds the folder (re-entrant, not fair), and a human reply in an old proactive thread waits too.
- Folder waiters on nodes requeue every 500 ms with no order.
- Skill checks are lost while the folder is busy.

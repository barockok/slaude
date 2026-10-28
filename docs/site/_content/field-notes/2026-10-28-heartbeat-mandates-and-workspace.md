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
- Heartbeat ask and act threads of a channel post get `workspaces/agent-<id>/proactive/` as their working directory when the thread is created. The agent id is sanitised. Later human replies in that thread keep it. A post to the manager or a person is a DM, and its thread keeps its own folder, so files made for one person never sit where channel threads work.
- One turn at a time in that folder. In process, a claim (`WorkspaceClaims`) is FIFO and re-entrant per session, keyed by the folder's resolved path. It is released once no input of the session is outstanding (the last result), at session exit, or when a send fails before its input is in. On nodes, a Redis lock (`withKeyLock`, key `lock:workspace:<hash of the resolved dir>`) is taken inside the session lock and released at turn end, and a held lock requeues the turn after 500 ms instead of failing it. The gateway marks the job with the folder; the mark is not signed, since a forged one only adds waiting.
- A budgeted auto-evolve skill check takes the folder only if it is free and is skipped otherwise. An unbudgeted check is pushed while its turn's input is still outstanding, so the folder is still held for it. On nodes the Redis folder lock is already released at turn end, so a following skill check is ordered against other turns only in that process, not across nodes.
- On mono a heartbeat dispatch does not wait for its turn, so a later failure leaves its ledger run to the stale-run sweep. A promise check into a thread whose folder another session holds counts as busy and is deferred, because the scheduler awaits each check and a wait for the folder would stall every background pass.

## Decisions

Approach A: keep routing in code and enrich the prompt, rather than let the model name any destination. One shared folder now, per-channel folders later, because the first goal was only to stop re-cloning.

## Review found

- A message could be dropped if its session was reloaded, aborted or went idle while it waited for the folder. A waiting send now re-reads the session after every wait, and an instance the idle timer closed is marked closing and treated like a reloading one (the send waits for its exit and boots fresh). Each variant has a test.
- Final review: a promise check on mono could stall the background scheduler behind the folder (now busy, deferred); DM-audience heartbeat threads shared the folder with channel threads (now only channel posts' threads use it); the claim and the Redis key used the raw path while the folder check resolves it (now resolved everywhere).
- The turn start was announced before the folder was held. It is now emitted only once held.
- A failed send released the folder while the same session was still booting.

## Not verified

A live model routing by mandate; a real repository cloned and reused in the folder; two real node processes.

## Known limits

- One folder serves every channel, so an act turn for one channel can read another's leftovers.
- One turn at a time. A long act turn or a busy thread holds the folder (re-entrant, not fair), and a human reply in an old proactive thread waits too.
- Folder waiters on nodes requeue every 500 ms with no order.
- Budgeted skill checks are lost while the folder is busy.
- On the queue path the gateway's event follower stops 20 minutes after enqueue and is not extended while a job is delayed. A turn that waits for the folder and then runs past that loses its reactions, status, done and error posts; the reply itself still posts.
- Each 500 ms requeue of a job whose token is past 20% of its life makes a `/v1` token-refresh call.

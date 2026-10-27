---
title: "Live smoke test of the teammate epic: a /1on1 page in a channel's think prompt, and slugs gbrain could not chunk"
date: 2026-10-26
---

# Live smoke test of the teammate epic: a /1on1 page in a channel's think prompt, and slugs gbrain could not chunk

**Date:** 2026-10-26
**Status:** Fixes on the epic branch, unreleased (they touch the agent loop and the brain read path, so they ship in the epic's release candidate).

After phases A–E were built, one persona ran in `mono` against real Slack
(Socket Mode), a live Anthropic-compatible model, live embeddings, a local
gbrain on PGLite, and the decision gate `on` with the Jev adapter. A person
drove it from a test channel through their own Slack account; the gateway's
logs, the ledger tables and the brain were read alongside. Every phase's main
path was exercised once. Six defects were found and fixed; the rest are
recorded below as observations.

## What worked as designed

- **Voice and pass:** short answers, no machinery narration in replies to
  questions; a reaction for long work instead of "working on it"; failures as
  a plain sentence. `pass` ends turns.
- **Decision gate:** every decision came from the adapter in 250–650 ms. A
  mention *about* the agent got the doubt reaction and no session; an engaged
  message that did not clear the threshold was recorded into the transcript
  as a suppressed turn (no model call); DMs, `/1on1` and `/cron-*` text
  commands bypassed it.
- **Built-in skill enforcement:** a `kb_memoize` before `slaude:memory` was
  loaded was refused with the skill named; the model loaded it and retried.
  Typed fields without a `type` were refused with the reason.
- **Memory:** a stated preference landed in the person's profile (`told`),
  came back in the next thread's `<memory-context>`, and was honoured;
  `memory_about` labelled it told with its date. A `/1on1` write landed in
  the person's own slice.
- **Background:** the digest, quiet-moment summaries, heartbeats and the
  post-turn skill check all ran under the budget, each priced from
  `SLAUDE_PRICE_TABLE` into `background_runs`.
- **Promises:** a time-based promise written as a commitment was indexed by
  the post-write hook and kept by a budgeted check turn in its own thread a
  minute after it fell due; the row closed as done.
- **Heartbeat and feedback:** a checklist item produced one `proactive_post`
  to the manager's DM, recorded with topic and evidence hashes; later
  heartbeats stayed silent. An exact "stop" under it muted that topic and was
  answered in one line, with no agent turn. The mute survived a later profile
  rewrite.
- **Nightly review:** started late (the host was down at 02:30 local), it ran
  for the day once per scope, the agent's and, as that person, the one with
  /1on1 content, and wrote an `outcome` for a kept check-in. Lessons upkeep
  skipped itself: no lesson was proposed.

## Defects found and fixed

- **`kb_think` read every source.** gbrain's `runThink` accepts the caller's
  `allowedSources` but uses them only to resolve entities: its page gather
  calls `hybridSearch` with no source filter. In a channel turn, a page
  written in the person's `/1on1` was ranked first in the synthesis prompt;
  only the synthesis model's discretion ("no publicly shareable
  information…") kept it out of the reply, and the pooled search pushed the
  in-scope page out entirely. `brainThink` now hands `runThink` an engine whose
  page searches are forced to the caller's sources and whose take hits are
  kept only when their page is in them. An integration test pins it.
- **Mixed-case slugs could not be written.** gbrain stores a page under its
  lowercased slug, chunks it under the slug as given, and reads slugs
  exactly. A `people/<userId>` person-note (Slack ids are upper case) failed
  with "Page not found" after the page row was written, and `memory_about`'s
  fixed `people/<userId>` lookup never matched. `kb_memoize` lowercases slugs
  and `supersedes`; the memory fake brain now lowercases on `put_page` and
  matches exactly elsewhere, which is why tests had not shown it.
- **CLI scheduling tools were offered.** The core said `CronCreate` and
  friends were blocked; nothing enforced it, and the model reached for
  `ScheduleWakeup` (a CLI built-in whose job dies with the child process) for
  a check-in. They are now in `disallowedTools` for every session.
- **A cron next to every promise.** Four times out of four the model added
  `add_cron_job` before loading `slaude:memory`, whose rule says not to. The
  rule is now one line in the core (invariant 7). Afterwards the model still
  reached for cron once, then removed it itself after loading the skill; a
  checklist item was written with no cron.
- **A low KB score read as "cannot help".** The `agentCanHelp` question
  framed the teammate as one with access to the KB; on a young KB a plain
  git question scored 0.40, under `tAct` 0.8, so chime-in never fired. The
  reworded question scored it 1.0 while thanks, chit-chat and asks to
  someone else stayed "no".
- **`kb_think` on a remote brain booted a local one.** In remote mode
  (`SLAUDE_BRAIN_MODE=remote`, the brain in its own server process) every
  other brain call goes over the backend, but `brainThink` handed gbrain's
  `runThink` the in-process engine, so it booted an empty local brain (on a
  gateway, PGLite on the shared volume, which the scale rules forbid), paid
  for a synthesis over no pages, and was answered only by the rescue path.
  On a remote brain it now gathers through the backend with slaude's
  per-source `gather()` and synthesizes with the SDK client, sharing the
  rescue's synthesis code. Checked against a real brain-server process over a
  copy of the smoke-test brain: the in-scope page was found, the /1on1 page
  never reached the prompt, and the client created no local brain. Takes,
  graph and trajectory are not gathered on that path.
- **The brain was left open on shutdown,** so each mono restart reported an
  unclean shutdown. Shutdown now closes it; a SIGTERM afterwards left no lock.

## Observed, not changed

- **The gate drops some direct requests.** Two of about fourteen direct
  mentions scored `addressedToAgent` ≈ 0.32 because the person talked about
  their own work before the request ("I'm about to run the migration. Check
  back with me…"); they got the doubt reaction and no turn. Rewording the
  question helped but did not clear 0.8. Treating a message that *opens* with
  the agent's mention as addressed is a policy change for the owner.
- **Natural "stop" phrasings miss the deterministic path.** "stop, I don't
  need reminders about this one" is not a stop phrase, so it became an agent
  turn. The heartbeat's DM is in no session, so the agent could not see what
  the reply was about, wrote no mute, and still said it would stop.
- **No channel read on a bot-only deploy.** Slack search needs a user token;
  there is no channel-history tool, and the heartbeat has no Slack tools at
  all. "Tell me when X is posted" promises and channel-watching checks
  cannot work there, and the agent accepted such a checklist item without
  saying so.
- **Voice slips:** a proactive DM led with a page slug; a thanks got a
  service offer instead of a pass; one failure message named token scopes;
  one turn replied twice; `pass` is often called after `reply`.
- **Commitment due dates:** "if it doesn't happen today" was stored as UTC
  midnight, not the persona's day.
- **Not exercised live:** the weekly skill review (Sunday slot), proposal
  cards, Slack HTTP mode, nodes.

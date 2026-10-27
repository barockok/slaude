---
title: "The heartbeat round: one agent, all its sources, reactions learned under the mandate"
date: 2026-10-27
---

# The heartbeat round: one agent, all its sources, reactions learned under the mandate

**Date:** 2026-10-27
**Status:** Built on the epic branch, unreleased. It touches the agent loop, the DB schema and the dispatch path, so it ships in the v0.45.0 release candidates. Checked with fakes (brain, source reader, Slack, scripted model), with fake-query pass-option tests and, for nodes, only through tests. Not run against a live model, a real MCP server or live Slack.

The heartbeat used to be a checklist the agent read to itself once per slot,
with `proactive_post` as its only way out. The round replaces that with a
pass that reads the agent's own MCP sources, routes what it finds, and lets
code decide what happens to each item. The model proposes; code clamps.

## Mechanism

- **The ceiling is the SOUL's.** `## Proactive` gains `Watch:` (the sources
  the round reads, global only) and `Highest:` (`ignore < inform < ask < act`,
  default `inform`; a channel block may replace it for that channel). Both are
  parsed from SOUL text by code. Neither comes from the LLM extraction, runtime
  overrides or a command, and a person's profile can only lower the effect.
- **Read tools are an operator statement.** A server entry in the MCP config
  carries `readTools`, the list of its tools that only read. No list, no watch
  (one boot warning). Only `http` servers are watchable; a server in
  `privateServices` never is. The round sees nothing outside the list.
- **The reader acts as the agent.** `read_<server>` goes through the MCP
  bridge's new pass entry point: the agent's own credential, no session, no job
  token, the same origin pinning and outbound policy. Per round: 20 reads and
  64 KiB of results per source; results are redacted. A listing refused for
  authorisation marks the source needs-auth: skipped, watermark kept, and the
  manager gets one DM per source per day to reconnect.
- **State.** `heartbeat_watermarks` is code-owned: `since` is the start of the
  last round that read that source without error, so an injected item cannot
  move it. The journal (`self/heartbeat-journal`, 4000 characters) is rewritten
  each round and read back by the next. Rules are `rules/proactive/<slug>` pages
  (`kind`, `scope`, `level`, `how`, provenance with a verbatim quote), superseded
  by tag. `proactive_posts` gained `text` and a JSON `context`.
- **Triage is read-only.** The runner takes a per-pass `baseTools`; triage gets
  `read_pages, list_pages, search`, one `read_<server>` per watched source,
  `route_item` and `write_journal`. No memoize, no propose, no Slack, no say
  over watermarks. The runner's lockdown is unchanged (`tools: []`, strict MCP
  config, no settings, `dontAsk`, the deny hook).
- **Code decides.** Per routed item: rule resolution (a destination rule beats
  a global one; the model's proposed level may only lower), clamp to `Highest`
  for the destination, then the unchanged restraint checks. `inform` posts with
  its context stored. `ask` and `act` post, then dispatch a turn into the post's
  thread through the cron path, as the agent and never as a person, inside an
  envelope with its own budget. Timing refusals (quiet hours, daily cap,
  cooldown), a post cap, a failed post and a failed dispatch keep the source's
  watermark so the item is read again; policy refusals are terminal and
  journaled as not posted.
- **Replies teach.** A threaded reply to a proactive post engages the thread
  (skipping the gate) and carries the post's context as `<proactive-context>`.
  `proactive_rule` writes a rule from that turn: lowering applies for the
  person the post counts for, raising is checked against `Highest` and the
  scope's approvers (a card in the live thread), `global` and DM scopes need a
  manager, and it is refused in a `/1on1`. Widening to `global` drops the quote.
- **Marker.** Each post carries Slack metadata `{event_type: "slaude_proactive",
  event_payload: {post}}`. Nothing reads it; the row is the truth.

## What review found and fixed

- **Bridge exceptions escaped the reader.** A server the bridge does not serve,
  or a credential or database failure, threw out of the reader into the round.
  A listing now returns nothing with one warning per source, and a read returns
  an error outcome with the message redacted.
- **Parallel reads overshot the byte cap.** The cap was checked before the
  awaited read and applied after it, so reads issued in one turn all passed the
  check. The room is now re-read after the await, and a spent budget is refused.
- **A fake `<runtime-check>` opener through untrusted text.** Item text carrying
  the envelope's own opening tag could shape an act turn that has full tools.
  No interpolated value can now open a tag in the dispatch envelope.
- **A needs-auth source was silently skipped.** Now it keeps its watermark,
  nothing is journaled as read, and the manager is told once a day.
- **Items lost behind an advanced watermark.** The first design advanced every
  source that did not fail; a source that was never read lost its window. The
  watermark moves only for sources read without error, and only when the pass
  ended `ok`; an item not delivered for a passing reason pins its source.
- **An "unchanged" refusal pinned a watermark** (and said "Not delivered" for a
  post nothing would ever send). Refusals are now classed: terminal ones are
  handled and journaled, timing ones wait for their window.
- **A multi-app deploy handed a proactive thread to the wrong bot.** Every
  app's copy of the event tried to engage the thread; only the posting app's
  copy takes it now.
- **`proactive_rule` trusted the route identity.** On cron, heartbeat and
  synthetic turns, and on merged turns with several senders, the route's
  identity is not a person. The tool now works only on a person's own Slack
  turn with exactly one sender, and a rule kind with no letters or digits is
  refused (it collided on an empty slug).

## What was verified, and what was not

Verified: the parser and level math; the reader against a fake bridge (typed
failures, caps, redaction, needs-auth, privateServices); triage tools; the
round end to end with a fake reader, brain and Slack (post, ask/act dispatch,
terminal and transient drops, watermarks, journal cap); reply stitching and
rule teaching including the card path; the migration on sqlite; the pass
options through the real runner with a fake query (offered tools are exactly
the six `mcp__slaude_pass__` ids for a watched server `mail`).

Not verified: a live model's triage quality or its use of `route_item`; a real
MCP server (the bridge pass entry point has only been driven by fakes); live
Slack, including metadata on posts and the engage-on-reply path; nodes, which
are covered only through tests; Postgres for the new migration locally.

## Known limits

- **Mono and file-configured servers.** Mono has no bridge, so it watches a
  file-configured server only with `SLAUDE_MCP_BRIDGE_ALLOW_FILE_CONFIG=1`.
- **Single tenant.** Background claims use `tenant: "default"`; the agent
  credential lookup keys on tenant, so a multi-tenant gateway reads the
  default tenant's credential.
- The reply gate bypass covers the whole thread; a thread disengaged later
  stays disengaged; a root posted as the user token with another app bot in the
  channel is taken by no copy (safe, the feature is lost there).
- A post sent but unrecorded counts as delivered and could repost; a transient
  pin longer than the "unchanged" window could repost.
- The read-tool length cap counts UTF-16 units, not bytes.

---
title: "Heartbeat wake: the agent itself wakes up, in the runtime every other turn uses"
date: 2026-11-02
---

# Heartbeat wake: the agent itself wakes up, in the runtime every other turn uses

**Date:** 2026-11-02
**Status:** Built on a branch, unreleased. It touches the agent loop, the dispatch path, the job token and the DB schema (migration 0031), so it ships as a release candidate. Checked with fakes (fake SDK, brain, Slack) and the test database. **Not run against a live model, real Slack or real node processes.**

Spec: `docs/superpowers/specs/2026-11-02-heartbeat-wake-design.md`.

## What was wrong

Two agents whose mandates asked for unattended work did none of it, over days of a live deployment. The causes were all in the runtime's defaults.

- **Nothing ever acted.** A round's level is the taught rule's, else `inform`. `Highest` is only a ceiling, so `Highest: act` with no rules means inform forever.
- **The heartbeat could not do the work.** Triage is a locked read-only pass with no identity, tools or folder. It wrote content ideas from model priors, as a summary.
- **Recurring posts were refused for a week.** Restraint dedupes on evidence, and a checklist item's natural evidence is the checklist.
- **Skill checks starved it.** One shared daily budget; a skill check costs about twice a round. One agent's budget ran out mid-afternoon, and every later slot was skipped with only a log line.
- **Nothing could read another channel.** `search_messages` fails on bot tokens and `get_thread_history` is bound to the thread, so an agent asked to watch a channel could only report that it was blind.

## What changed

- **Round fixes**, for every persona: own checklist or notes never count as evidence; `unchanged` is journaled; a channel block can set `Cooldown` and `Max per day`; an optional separate proactive budget (`SLAUDE_PROACTIVE_BUDGET_USD`); one out-of-budget DM per day; the persona's voice in triage.
- **Wake**, opt-in with `Wake: yes` and `Highest: act` on an enabled destination. Code gates each slot (next check due, checklist changed, or longest sleep reached), and no model call happens otherwise. A due wake is a fresh session of the agent through the cron path, in its proactive folder.
- **Restraint moved from a runtime boundary to tools.** `proactive_post` is the only way a wake starts a conversation and runs the same checks. `post_message` works only under a post that run opened. An allow-list derived from the tool contracts hides everything else (`disallowedTools`) and the `/v1` plane refuses it from a signed `wake` claim.
- **`read_channel`** reads channels the SOUL lists under `Read:`, in any turn.
- **Caps can each be disabled** (`SLAUDE_WAKE_MAX_USD`, `_TURNS`, `_MINUTES`), and `slaude_wake_*` metrics and `/heartbeat status` report what wakes really take, so the values come from data. The day's pool always bounds a wake's spend.

## Decisions

Same runtime as cron, different trigger: not a real `cron_jobs` row, which would resume one transcript forever and has no gate or budget. Not a `Default:` level on the round either, because a round's item text can come from an external source, so that would let an email reach a full-tools turn.

External sources stay behind the locked triage pass, and a wake never reads its raw material.

## What building it found

- A node's worker aborts any turn at the job token's TTL (15 minutes). A wake's wall clock is set just inside it, so the wake closes its own run. Turning the wall clock off does not let a wake outlast a turn on a node.
- An aborted query reports no usage, so a wall-clock stop counts at the USD cap.
- A fresh start needs a new session row: the CLI session id is the row id, and a boot with an existing transcript flips to resume. Wake rows are swept after 14 days; transcript files stay.

## Not verified

- **Whether `maxBudgetUsd` stops a query under OAuth.** The design depends on it. Test this first.
- What a fresh full-tools wake costs.
- A live model doing checklist work rather than describing it, and using `finish_round`.
- `read_channel` against real Slack scopes.
- A post, a reply, and a turn continuing with the context, on real nodes.
- Postgres for the migration beyond the schema-drift test (pglite).

## Known limits

External spend (GPU, paid APIs) is not metered. A wake holds a worker slot and the proactive folder while it runs. Learned rules are enforced on posts, not on work. Anyone in a thread can get a `Read:` channel's text into it by asking, so list only channels everyone who talks to the agent may see. A non-Slack tool that can post (a browser, an MCP server) is outside restraint, as in every turn.

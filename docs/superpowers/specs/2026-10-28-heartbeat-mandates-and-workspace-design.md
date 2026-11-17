# Heartbeat: channel mandates in triage, one persistent proactive workspace

Date: 2026-10-28. Follows the heartbeat round (`2026-10-27-heartbeat-round-design.md`).

Status: implemented on the epic branch; see the plan (`../plans/2026-10-28-heartbeat-mandates-and-workspace.md`) and the field note `2026-10-28-heartbeat-mandates-and-workspace`.

## Intent

Two gaps in the heartbeat round, both found by asking how a proactive turn
does real work:

1. **Routing is blind.** Triage picks a destination channel for each item, but
   its prompt lists only the ids of the channels where proactiveness is on
   (`Channels where proactiveness is on: <#C…>`). It never sees what a channel
   is for, so "does this belong to channel A, B or C" is a guess from an id
   and whatever channel pages the model happens to search.
2. **Every proactive turn starts in an empty folder.** Each post is a new
   thread, and `ensureSession` gives every new thread its own empty
   `workspaces/<team>-<channel>-<thread>` folder. An `act` turn that needs a
   repository clones it again every time.

## Goals

- Triage judges each item against the mandate of each channel it could go to.
- Every proactive turn of an agent in a channel post's thread works in the
  same persistent folder, so a repository cloned once is reused by later
  rounds (pull, not clone). DM posts and promise checks keep their own folder.
- Only one turn works in that folder at a time.

## Non-goals

- One triage run per channel (approach B below). Later, together with
  per-channel folders, if the budget allows N runs per round.
- Per-channel proactive folders. The owner's call: one global folder now,
  per channel later.
- Giving the triage run any file tool. It reads untrusted text; it stays
  read-only (its six tools only).
- Changing where non-proactive threads work.

## Anti-goals

- A mandate that reaches triage from anywhere but the operator's SOUL (a
  source, a page, a runtime override that a person in a channel could set).
- A second proactive turn failing, or being dropped, because the folder is
  in use. It waits.

## Approaches (for routing)

- **A. Global run, mandates in the prompt** (picked). One run reads every
  source once; the prompt lists each enabled channel with its mandate. One
  model run per round; items for no channel still go to the manager. Risk:
  with many channels the mandates are applied loosely.
- B. One run per channel, each with one mandate. Simplest relevance question
  and fits per-channel folders, but N runs per round, cross-channel dedupe,
  a separate run for manager-only items, and watermarks per channel × source.
- C. A, plus a per-item mandate check before posting. Catches A's loose
  calls but adds a second step and never reconsiders an item A did not route.

The owner picked A: it fixes the actual gap (the mandate was never shown)
at almost no cost and keeps the structure global.

## Decided

### Part 1: mandates in the triage prompt

- `CHANNELS_ON` becomes a block: one entry per enabled channel, the channel
  id and its mandate. The mandate is the channel's `## Channel` block
  mandate, or the global mandate when the block has none (say "the global
  mandate" rather than repeating it per channel). The global mandate appears
  once, above the list.
- Source of the mandate: the persona's effective soul for that channel
  (`effectiveSoulForChannel`), the same text a turn in that channel gets.
  That function takes no persona today; the round must resolve the mandate
  for its own persona, not the default one.
- The prompt says to route an item to a channel only when it fits that
  channel's mandate, else to the manager or `none`.
- Every interpolated mandate goes through the same one-line, no-`<` escaping
  the other blocks use, and is bounded in length (a long mandate is cut,
  with a marker).
- Unchanged: the code decides what is posted. The explicit-channel rule
  (only channels with their own `### Proactive / Enabled: yes`), rules, the
  `Highest` ceiling and restraint stay enforced in code, not by the prompt.

### Part 2: one persistent proactive workspace

- Folder: `workspaces/agent-<agentId>/proactive/`, under `paths.workspaces`
  (on the cluster that is the shared volume, so every gateway and node sees
  the same folder).
- Which turns use it: a thread created by a heartbeat `ask`/`act` dispatch
  of a post whose audience is `channel` gets that folder as its
  `working_dir` when its session is created. Later human replies in that
  thread keep it, as any thread keeps its folder. A post to the manager or a
  person is a DM, and its thread keeps its own per-thread folder: files made
  for one person must not sit where channel threads work, and the folder is
  for work shared across posts, which a DM is not. Promise checks, cron runs
  and ordinary threads are unchanged.
- Claim: a turn whose session works in that folder takes a claim on it for
  the length of the turn. A second such turn waits for the claim (delayed and
  re-tried, like a session lock held by another node), never fails or drops.
  A claim held by a dead process expires.
- The folder is created on first use and never cleaned by slaude.

## Known limits (stated, not fixed here)

- One folder for all channels: an `act` turn for channel A can read what an
  `act` turn for channel B left there. Accepted for now; per-channel folders
  are the fix later.
- One turn at a time in the folder: a long `act` turn delays the next one.
- A human reply in an old proactive thread also waits for the claim.
- On the queue path the gateway's event follower stops 20 minutes after
  enqueue and is not extended while a job is delayed: a turn that waits for
  the folder and then runs past that loses its reactions, status, done and
  error posts (the reply itself still posts).
- Each 500 ms requeue of a job whose token is past 20% of its life makes a
  `/v1` token-refresh call.

## Left to the builder

- Where the claim lives and its key (it must work in mono, on the gateway
  queue path and on nodes), its time to live and refresh, and reusing the
  existing session-lock delay/requeue path where it fits.
- How `ensureSession` learns the folder for a dispatched thread (an option on
  creation, set only by the proactive transport).
- The mandate length bound.
- Tests: the prompt carries each channel's mandate and inherits the global
  one; a mandate cannot break out of its block; a dispatched thread's session
  works in the agent's proactive folder; two turns in that folder never
  overlap and the second one runs after the first; a non-proactive thread's
  folder is unchanged.

## Release

Touches the agent loop (session working directory, a turn claim), so it
ships as a release candidate first.

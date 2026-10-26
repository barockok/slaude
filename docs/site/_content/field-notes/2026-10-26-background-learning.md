---
title: "Background learning: budgeted one-shot passes, scoped to one person at a time"
date: 2026-10-26
---

# Background learning: budgeted one-shot passes, scoped to one person at a time

**Date:** 2026-10-26
**Status:** Built on the epic branch, unreleased. It touches the agent loop and the DB schema (migrations 0019 to 0027), so it goes out as a release candidate first. Checked against a fake brain, a fake SDK `query` and a fake Slack. The pass lockdown was checked once against the real CLI and the repo's mock LLM. It has not been checked against a live model or the real gbrain engine.

Phase C gave memory a shape. It is filled only while someone is talking, and
only when the live turn decides to save something. Phase D adds work between
conversations:

- a nightly review that catches what live capture missed;
- an upkeep of the agent's own operating lessons;
- a summary when a busy thread goes quiet;
- a weekly review that retires skills that don't help;
- a weekly digest for the manager.

All of it runs under a daily budget. Four rules bound it:

- A pass over one person's private conversations runs as that person and
  sees nobody else's (invariant 1).
- A profile entry is written only from that person's own words (invariant 2).
- Nothing outside a pass's own slice is written without someone's approval.
- Spend is measured by Slaude itself, never taken from the SDK's figure.

## The mechanism

### A pass is one locked-down `query()`

Every model-driven pass runs through `runPass` (`src/background/runner.ts`) as
one SDK `query()` on the gateway, or in process on mono. It is never a full
agent session: a session cannot restrict its tools or cap its turns. The
options are:

- no built-in tools (`tools: []`, and the few that survive an empty set are
  disallowed by name);
- no settings, hooks, plugins or MCP config from disk;
- `dontAsk`, with only the pass's own `mcp__slaude_pass__*` tools pre-approved,
  and a PreToolUse hook that denies everything else;
- `maxTurns` from the pass's cap; `persistSession: false`;
- a scrubbed child env on the persona's own provider set, the same one its
  runtime bundle carries: the declared `provider`, else its encrypted
  `provider_creds` rows (persona row over tenant row). With such a set, every
  provider-selecting variable of the process is removed first, so a key and a
  base URL never come from two places (the WS-A rule). Only a persona with
  neither runs on the process's own provider env.

A run with the real CLI against the mock LLM showed the following. Only the
five pass tools were offered, and a call to one ran. Bash, Write, Monitor and
another server's tool came back as "No such tool available". The hook ran even
with `settingSources: []`, and an abort mid-run left nothing unhandled.

### The pass tools

The `slaude_pass` server (`src/background/pass-tools.ts`) has five tools:
`read_pages`, `list_pages`, `search`, `memoize` and `propose`. Each brain call
is scoped to exactly one source.

- **Agent scope** reads `agent-<id>`, the legacy `agent` source (read-only),
  `shared`, `public` and the persona's `kb-*`. It writes to `agent-<id>` only.
  Here a `correction` page is a lesson candidate in the agent's slice. A
  profile page is refused.
- **User scope** (a pass running as one person) reads that person's
  `user-<id>` and their `profile-<team>-<user>` first, then the agent-scope
  list. It writes ordinary pages to `user-<id>`. A `profile` or `correction`
  page goes to the person's profile, and only with a `quote`. The quote must
  appear verbatim, whitespace collapsed and at least 8 characters, in one of
  that person's own turns in the transcripts the pass was given. A turn whose
  author is the agent or the system never satisfies a quote.
- **Nothing is written to `shared`.** `target:"shared"` and `type:"team-fact"`
  are refused with a pointer to `propose`. `conversations/…` slugs are refused
  in every pass, and so is a lessons page over 40 lines.
- **`propose`** stores a row in `proposals` that expires after 14 days.
  - In user scope it may only be kind `promote`, and it is always addressed to
    that person.
  - In agent scope it is always addressed to the manager.
  - A payload with a credential-like value is refused. The check walks every
    key and value, because JSON's `"api_key":"…"` is not the shape
    `redactSecrets` matches.
  - The guards that apply on approval run at propose time too, so a proposal
    that could never be written is never queued.

### Who wrote a turn

The nightly review reads the day's `conversations/<session>` timeline entries.
Each entry is `<user>…</user>\n<assistant>…</assistant>`. Each inbound
envelope in the user part becomes one turn whose author is its `user_id`, and
only a `source="slack"` envelope names an author. A panel envelope, a runtime
check, a cron prompt or a skill body (but not its `<skill-args>`) is a `system`
turn. In a person's slice, turns by anyone else are dropped and logged. So a
quote can only come from that person's own message.

### Cost and the budget

- **Price table.** `SLAUDE_PRICE_TABLE` is inline JSON or a file path. The
  built-in table holds Anthropic list prices taken on 2026-10-25. cache_read
  is listed for four models and taken as 0.1× input elsewhere. cache_write is
  1.25× input, the 5-minute TTL. A dated snapshot id (`-YYYYMMDD`) is priced
  as its alias, exactly. The reference lists no prices for retired or legacy
  models, so those need a table entry. Boot logs one loud line for
  `SLAUDE_MODEL` or a persona model the table lacks.
- **An unset or unpriced configured model still runs.** `SLAUDE_MODEL` is
  optional (the CLI picks its default), so a check or pass starts at its
  estimate and is priced by the models the CLI reports: each assistant
  message's `model`, then the result's `modelUsage`. A reported model with no
  price ends the run as `error` after that turn and keeps at least its
  estimate. Nothing is priced at zero. Such a run's real cost is unknown and
  its estimate never rises (an `error` run is never a last ok cost), so the
  ledger records `unpriced_model` (migration 0027) and every further check or
  pass of that agent is refused for the rest of its local day: an `error` row
  at $0 carrying the model, and one loud log line per agent and day naming it
  and `SLAUDE_PRICE_TABLE`. Read from the ledger, so it holds across replicas.
- **The ledger.** `background_runs` holds one row per pass run, with its
  tokens, cost and outcome (`ok`, `skipped-budget`, `stopped-budget`,
  `error`). A run starts with its estimate as a provisional cost. Each
  assistant message is priced as it arrives and written to the open row, so a
  crashed or running pass already counts.
- **Output tokens are under-reported mid-run.** The CLI's assistant messages
  carry `message_start`'s usage, measured as output 1 for a call that produced
  700. So each message's output counts as at least 1024 tokens until the
  result's cumulative usage replaces the figure, priced per model from
  `modelUsage`.
- **The daily budget.** `SLAUDE_BACKGROUND_BUDGET_USD` (default 1) can be
  overridden per persona by `background.budgetUsd`. The day runs in
  `background.timezone`, else `SLAUDE_BACKGROUND_TIMEZONE`, else UTC. A pass
  starts only if `remaining ≥ max(last ok cost, floor)`, checks after every
  turn, and is aborted once over. It overshoots by at most one turn. The start
  inserts the row with its estimate first and then re-reads the day's spend,
  every other open row included; over ends it `skipped-budget`. So starts in
  the same moment see each other's estimates and never overshoot together.
- **The nightly goes first.** Until today's nightly has a finished row, the
  other passes start only if the nightly's estimate would still fit after
  them. A budget-skipped nightly keeps that reserve.
- **The post-turn skill check** (the auto-evolve check from phase A) runs on
  the same ledger. Mono records it in process; a node records it through `/v1`
  start and finish routes; a node's start may name the model the CLI reported
  for the qualifying turn, a bounded model-id string used only to label the
  run. Open skill-check rows older than one hour, and other passes' rows older
  than two hours, are swept to `error` and keep their estimate, so a lost
  finish never counts as zero.

### The scheduler

`src/background/scheduler.ts` ticks every 60 s on the gateway's elected
`background` leader, or directly on mono. It never runs on a node, and it never
boots the brain: a tick while the brain is closed only sweeps stale runs and
expires proposals. Each tick:

1. **Works out the due slots** in persona-local time. The nightly review is
   due at 02:30, with the lessons upkeep after it. The skill review is due
   Sunday 04:00, and the digest Monday 09:00. A slot is the period it belongs
   to: a day, or an ISO week. It stays due until that period ends, so a missed
   02:30 runs late, but never on a later day.
2. **Claims each slot with an INSERT** into `background_slots` before its pass
   starts. A second tick, a second replica or a new leader never runs it again.
3. **Then claims and runs quiet threads.** A thread is quiet after N
   interactive turns (default 8) and M quiet minutes (default 30). There are at
   most K passes a day (default 5), under the slot `<session>@<last_turn_at>`.

Shutdown aborts the pass in flight after its current turn, which is recorded
as `error`. Passes not yet started are named in the log, and `stop()` waits at
most 10 s.

### The passes

- **The nightly review** (`passes/nightly-review.ts`) covers the persona-local
  day before its slot. It runs one agent-scope pass over the agent slice's
  channel threads, then one pass per person and Slack team over that person's
  `user-<id>` threads, running as them. Each pass gets only its own slice's
  entries from that day, newest kept when the day exceeds 120 000 characters.
  The agent pass also writes lesson candidates to `self/lesson-proposals`.
  After a pass that ran as a person, its proposals are posted to that person's
  DM in one message.
- **The lessons upkeep** merges the candidates into `agent-<id>/self/lessons`,
  40 lines at most. A candidate waits for a second sighting for up to 14 days.
  The upkeep runs only after that day's nightly rows have all finished.
- **The quiet-moment pass** writes `conversations/<session>/summary` in the
  thread's own slice. `kb_thread_history` shows it before the older turns.
- **The skill review** applies to agent-authored skills only. `write_skill`
  stamps them; installed and bundled skills win any tie. It counts each
  skill's uses, and it may retire at most three skills a run, as a soft move
  to `<skills>/.retired/<slug>-<UTC>/`. An installed or bundled skill can only
  be proposed for removal to the operator.
- **The digest** uses no model. It goes to the manager's DM, or the backup's
  when no manager is set, and covers the previous Monday to Sunday:
  - spend per day against the limit;
  - runs by pass and outcome;
  - skips for budget, counted per pass and day so a skipped pass never names
    whose conversations it covered;
  - lessons added and dropped, diffed against the snapshot the last delivered
    digest stored in its slot row;
  - skills written and retired, each retired one with Restore;
  - the open manager proposals, each with Approve and Reject.

### Proposal cards

A card (`src/background/proposal-cards.ts`) is a stored row, never a blocking
gate.

- **Who decides.** Only the person a proposal is addressed to may decide it.
  A manager proposal may be decided by the manager or the backup.
- **One decision.** `Proposals.decide` is the one atomic transition, so a
  second click or a second replica changes nothing.
- **Approve writes through `kb_memoize`,** with the approver as the actor and
  the click as the approval. The write gets the same page guards as the pass's
  own memoize. A failed write reopens the row.
- **Shared memory always needs the manager.** When a person approves a
  `promote` to `shared`, it becomes a new manager proposal carrying their
  consent (scope `user:<person>`). The manager's digest shows it with "<person>
  agreed to share this", and only the manager's Approve writes it.
- **Cards go out as the persona's own app.** The poster is that app's bot
  client: the buttons are interactivity-bound, and the bot has `chat:write`
  and `im:write`. On a gateway with more than one app, a post must name both
  the app id and the team, or it is refused; nothing falls back to the oldest
  app. Each card records the app it went out as, and a click through any other
  app or workspace is refused.

## Decisions

- **Passes are one-shot `query()` runs, not sessions.** The cost: they never
  reuse a warm session's cache.
- **The budget counts background work only.** User turns are never counted,
  and the post-turn skill check is.
- **The estimate is `max(last ok cost, floor)`,** so a near-zero last run never
  unthrottles a pass.
- **A person's approval cannot write shared memory.** Sharing is two steps,
  the person and then the manager. A person may approve a promotion into the
  agent's own slice directly.
- **The digest goes to the manager only.** The backup gets it only when no
  manager is set.
- **The 30-day-unused retirement rule lives in the prompt.** The spec allows
  retiring a used but harmful skill. A bad retirement is bounded by three per
  run, a provenance re-check at the call, a recorded event and a Restore click.
- **Quiet-moment counts interactive turns only.** A cron in a busy thread would
  otherwise trigger K summaries a day. K counts every outcome, so a
  budget-skipped quiet stretch waits for the nightly.
- **Timeline reads do not filter by `updated_after`.** gbrain's filter uses the
  page's `updated_at`, which appending a timeline entry never bumps, so it
  would drop long-running threads. The cost: nightly reads scale with users ×
  sessions.
- Timestamps are epoch-ms integers, the repo's convention. Migrations are
  numbered in task order: 0019 runs, 0020 persona `background`, 0021
  proposals, 0022 slots, 0023 thread activity, 0024 skill usage, 0025 the
  digest's slot state, 0026 the card's app, 0027 a run's unpriced reported model.

## What review found

- **A person could approve their own write to shared memory.** The first card
  handler applied a person's `promote` to `shared` with that person as the
  approver, and no manager was involved. A person's approval of a shared write
  now becomes a manager proposal, and `applyWrite` refuses a shared write from
  anyone but the manager or backup.
- **Cards posted as the wrong app.** On a gateway with more than one app, cards
  went out through the transport's default client, the oldest app (the WS-D
  defect again). A click through that app could not be bound to the persona.
  Now the post goes out as the persona's own app, and the click is checked
  against the app and team recorded on the card. The first forwarding fix
  copied the person's card stamp onto the manager's row, so the manager's
  click was refused as the wrong app. The digest that shows the row now stamps
  it.
- **Approved writes skipped the pass's guards.** An approved proposal could
  write a `conversations/…` page, a lessons page or a profile. The same guards
  now run when the pass proposes and again when the card is approved.
- **The credential check missed JSON keys and values,** as described above.
- **Mid-run output was under-counted.** This was confirmed with the real CLI;
  the fix is the 1024-token floor until the result arrives.
- **The skill check read `modelUsage` wrongly.** The pinned CLI reports
  `modelUsage` as a running total per process, and the turn's `usage` per
  turn. The first attribution took a difference, which misread per-turn
  figures when the check used more of every kind than the user turn. The shape
  is now decided from `usage`: when Σ `modelUsage` equals `usage` it is per
  turn, otherwise a delta, falling back to `usage` when the delta disagrees.
- **Open rows counted $0.** A started check or pass charged nothing until it
  finished, so parallel starts could all pass the gate. Now every open row
  carries its estimate until it is priced, and the sweep closes skill-check
  runs older than one hour and other runs older than two.
- **A stuck check flag.** An errored check turn never cleared `inAutoEvolve`.
  The next user turn was then treated as a check, and on a node that job never
  ended. This bug was older than phase D.
- **Shutdown waited for the whole nightly,** because `runPass` ignored an
  outside signal. An `AbortSignal` now runs through the runner, and
  `gateway.stop` bounds the wait at 10 s.
- **Authorship.** Any envelope's `user_id` counted as an author (now only
  Slack's), and a skill body counted as the person's words (now only the
  args). The upkeep could also merge while the old leader's nightly was still
  rewriting the proposals page; it now waits for that day's nightly rows to
  finish.
- **`updatedSince` dropped the most recently touched sessions** past its limit.
  It now orders by `updated_at DESC`.
- **Skill restore.** Restore could bring back a skill whose frontmatter `name`
  was a built-in's (invariant 9). The three-per-run cap was also checked after
  an await, so two calls could both pass it; the slot is now held first.

The final whole-branch review found:

- **The default install did nothing.** With `SLAUDE_MODEL` unset (the
  documented default) every skill check wrote an `error` row and every pass
  refused to start, so auto-evolve, a phase-A feature, stopped after the
  upgrade. The deploy docs' example ids (`claude-sonnet-4`, dated ids) were
  unpriced too. Fixed as above: run on the reported model.
- **A persona with no declared provider ran its passes on the gateway's own
  env.** The gateway's key paid, and the gateway env's base URL received each
  person's /1on1 transcripts, while the persona's bundle uses its
  `provider_creds` rows. A gateway that holds no provider env failed every
  pass. Passes now resolve the rows as the bundle does.
- **A multi-persona group ran every pass under its first persona's provider
  and KBs,** not only its model and budget: a second persona's people's
  transcripts went to the first one's provider host. The quiet-moment pass now
  runs as the thread's own persona, and a persona whose provider, model or
  `kbSources` differ is not grouped (below).
- **Check-then-insert.** The start rule read the spend, then inserted, so
  checks finishing in the same minute each saw room for one and overshot
  together. Now insert, then re-check.
- **`..` slug segments** (`people/../conversations/<s>`, `x/../self/lessons`)
  passed the guards, which match leading segments only. A slug with a `.` or
  `..` segment or a backslash is now refused in pass writes and approved
  proposals.
- **A vacuous scenario check.** Bob's later `<memory-context>` block was empty,
  so its absence assertions held for any content. The scenario now seeds a
  channel note he may read and asserts the block holds it.

## Verification

`tests/background/one-on-one-nightly.test.ts` runs the mono gateway with its
real turn path and its real scoped memory sync. The brain is an in-memory fake,
`query` is a scripted model, and Slack is a fake.

1. On day D, Alice has a turn in her locked /1on1 and Bob has a turn in a
   channel thread. The sync writes them to `user-<alice>` and the agent slice.
2. At 02:30 on D+1 the scheduler claims the nightly slot. A second tick runs
   nothing.
3. The channel pass writes a note about Bob to the agent slice. Its profile
   write is refused.
4. The pass as Alice writes a person-note and a profile entry quoting her. A
   quote from the agent's reply is refused, and so is a direct shared write.
   It proposes a team fact. Every write lands in her slice or her profile.
5. The proposal is posted to Alice's DM only. Bob's click on it is refused.
   Alice's click forwards it to the manager, and nothing reaches shared.
6. Bob's later channel turn sees none of Alice's pages: not in his block,
   `memory_about` or `kb_search`. He does see the agent-slice note.
7. The ledger has one row per pass, each priced per kind from the result's
   `modelUsage`.
8. The next Monday's digest renders the spend and the runs, and cards the
   forwarded proposal without Alice's private pages. The manager's Approve
   writes only the team fact to shared.

## Not verified

- **A live model running the passes.** Nothing shows that it finds what live
  capture missed, quotes correctly, keeps lessons useful or retires the right
  skills. Every pass test scripts the tool calls.
- **Real gbrain op shapes.** The fake brain stands in for:
  - `get_timeline` returning `created_at`, read from gbrain's SQL;
  - `list_pages` with `{type}` and `{tag}`;
  - `sources_list` through the admin path, including a remote brain;
  - a nested `conversations/<s>/summary` slug;
  - frontmatter round-trip.
- **Real Anthropic price drift.** The default table is dated 2026-10-25, and
  its derived cache prices are not list prices. 1-hour-TTL cache writes (2×)
  and Haiku's prompt price above 100K tokens are underpriced. Operators set
  `SLAUDE_PRICE_TABLE`.
- **Live `modelUsage` behaviour.** That it is a running total per CLI process
  and the turn's `usage` is per turn was read from the pinned CLI's code and
  measured against a stub. No live provider run has checked it.
- **The real CLI's Skill tool name** (`<plugin>:<name>` or the bare name) for
  usage counts. Both normalise to the bare name, but no live run has checked
  it.
- **HA leader failover under load.** The claim-before-run logic is unit-tested
  with fake elections, not on a cluster.
- **DST beyond the tested zones.** The local day was tested across a DST
  change in Europe/Berlin only, and the schedule and nightly bucketing in
  America/New_York. The 02:30 slot on a day when 02:30 is skipped or
  repeated is untested.
- **Real Slack.** Not checked: opening a DM by posting to a user id,
  `replace_original` on a message holding several cards, and the multi-app
  HTTP posts.
- **Migrations 0019 to 0027 on Postgres.** They were not run on Postgres
  locally (only on PGLite through the drift test); CI runs real Postgres 14,
  16 and 17.
- **The real CLI abort** mid-stream or during a slow tool call. The harness
  aborted only between responses.
- **Per-persona provider resolution** against real `vault://` or `env://`
  values on a managed tenant. The rows path was checked on PGLite only.
- **The CLI's `message.model` and `modelUsage` keys with no `--model`.** That
  the CLI names its default model there, and that its dated ids price through
  the alias, is read from the SDK types, not a live run.

## Known limits

- **The nightly is one claim a day.** A crash or shutdown after the agent pass
  loses that day's person passes; they are logged, not retried.
- **Upkeep after a skipped nightly.** Two cases. After a budget-skipped
  nightly the upkeep still runs, merging earlier days' candidates under its own
  budget check. On a day whose nightly ran no pass at all (no conversations)
  there is no upkeep, and its candidates wait for the next day's.
- **Nightly reads scale with users × sessions,** one timeline read per
  candidate thread per person slice (see the `updated_after` decision).
- **`get_timeline` returns at most 100 entries** at day granularity, so a
  thread with more turns since the day began loses some (logged).
- **The default persona's budget is shared.** Every tenant's default persona
  uses the process agent id, so they share one ledger and one budget.
- **Personas on one agent id.** A persona without its own Slack user id shares
  the process agent id, its ledger and its `agent-<id>` slice. It joins that
  group only when its declared provider, model and `kbSources` equal the
  group's first persona's; otherwise it is logged once and gets no background
  passes until it has its own `slackUserId`. A joined persona's nightly,
  upkeep and skill review still run under the first persona's settings,
  budget and timezone (they are equal in what routes data, not in budget);
  the quiet-moment pass runs as the thread's own persona. Splitting the
  nightly per persona is left to phase E. Every group's proposals go to the
  default soul's manager.
- **An unpriced reported model costs one run a day.** The first check or pass
  whose CLI reports a model the table lacks spends its turn, ends `error` and
  keeps at least its estimate (its true cost is unrecorded); background spend
  for that agent is then off until the next local day. Add the id to
  `SLAUDE_PRICE_TABLE`. A custom table
  replaces the built-in one, and `{}` loads without complaint, so every run
  then ends this way.
- **Simultaneous starts may both skip.** With insert-then-recheck, two starts
  with room for one can each see the other and both end `skipped-budget`. It
  never overshoots; it may under-run that moment.
- **A pass that crosses local midnight** charges its whole cost to the day it
  started.
- **The nightly reserve** stays all day on a day whose nightly had nothing to
  review, and it is sized for one nightly pass (its estimate), not the agent
  pass plus one pass per person.
- **Upgrade the gateway before its nodes.** A node newer than its gateway gets
  404 from the skill-check routes and fails closed: auto-evolve stays off on
  that node until the gateway is upgraded.
- **`write_skill` on a personas-repo skill that is not in `slaude.lock`**
  stamps it agent-authored, so the skill review may retire it. A git sync
  restores it.
- **The person-proposal path's guard on summaries is the prompt.** A
  /1on1 summary is served to anyone who later speaks in that locked thread
  (`kb_thread_history` reads the lock owner's scope), while the pass can read
  the person's whole slice and profile. The user prompt says to summarize this
  thread only and nothing about anyone's private life; nothing in code checks
  it.
- **A single turn over 120 000 characters** makes the transcript cap return
  nothing, and the quiet-moment pass would then fail on a previous summary.
  Memory sync truncates each turn to 800 + 800 characters, so the sync path
  cannot reach this today.
- **The other minors are left alone** (the full list from the task reviews):
  - A crash between approving a card and writing it leaves an approved row
    with nothing written.
  - Expired cards keep their buttons; a click answers that the card expired.
  - The digest's budget line uses today's limit for past days.
  - "Skills added" means written or revised that week.
  - A failed snapshot store repeats a lesson diff.
  - The sweep closing a hung live run double-counts its metrics.
  - On mono, the skill-check turns count as thread activity.
  - After the 10 s stop bound, a pass stuck in a brain call can still run when
    the brain closes; it fails and is logged.
  - A pre-existing hazard: a manifest skill named `.retired` would make the
    installer delete the retired folder.
  - The skill check's start estimate uses the gateway's view of the model
    (the session row, else the persona default), not the node bundle's; a mono
    session with no route records scope `agent` (a label only).
  - A settle failure inside the pre-query try can open a second row, later
    swept as `error` at $0.
  - `holdsCredential` misses a credential split across `{name, value}` fields.
  - `collectDay` does not check the shutdown signal between reads.
  - The `/v1` thread-activity write is awaited without a timeout.
  - The quiet-moment summary plus the first turn can exceed the 12 000
    character cap by about 4 000.
  - Restore's live-slug check races a rename; retire does not check that
    `SKILL.md` exists; `allAgents` sums skill usage across tenants (one deploy,
    one tenant).
  - The digest stamps every open manager proposal with its app, including
    rows past the eight it shows (the same app, so harmless).
  - Every skill-check start also sweeps stale skill-check rows, which the
    scheduler sweeps too.

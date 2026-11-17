# Engagement, Approvals & Slash Commands

Every Slack message either reaches the model or it does not. This guide explains exactly when it does, how the human stays in the loop for risky work, and which slash commands give you direct control without talking to the agent.

> **Prerequisites:** You have deployed slaude, the bot is in your workspace, and you have edited `SOUL.md`. If not, start with [Getting Started](../start/getting-started.md).

---

## 1. Engagement model

One Slack thread is one Claude session. But not every message in the thread is for the agent. Slaude uses a three-rule engagement gate that is cheap to reason about and persisted so it survives restarts.

### 1.1 The three rules

1. **@mention the agent to engage.** A message that contains `<@BOT_ID>` (or a persona user ID in multi-persona mode) engages the thread. From that point, plain follow-ups in the same thread are delivered to the model without another mention.

2. **@mention someone else to disengage.** A message that mentions a different user (and not the bot or any persona) disengages the thread. The user is now talking to a colleague, not the agent.

3. **DMs are always engaged.** `channel_type === "im"` skips the gate entirely. No mention needed.

All other messages follow from these: plain replies in an engaged thread are handled, plain replies in a disengaged thread are dropped or silently recorded (see below).

### 1.2 Step-by-step flow

Imagine a public channel `#platform` where slaude is installed.

**Step 1 — Engage the thread:**

```
you:  @slaude can you review the bulk-corpus ingest job?   ← mentions bot → engaged
slaude: On it — looking at the latest run now…
```

The gateway adds `channel:threadTs` to the in-memory `engaged` set **and** flips `sessions.engaged = 1` on the row so the state survives a restart. Both `app_mention` and `message` events with a bot mention drive this path.

**Step 2 — Stay engaged without another mention:**

```
you:  focus on the error rate spike at 14:00 UTC           ← plain reply → handled
slaude: Found it — error rate 12% at 14:03, retries exhausted on shard-3…
```

The message had no `@slaude`, but the thread is in `engaged`, so it is forwarded to the model.

**Step 3 — Disengage by mentioning a colleague:**

```
you:  @jane can you take a look at shard-3?                ← mentions other user → disengaged
```

The gateway does two things: `engaged.delete(key)` and `sessions.engaged = 0`. If a session already exists for the thread, the disengaging message is still **recorded into the transcript as a suppressed turn** (the `UserPromptSubmit` hook returns `continue:false` so the model does not run, but the user message is persisted). On re-engage the model sees the gap already in history. If no session exists, the message is dropped.

**Step 4 — Plain messages while disengaged are recorded, not answered:**

```
you:  jane — did you restart the worker?                   ← plain, but disengaged → suppressed
# no reply from slaude; message is in history for next engage
```

**Step 5 — Re-engage with another mention:**

```
you:  @slaude shard-3 is fixed, continue the review         ← mentions bot → re-engaged
slaude: Got it — picking up where we left off. Shard-3 recovered at 14:12…
```

The model resumes with the two gap messages already in context. No re-fetch, no synthetic preamble.

### 1.3 Example transcript (annotated)

```
Thread: #platform — "bulk-corpus ingest review"

[@slaude can you summarize today's ingest?]        → ENGAGED  → model runs
[Here's the summary… 3 shards ok, 1 degraded]      ← reply
[what about the degraded one?]                      → ENGAGED  → model runs
[@jane can you check shard-3's disk?]              → DISENGAGED (suppressed turn, transcript keeps it)
[jane: on it]                                       → DISENGAGED (suppressed)
[@slaude jane fixed disk, resummarize]             → RE-ENGAGED → model sees both gap messages
```

### 1.4 Do / Don't

| Do | Don't |
|---|---|
| `@slaude` once per thread, then speak normally | `@slaude` every message (works but noisy) |
| Use `@someone` when you actually want to talk to them | `@here` / `@channel` — does not disengage (no user ID in the mention parse) |
| Expect plain history to be in context after re-engage | Expect the agent to answer while disengaged — it is recording silently |

### 1.5 Under the hood

```
src/gateway/core/gateway.ts  → engaged Set + threadKey() + persistEngaged()
src/db/sessions.ts           → sessions.engaged (INTEGER 0/1) — the durable flag
src/db/schema.ts             → UNIQUE(team, channel, thread, persona_id)
```

Without the `sessions.engaged` column, every disengage lasted zero messages: a disengaged thread still had a session row, so the next plain reply hit the "restore from row" path and re-engaged immediately. The column was added for [this finding](../field-notes/2026-06-11-engagement-disengage-durability.md). The suppressed-recording trick uses `continue:false` rather than `decision:"block"` — the latter discards the prompt before it is persisted, so the model would never see the gap ([finding](../field-notes/2026-06-16-reengage-hook-suppress.md)).

Restart recovery works the same way: on a plain, non-mention message the gateway looks up `Sessions.findAnyByThread()` — if the row exists and `engaged=1`, it restores the in-memory entry and handles the message without requiring a new `@mention`.

### 1.6 A session that starts inside an existing thread

An @mention can arrive in the middle of a thread the agent has not seen. The session's first real turn then starts with a short **thread head**: the thread's root message and the most recent earlier replies, oldest first, in a `<thread-head>` block placed before the message's own `<channel>` envelope. The agent reads it the way a teammate who was following along would, and answers the message in the envelope.

- **Size.** The root, then up to `SLAUDE_THREAD_HEAD_MESSAGES` earlier replies (default 10, `0` turns the feature off), each cut to 500 characters and 6,000 in total (the oldest replies go first, the root stays). A line says how many earlier messages were left out. Files are listed by name only and are not downloaded. In a thread longer than five pages of 200 messages the replies shown are the latest of the part that could be read, not of the whole thread, and the omission line says so.
- **Once.** Only on the session's first real turn, marked on the session row (`sessions.thread_head_at`). A message that is only recorded (a disengaged thread, a channel session's recording) never takes it, so a thread first seen as a recording still gets its head on the first real turn. A reply in a thread that already has a session, a root mention, a DM and a `/1on1`-locked thread get none. A turn that starts a session some other way (a scheduled run, a heartbeat or wake turn, the console) also uses up the head, so a person's later reply is not given one mid-conversation. A turn whose dispatch fails gives it back. A session that had already started before this feature existed (created before 2026-11-17 and already running) is treated as past its first turn and gets none; during a rolling deploy, a session first started by an older replica looks new to a newer one and gets a head on its next turn there.
- **Who is read.** Each line starts with its author's Slack id (`<@U...>`), or with `[you]` for the agent's own earlier messages; nothing else can start a line, so a display name cannot pose as the agent or anyone else. Only this agent's own identity is "you": another persona's or app's messages are named like anyone else's and filtered like anyone else's. Messages from anyone the agent's access rules would not let in (denied, or not granted in this channel, as at the door), from a user or thread that is ignored, and text or file names the owner's inbound guardrail rules deny, are left out. The head can show what `get_thread_history` returns on request, so this filtering is what keeps it from reading more than the agent could be told.
- **Not for a proactive post's replies.** A reply under a proactive post already carries that post's context, so it gets no head. The first-turn "what you have been doing" block does not count: a new human thread in a proactive channel still gets its head.
- **Fails open, and quickly.** The whole head (the Slack read, the author checks, the name lookups) runs against a deadline (`SLAUDE_THREAD_HEAD_DEADLINE_MS`, default 1500 ms) on a client that never waits out a rate limit. A Slack error, a deleted or missing root, or the deadline means no head and a turn that runs as before, with one log line.

Every earlier message is another person's text, so each piece (message text, display name, bot name, file name) is normalised (NFKC, format and zero-width characters removed, line breaks flattened) and every `<` in it is escaped before it is wrapped. A message that contains `</thread-head>` or a forged `<channel ...>` cannot close the block or pose as a person's request. The head is not stored in the episodic turn record.

### 1.7 Joining in without an @mention (implicit engagement, phase 0)

By default an agent answers when it is @mentioned, or when a message arrives in a thread it is already engaged in. Implicit engagement is a per-channel setting that lets it also take part when a message is, in effect, said to it. In **shadow** (the default mode) the agent only decides what it would have done and counts it, and may ask a classifier for a second opinion that is only logged and counted. In a channel whose mode is **`on`** (phase 2, below) it acts on a decision to run. This section says what each does, how to read the numbers, and how to roll a channel out.

#### The setting

Two places in the persona's `agent.yaml` (keys in the [reference](../reference/configuration.md#implicit-engagement)):

```yaml
aliases: [ana, anabot]            # other names the agent answers to
channels:
  "slack:channel:CTEAMCHAN":
    engage:
      level: addressed            # mention (default) | addressed | contribute
      mode: shadow                # shadow (default) | on
```

- **`level`** is how far the agent may go. `mention`: only when mentioned or already engaged in the thread (today's behaviour, and the default). `addressed`: also when a message is in effect said to it (its name used as a vocative, or a request from the person it just answered). `contribute`: also when it plausibly has something useful to add to a top-level question.
- **`mode`** is whether a decision is acted on. `shadow` decides and records but behaves exactly as `mention` does; `on` is reserved for acting on the decision. It is per channel and independent of the decision gate's own mode (`SLAUDE_DECISION_CONFIG`), so a channel can be `on` while another is in `shadow`, and the existing mention and engaged-thread handling is untouched.
- **Default level.** A channel with no `engage.level` uses `addressed` when the agent is proactive there (see the warning below) (`proactive: true` on the channel, which is a channel session: an agent that may speak up unprompted should also hear what is said to it), else `SLAUDE_ENGAGE_DEFAULT` (`mention`, `addressed` or `contribute`; anything else means `mention`). An explicit `engage.level` always wins, including `mention`; a channel with only `engage.mode` set still takes the proactive default for its level. With nothing configured anywhere the answer is `mention` in `shadow`, which changes nothing.
- **Warning: proactive channels start classifying on upgrade.** Because a proactive channel now defaults to `addressed`, a deployment that has a decision adapter configured begins shadow classification of unaddressed text in every proactive channel as soon as it upgrades, with no `engage` key written anywhere: the candidate and a short slice of recent text go to the adapter (see "What leaves the box"). Nothing acts on the answers. To keep the old behaviour set `SLAUDE_ENGAGE_PROACTIVE_DEFAULT=off` (the channel then uses `SLAUDE_ENGAGE_DEFAULT`, normally `mention`), or write `engage: { level: mention }` on the channel. With no adapter configured the only effect is phase 0 counting.
- **Restricted channels are never eligible.** A channel that is neither listed as public nor trusted for the persona stays at `mention` whatever is configured.
- **`aliases`** are extra names the agent answers to (its own name always counts). Each is one word of letters and digits, 3 to 32 characters, not a common word (`team`, `help`, `thanks` and similar are refused), not the agent's own name, not repeated (case and width are ignored), and not mixing look-alike scripts such as Latin and Cyrillic; at most 8. Two agents may not claim the same name, and an alias may not be another agent's name. A bad alias stops validation with a message that never repeats the value.
- **Classic agents** answer a root mention inside a thread, so "the agent spoke last" at a channel's top level holds mainly in channel-session channels or after a proactive post. In a classic channel, `addressed` works mostly through names and replies to the agent's thread messages.

#### What phase 0 does

This is the base layer, and it is all there is when no decision adapter is configured. For a channel above `mention`, each message the agent was not going to answer is run through the tier ladder (below), and the result is counted and logged. That is all:

- no model call and no decision adapter is involved;
- no Slack history read (the ladder uses only the message itself and a small record of who spoke last);
- nothing is posted, no reaction, no status, no session row;
- at `mention` (the default) it returns before reading anything.

Each decision increments `slaude_engage_total{tier,outcome,level}` and logs one line with no message text:

```
[engage] phase0 channel=C... level=addressed tier=3 would=classify reason=name_mid classifier=queued
```

The trailing `classifier=` field is `queued` when phase 1 will ask a classifier about the message, or `skip:<why>` (`disabled`: no shadow classifier wired, `not_candidate`: tier 0 or 1, or a tier 2 decision that is not run). What the classifier said comes later, on its own line (see phase 1).

`tier` is `0`, `1`, `2`, `3` or `existing`; `outcome` is `pass`, `run`, `classify` or `existing`; `level` is `addressed` or `contribute`. A text longer than 4,000 characters is cut to that before the ladder reads it, and `slaude_engage_truncated_total` counts each cut. With several Slack apps in one channel each app's copy observes the message once, so the counter counts per copy.

#### The tier ladder, in plain words

The first rule that settles a message wins.

- **Tier 0, pass (no cost).** The channel is at `mention` or restricted; the message is an edit-like or system subtype; a bot wrote it; the thread is `/1on1`-locked, mention-only or disengaged; it names someone else (an @person, a user group, `@here`, `@channel`, a "Budi, ..." vocative); it is only an acknowledgement ("ok", "thanks, that worked", an emoji); or another registered agent spoke last. Quotes, code, links and emails are stripped before names are looked for, and forwarded text is never matched.
- **Tier 1, run.** An @mention of the agent; its name or alias at the start followed by a comma and a request or second-person sentence ("Ana, can you look at this"); or a reply in a thread the agent is engaged in (counted as `existing`). A colon form ("Ana: ...") is not tier 1, because pasted transcripts start that way.
- **Tier 2, run (`addressed` and up).** The agent spoke last here within `SLAUDE_ENGAGE_WINDOW_MINUTES`, the author is the person it answered, and the message looks like a request (a question mark, an imperative, second person) or carries a file, and does not start with an acknowledgement.
- **Tier 3, classify.** What the deterministic rules cannot settle: the name used mid-sentence or with a colon; a follow-up that failed the tier 2 test; and, at `contribute` only, a long top-level question. Tier 3 is where a classifier is asked. With no adapter it is only counted.
- Everything else is a tier 0 pass with the reason `no_band`.

#### Reading the counters

Phase 0 exists to answer one question before anything is switched on: how many messages would reach the classifier. Put a channel at `addressed` (then `contribute`) in `shadow`, let it run for a few busy days, and compare:

```promql
# share of the channel's observed messages that would reach tier 3
sum(increase(slaude_engage_total{tier="3"}[1d])) / sum(increase(slaude_engage_total[1d]))

# the same, split by what each rung would do
sum by (tier, outcome, level) (increase(slaude_engage_total[1d]))
```

Rough targets to check against, not measurements: at most about 5 percent of a channel's human messages reaching tier 3 at `addressed`, and about 15 percent at `contribute`. For a channel with 1,000 human messages a day that is on the order of 20 to 70 classifier calls at `addressed` and 400 to 600 at `contribute`. The counter has no channel label (the log line has), so use the `[engage]` lines to find which channel is noisy. A large `tier="2", outcome="run"` count says the agent would have answered follow-ups without being asked, which is the number to sanity-check by reading a sample of the log reasons.

#### The classifier is a seam, not a vendor

Tier 3 asks a classifier "run or pass". The classifier is a small interface (`classify(candidate)` returning `run` or `pass`) in front of the decision gate, and the gate in turn talks to a neutral decision adapter. Any adapter registered with the decision gate can serve it; engagement code names none, and a test fails if one is named outside that adapter's own file. The questions are written about "the agent", and an answer is a choice with a confidence, so changing the adapter is a registration and a config change, with no change to the tiers.

The adapter and its credentials are deployment configuration (`SLAUDE_DECISION_CONFIG`, with the key given by secret reference), never per channel and never in git. Per channel you choose only the level and the mode. With no adapter configured, tiers 0 to 2 still work (they need no model) and tier 3 is always a pass. A classifier failure of any kind (an error, a timeout, no adapter) is a pass, never a run: the gate's rules fallback is not used for an implicit decision, because it would read every candidate as a request.

#### What leaves the box

- **With no adapter, nothing.** No message text is sent anywhere, the log lines carry no text, and the last-speaker record holds only message ids, a persona name and a user id for the window's length.
- **With an adapter (phase 1)**, only tier 3 candidates and a small sample of tier 2 run decisions are sent, only for channels that opted in with a level above `mention` (a proactive channel counts, see the warning above): the candidate message and a capped, filtered slice of recent messages (at most 8 by default, each cut to 400 characters, secret-shaped text masked, a literal `<agent>` typed in chat defanged; authors the agent would not admit, ignored users and text the owner's inbound guardrails deny are left out), with the agent's name, aliases and every mention of its identities rewritten to `<agent>`, other people's mentions to `<user>`, and links reduced to their label or host. Text from other bots (CI output and other integrations) is never sent. No knowledge-base search is made, so no document score leaves either. Tier 0 and tier 1 messages are never sent. The channel's opt-in is what permits this; the adapter chosen is the operator's explicit decision.

#### Phase 1: the shadow classifier

When a decision adapter is configured, a channel above `mention` also asks it about the messages the rules could not settle, and records the answer. **It never acts**: the candidate is always handed over in shadow, whatever the channel's `mode`, so what the agent does is identical with or without it. The point is to measure how a classifier would have decided before anything is allowed to act on it.

What is asked, and when:

- **Tier 3 candidates** (the name used mid-sentence or with a colon, a colleague sharing the agent's name, a follow-up that failed the tier 2 test, and at `contribute` a long top-level question).
- **A sample of tier 2 run decisions**, to check the rules: 1 in 20 by default (`SLAUDE_ENGAGE_SAMPLE`, `0` turns it off), at most 5 a day per channel.
- **Never tier 0, and never tier 1.** A message the rules pass or run on their own never reaches the classifier.
- **At `addressed`** one question is asked (is the message said to the agent), at `contribute` the existing four. A decision needs a confident answer (the gate's `tAct`, default 0.8); anything less is a pass.

The call is made in the background after the message has been handled, with its own deadline, so it can never delay the agent or the handler, and a failure of any kind is a counted pass. A top-level question at `contribute` waits 60 seconds before it is asked, so a human answer can land first. Each candidate goes through these steps in order, and each can end it as a pass:

1. **One owner per persona.** With several apps in a channel every app's copy sees a message, but one copy of each persona wins an atomic claim on the channel, message and persona and makes the call; the others do nothing and count nothing. Two different personas on one message each have their own claim, pass memory and cooldown. (A tier 2 sample is drawn before the claim, so a miss never takes it.)
2. **No adapter.** A tier 3 candidate is a counted pass with reason `noadapter`, and nothing else is done: no input is built and no Slack history is read.
3. **Pass memory.** After a classifier "no", later unmentioned messages from the same author in that thread pass without a call, until the agent speaks in the thread, a new author joins, the name is used, or 30 minutes pass. A "no" on a top-level message cools the channel for the next 3 candidates or 120 seconds, unless the name is used.
4. **Circuit breaker.** Three consecutive failures (errors or timeouts) open it, with a doubling backoff from 30 seconds up to 10 minutes; then a single probe is let through. Per process. A late result from a call started before the breaker changed state is ignored, so five calls timing out together do not double the backoff.
5. **Admission, free of charge.** A message the agent would not hear (blocked or ignored author, a `/1on1` thread, a command) is a counted `input` pass before anything is spent or read.
6. **A top-level question waits.** At `contribute` it is held 60 seconds, then one bounded history page since the message is read: if a human other than the author answered (a thread reply or a later message) it is a pass with reason `answered`; if it was deleted or edited meanwhile, reason `stale`. The wait is a timer, cancelled when the gateway stops.
7. **Budget.** Per channel, across apps and replicas: a daily bucket (`SLAUDE_ENGAGE_DAILY_BUDGET`, default 50 calls) and a per-minute ceiling (`SLAUDE_ENGAGE_MINUTE_CEILING`, default 6). Over either is a pass with reason `budget`. With Redis the counts are shared by every replica; with none they are per process. If Redis fails the classifier fails closed (a pass) while the rest of the observation carries on.
8. **Input.** One Slack read at most, made only here, always a single page of at most 15 messages and never a loop: for a thread reply one `conversations.replies` call over the last 20 minutes (when the window holds more than 15 messages it is the earliest 15 of the window), for a top-level message one `conversations.history` call for the messages before it; under a 2 second deadline. Reads use the delivering app's no-retry client: a rate-limited or failed read is skipped (reason `input`, one log line with the error code), never retried. A message the agent would not hear (a blocked or ignored author, a `/1on1`-locked thread, or text an owner inbound rule denies) is never sent, and a message with no author is skipped. A failed or late read is a pass with reason `input`.
9. **Ask.** The adapter answers or it does not. A timeout or error is a pass (and counts against the breaker); only a confident model "yes" is a `run`.

A tier 3 reason that names the agent also ends the pass memory above, so a message that uses the agent's name is always asked about (budget permitting).

The result is one counter and one log line, neither with message text:

```
[gate] engage implicit=addressed tier=3 action=pass actual=pass reason=answer ms=412 key=C...:1731...
```

`action` is what the classifier would have done (`run` or `pass`); `actual=pass` is always true in phase 1. `sampled=1` is added for a tier 2 sample. The counter is `slaude_engage_classifier_total{result,reason,level}`, with `result` `run` or `pass` and `reason` one of `answer` (a model answered), `budget`, `breaker`, `timeout`, `error`, `noadapter`, `pass_memory`, `cooldown`, `input`, `answered` or `stale`. A shadow consult is counted only here; it does not move `slaude_gate_decisions_total` and prints no `[gate] mode=...` line. It has no channel label; the log line has. The decision adapter's request counter (`slaude_decision_requests_total`) still counts the call.

To read it: the share of `result="run"` among `reason="answer"` for tier 3 is how often a classifier would have joined in; read a sample of the log lines for the tier 2 samples to see where the rules and the classifier disagree. A rule the classifier keeps overturning is a rule to fix.

**A colleague who shares the agent's name.** "Sam, can you look" is a tier 1 run unless a person in the workspace goes by that name; then it goes to tier 3. The names come from one cached `users.list` read per workspace, refreshed at most hourly in the background: up to 5 pages, a 2 second deadline on each page and 5 seconds in all, deleted users and bots ignored, and the agent's own Slack users (its bot user and the registered persona users) left out, so a persona that posts as a real user still gets tier 1. If the read stops part way, what was read is kept and a name missing from it counts as shared (retried within 5 minutes); a failed refresh keeps the last list and logs one `[engage] users.list failed team=... code=<error code>` line per team per hour (a missing `users:read` scope shows as `missing_scope`). Until the first list arrives, or if it never does, the safe side applies: the name counts as shared, so `name_comma` is not taken and the message goes to tier 3 (a pass when there is no adapter). The list is workspace wide, not per channel, which only ever errs toward "someone shares the name".

**Humans alternating.** When a classifier input read a thread and two or more humans have taken turns since the agent last spoke, a short flag is kept for the thread; the next message's ladder reads it (so the "humans alternating" tier 2 pass can now fire). It is false whenever no thread was read.

#### Choosing the adapter

The adapter is deployment configuration, `SLAUDE_DECISION_CONFIG` (gateway only), one JSON object. The adapter is selected by the `type` key of its block. Phase 1 needs an adapter and does not need the gate on, so the usual setup keeps the mention-path gate off (`"gate": {"mode": "off"}`) and only configures an adapter:

```json
{
  "timeoutMs": 4000,
  "gate": { "mode": "off" },
  "adapter": { "type": "anthropic", "model": "claude-haiku-5-5" }
}
```

The `anthropic` adapter answers the questions with a small model on the gateway's own model provider, using the credentials the gateway already has (`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`, or the subscription OAuth token, against `ANTHROPIC_BASE_URL` or the public API). With no other setting it needs no new secret. If the gateway holds only a subscription OAuth token (the Messages API answers it with a 429), give the adapter its own key as a secret reference: `"apiKey": "env://PERSONA_DECISION_API_KEY"` in the adapter block, resolved at boot exactly like the `jev` adapter's and preferred over every provider variable; the key is sent as `x-api-key`. A literal key is refused and the value is never logged. `PERSONA_*` variables are gateway only (nodes refuse them, agent children never inherit them). `model` is optional (default `claude-haiku-5-5`) and the other keys allowed in its block are `type` and `apiKey`. If `ANTHROPIC_BASE_URL` points at a provider other than the public API, `model` is required: without it the adapter is disabled at boot with a warning naming `adapter.model`, because that provider may not serve the default id. It forces one tool call whose answers are limited to each question's options, treats anything else as an error, and sends the thread text to that provider, so it widens nothing beyond where the agent's own turns already go. `timeoutMs` bounds the whole decision; a small model needs more than the default 800 ms, so 4000 is recommended for this adapter. Other adapters are registered the same way and configured in the same block (see [Decision gate](../reference/configuration.md#decision-gate)). With `gate.mode` `shadow` or `on` the same adapter also serves the mention-path gate, as before.

#### Phase 2: acting (`mode: on`)

A channel whose `engage.mode` is `on`, at level `addressed` or `contribute`, and that is not restricted, now acts on a `run` decision: the agent takes part **exactly as if it had been @mentioned**, with these differences. In shadow, and at level `mention`, nothing changes.

> [!WARNING]
> **`on` makes the agent speak in that channel without anyone mentioning it.** Roll it out one channel at a time, in shadow first (below), and know the kill switch.

What acts, and how:

- **Tier 1 and tier 2 `run` act at once.** The agent's name and a comma ("Sam, can you look"), and a follow-up from the person the agent just answered.
- **Tier 3 is awaited.** The classifier is asked while the message is being handled, within the decision config's `timeoutMs`, and acts only on a confident yes. Every failure (error, timeout, budget, breaker, no adapter, a "no") is a pass, which is today's drop. A top-level question at `contribute` still waits 60 seconds first and then acts from the timer (never in a channel session, where the message has already been recorded by then). When the timer fires the router's checks run again (kill switch, mode, `/mention-only`, any session row for the thread, admission), and any reply in the thread during the wait counts as an answer.
- **Same checks as a mention.** The author goes through admission, blocked and ignored lists, restricted channels, `/1on1` locks and owner inbound rules exactly as an @mention from them would, and the model receives the same message text. A tier 3 candidate has already passed admission before any budget is spent; a tier 1 or 2 run is admitted before it acts. Budgets, pass memory, the root cooldown and the breaker from phase 1 all apply to tier 3 as before.
- **Where the reply goes.** A classic agent replies in the thread of the message (under it, for a top-level message). In a channel-session channel an unmentioned root message whose decision is `run` is not recorded suppressed: the agent replies at the root, as for a root mention there.
- **Tier 1 and 2 skip the mention-path gate consult on purpose.** The deterministic tiers run before any model, so an implicit run does not ask the decision gate again; access checks are the same as for a mention.
- **The first turn is told it may pass.** The turn's prompt says, in neutral words, that the message was not an @mention, may be addressed to someone else or need no reply, and that the agent should `pass` when it does not need it. It does not say why the agent was asked. An implicit turn is not forced to reply by the must-reply guard: ending without a reply or a pass call is a pass: the thread is given back, no checkmark is set, and no received reaction or thinking status is shown until the model speaks. A turn that fails before it speaks stays quiet in the thread (the failure is logged) and gives the engagement back.
- **Passing gives engagement back.** An implicit run is born with weaker engagement. If the agent then only passes, the thread goes back to how it was: the next plain reply is recorded or dropped, not run. If the agent replies, the thread is engaged like after a mention.
- **A new session starts inside an existing thread with the thread head** (section 1.6), once, on its first real turn.
- **One owner per message, per deployment.** Slack delivers a channel message to every app and persona in it. A copy that has decided `run` takes one atomic claim on the channel and message (`SET NX`, with an in-memory fallback), and only the winner acts; a copy that loses does nothing. A persona that spoke last in the thread already wins before the claim: another agent that spoke after you is a tier 0 pass for you. The claim lives in Redis when the deployment has one, else in the process, so it only spans one deployment: two separate single-persona deployments in one channel can both answer. Keep one deployment per channel at mode `on`.
- **A reply in a thread the agent opened** (the root's author is this agent: Slack's `parent_user_id` is this app's bot or this persona's own user) from a person, with no name used, no one else named and no recent record of the agent speaking last, is a tier 3 candidate instead of a drop. A root posted through a bot that several personas share cannot be told, and is refused as before. Slack does not send `parent_user_id` on every event; without it nothing changes. This candidate is read only in a channel whose mode is `on`; in shadow the ladder is as in phase 1.

Safety valves:

| Control | Default | Effect |
|---|---|---|
| `SLAUDE_ENGAGE_FORCE_SHADOW` | unset | Truthy (`1`, `true`, `yes`, `on`) forces every channel to shadow behaviour, whatever its mode. Read for every message, never cached, so unsetting it takes effect at once. This is the kill switch. |
| `SLAUDE_ENGAGE_ACT_PER_HOUR` | `12` | Acted runs per channel per hour (a fixed hour window, shared across apps and replicas with Redis). Past it a run is a pass. |
| The existing budgets | 50 a day, 6 a minute | Tier 3 classifier calls, as in phase 1. |

Counters and the log line (no channel label on the counter; the line has it, and neither carries message text):

```
slaude_engage_act_total{tier,outcome,level}
[engage] act channel=C... level=addressed tier=1 source=rules reason=name_comma ts=... persona=default site=drop
```

`outcome` is `acted`, `lost_claim` (another persona or app copy owns it), `cap`, `forced_shadow`, `classifier_pass` (a tier 3 candidate the classifier or its guards did not confirm) or `error`. `source` is `rules` or `classifier`; `site` is `drop` or `channel_session`.

**Rolling a channel out.** (1) Put the channel at `addressed` with `mode: shadow` and, if you want tier 3, a decision adapter. (2) Read `slaude_engage_total` and `slaude_engage_classifier_total` for a few days and the `[gate] engage` lines: the share of messages that reach tier 3, and how often the classifier would say run. (3) Switch that one channel to `mode: on`, tell the people in it, and watch `slaude_engage_act_total` and the thread behaviour. (4) Keep `SLAUDE_ENGAGE_FORCE_SHADOW=1` ready as the kill switch for the whole deployment, and lower `SLAUDE_ENGAGE_ACT_PER_HOUR` if a channel is chatty. Go to `contribute` only after `addressed` has behaved.

**What is not acted on.** The other places that drop or record a message for "not engaged" are different cases and are left alone: a thread a colleague mention has disengaged, a `/mention-only` thread, a thread that belongs to another app, and a message that mentions another person (all tier 0 passes anyway).

#### Not built yet

A per-channel label on the counter, and a deterministic last-speaker priority beyond what the ladder already does (a persona that spoke after another wins by the ladder; two personas that both decide run get the first claimant). Tuning the cap and budgets from real counts.

---

## 2. Channel controls and identity

The persona's `agent.yaml` declares who may talk to the agent and who is never heard. Section names below (`## Trusted channels`, `## Approvers` and so on) are the old SOUL.md headings; each is now a key under `access:` (`access.channels.trusted`, `access.approvers`, `access.blocked`, `access.dm`, `access.approvalTimeoutSeconds`, `mandate.scoped`), listed in the [reference](../reference/configuration.md#soul).

### 2.1 `allowedChannels` vs `trustedChannels`

Both grant the same engagement right: anyone in the channel can `@slaude` and be heard. The difference is the **trust hint** the agent receives.

| Field in SOUL.md | Who can chat | Trust hint to model | Typical use |
|---|---|---|---|
| `allowedChannels` | Everyone in listed channels | `allowed` — public interaction zone, be helpful but not exposed | Customer-facing or org-wide channels |
| `trustedChannels` | Everyone in listed channels | `trusted` — internal team channel, can share MCP lists, skill names, debug output | Team / BU / squad channel where the agent is a member |
| Neither (restricted) | Only manager / backup manager | `restricted` — DM-like, private 1:1 with operator | Sensitive or unlisted channels |
| DM (`im`) | `dmAllowedUsers` + managers | `restricted` | Direct messages |

The hint is injected as `<channel trust="…">` in the inbound envelope and repeated in the system prompt. The runtime baseline is explicit: never lower trust because a user in an `allowed` channel asked for internals.

> **Global allowlist note:** When you run with `SLAUDE_APPROVERS` set but no `## Approvers` in SOUL.md, that env list is the fallback allowlist (see section 3). Empty means any user may approve — useful only for solo workspaces.

### 2.2 `blockedUsers`

Listed in `SOUL.md` under `## Blocked users`. The gateway drops their messages before any other gate runs:

```ts
if (soul.blockedUsers.includes(userId)) return; // silent drop
```

No session is created, no suppressed turn is recorded.

### 2.3 Do / Don't

| Do | Don't |
|---|---|
| List team channels in `trustedChannels` so the agent can be candid | List a public support channel as `trusted` — internal dumps will leak |
| Add a noisy bot user to `blockedUsers` | Rely on `blockedUsers` for managers — `manager`/`backup` bypass it by design |
| Use `## Channel <#Cxxx>` overrides for per-channel mandate/approvers, and `## Scope` blocks for a channel class or DMs (see SOUL guide) | Duplicate `Cxxx` across both lists expecting a merge — a channel should live in one |

---

## 3. 1on1 mode, mention-only, and per-thread locks

These two per-thread switches sit on top of the global engagement gate.

### 3.1 `/1on1` — private lock

```
/1on1          → lock this thread to you (only you + manager are heard)
/1on1 lock     → re-restrict an opened thread back to initiator-only
/1on1 off      → release the lock (normal engagement resumes)
```

**How it works:**

1. You run `/1on1` inside a thread. The gateway writes `one_on_one_locks(channel, thread_ts, locked_user=you)`. The agent reloads its session under your OAuth config dir (per-initiator `CLAUDE_CONFIG_DIR` isolation) so MCP credentials are yours, not the agent's shared identity.
2. Any other non-manager user who speaks in the thread is silently dropped. Manager/backup are always exempt.
3. The initiator can later say *in natural language* "let someone else weigh in on this" — the model calls `open_1on1` (sets `open_scope` with a behavioural constraint) to invite guests under a scope. Guests can then speak, but the scope constrains what the agent does with their input. `/1on1 lock` clears `open_scope` and returns to initiator-only.
4. `/1on1 off` deletes the row.

**Asking to open to guests via `/1on1` is intentionally not a slash.** `/1on1` can only `on | lock | off`. Opening requires telling the agent directly so the scope is explicit.

**Transcript:**

```
you (thread root):  @slaude investigate the auth outage
slaude:             On it — checking logs…

you:  /1on1
slaude:             :lock: 1on1 mode — only you and managers may speak here.

jane: can I see the logs?        → dropped (not initiator, not manager)
you:  slaude, let jane weigh in — she owns auth
slaude:             :unlock: opened — guests may speak under scope: "jane owns auth, constrain advice to her input"
jane: the error is E-442         → handled (open_scope active)
you:  /1on1 lock
slaude:             :lock: re-locked — back to initiator-only.
you:  /1on1 off
slaude:             1on1 mode off — normal engagement resumes.
```

Related: `src/db/one-on-one.ts` (`one_on_one_locks` table, `open_scope` column).

### 3.2 `/mention-only` — opposite of sticky engagement

```
/mention-only       → only @mentions trigger replies in this thread
/mention-only off   → restore normal sticky engagement
```

When `mention_only_threads` has a row for the thread, a plain (non-@mention) message is **suppressed** if a session exists (recorded for later context) or **dropped** if no session exists. The gateway never auto-continues in this mode. This is the agent-facing twin of the same flag: the model can also call `mcp__slaude_surface__set_mention_only` to toggle it mid-conversation.

**When to use it:** A long-running thread where you want the agent to stay quiet unless explicitly called. Without it, every follow-up after the first `@slaude` would trigger the model.

| State | Plain message in thread | `@slaude` message |
|---|---|---|
| Normal (engaged) | Handled | Handled + (re-)engages |
| Disengaged | Suppressed (recorded) | Re-engages + handled |
| Mention-only ON | Suppressed / dropped | Handled (no sticky engage) |

---

## 4. Approval gate

Some actions should not happen without a human clicking yes. Slaude has two approval systems for two different risk levels.

| Gate | When | Who clicks | Tool |
|---|---|---|---|
| **Permission gate** | Per SDK tool call (Bash, Write, Edit, WebFetch, etc.) | The person whose message started the turn, the thread's `/1on1` lock owner, or an approver or manager of the persona (Allow / Always / Deny buttons). Anyone else gets an ephemeral refusal and the card stays pending. Turns with no single human sender (cron, heartbeat, console chat) need an approver or manager. | SDK `canUseTool` → Block Kit approval |
| **Approval gate** | Per *task* — agent-initiated before a destructive batch | Approvers from SOUL.md (Allowlist-resolved) | `mcp__slaude_slack__request_approval` → Block Kit Approve / Deny |

This section is about the second one.

### 4.1 The flow

**Step 1 — Agent decides it needs high-level approval:**

The system prompt tells the agent: if the turn could be destructive or out-of-mandate, call `mcp__slaude_slack__request_approval` with a short plan.

```ts
// what the agent calls (via MCP)
await mcp__slaude_slack__request_approval({
  summary: "Delete 400 stale `raw/` docs not referenced by any wiki page.",
  tools: ["Bash", "Write"],
  files: ["raw/2024-*.md"],
  risks: "Irreversible file deletion; 400 files affected",
  category: "destructive" // optional, for legacy category routing
});
```

**Step 2 — Gateway posts a Block Kit message in-thread:**

```text
:bell: *Approval needed* — `destructive`
Delete 400 stale `raw/` docs not referenced by any wiki page.

Tools: `Bash`, `Write`
Files: `raw/2024-*.md`
⚠️ Irreversible file deletion; 400 files affected
Approver(s): @manager @backup

[ Approve ]  [ Deny ]
```

**Step 3 — Human clicks.** The gateway validates the clicker against the resolved allowlist. If the clicker is not on the list, an ephemeral reply says they are not authorized and the request stays pending for someone who is. If authorized, the gateway replaces the block with `Plan → *Approved* by @manager` (or `*Denied*`) and resolves the MCP promise.

**Step 4 — Agent reads the JSON result and acts:**

```ts
// MCP returns { approved: true, by: "U0XXXXXXX" } or { approved: false, by: "U0XXXXXXX" }
if (!result.approved) {
  // do not proceed — propose an alternative or ask for clarification
}
```

The runtime baseline is explicit: the agent must trust only this JSON. Screenshots, text claims, or out-of-band "I approved it" are rejected.

### 4.2 Approver allowlist resolution

The agent **never picks user IDs**. The gateway resolves who may click:

1. **Structured SoulData** (LLM-extracted or cached): `selectApproversFrom(structuredApprovers, summary, category)` — keyword-matches `summary` against each approver's scope. If the summary matches "delete docs" and an approver's scope mentions "destructive file ops", that approver is selected.
2. **Regex-parsed scope approvers** (legacy SSO text): `selectApprovers(summary, category)` — same idea, regex over raw SOUL.md.
3. **Legacy `category: ids` map**: `approvers[category]` then `approvers.default`.
4. **Env fallback**: `SLAUDE_APPROVERS` (comma-separated `Uxxx` or `<@Uxxx>`).
5. **Empty set**: anyone may click (solo/DM workspaces).

That chain is the default persona's. A named persona's approvers are its users with the approver or manager role (soul-derived or granted in the console), with no keyword matching; with none, the default persona's managers. It never falls back to anyone.

Manager and backup are always retained as catchall approvers even when a `## Channel <#Cxxx>` override replaces the global approver list — there is no lockout.

### 4.3 Per-channel approver overrides

A `## Channel <#C12345>` block in SOUL.md can declare its own `Approvers:` and `Mandate:` that apply to messages in that channel. Approvers replace the global list; the mandate replaces, extends or reduces the global one by its `Mode:` line (see [Scoped mandates](../reference/configuration.md#scoped-mandates)). Inbound `effectiveSoulForChannel(channelId)` is used both for the agent's mandate and for approval-gate resolution, so a channel override can widen or narrow who may approve without redeploying the container. Edits take effect after `bun run validate-soul` re-extraction or on next boot.

### 4.4 Do / Don't

| Do | Don't |
|---|---|
| Write narrow approver scopes in SOUL.md ("may approve *deploy* plans") | Leave scopes broad ("can approve anything") — every destructive plan matches |
| Require `request_approval` when `bypass` mode is on (persona mandate forces it) | Call `request_approval` and also ask the user to paste a screenshot — trust only the JSON |
| Set `Approval timeout` in SOUL.md (e.g. `600`) so pending blocks auto-deny | Assume an unclicked approval waits forever (it might, if timeout is `0`) |

Timeout is configured in SOUL.md (`## Approval timeout — seconds`). When positive, the gateway posts `Auto-denies in 600s` and auto-resolves with `{ approved: false, by: "system", note: "timeout-600s" }` after expiry.

---

## 5. Slash commands

Slash commands give the **human in Slack** direct control that does not depend on the model interpreting intent. They are parsed before the message reaches the model.

### 5.1 Command table

All commands below work inside a thread (they resolve `channel` + `thread_ts` from the event). Commands marked *thread-only* fail gracefully outside a thread.

| Command | Summary | Who may run | Per-session effect |
|---|---|---|---|
| `/mode <name>` | Set tool-permission mode for this thread's session | Anyone in the thread | Persists to `sessions.permission_mode`; next boot uses it |
| `/mode` (no arg) | Show current mode + available modes | Anyone | Read-only |
| `/abort` `/stop` `/cancel` | Cancel the current model turn | Anyone in the thread | Calls `AbortController.abort()` — stream ends with `aborted` |
| `/1on1` `/1on1 lock` `/1on1 off` | 1on1 private lock (see section 3.1) | Anyone (initial lock) / manager enforces | Writes `one_on_one_locks` |
| `/mention-only` `/mention-only off` | Mention-only toggle (see section 3.2) | Anyone in the thread | Writes `mention_only_threads` |
| `/help` `/h` `/?` | Show help table + mode list | Anyone | None |
| `/ingest` | Manually trigger KB ingest (`raw/` → wiki → brain sync) | Manager / approver only | Background job; reacts with `hourglass` |
| `/mcp` `/mcp connect <server>` `/mcp disconnect <server>` | List / connect / disconnect OAuth MCP servers | Status: anyone; connect/disconnect: `/1on1` → initiator, else manager/backup | Writes per-user OAuth config |
| `/soul trust|allow|dm|block add|remove <id>` | Runtime ACL override (shadows SOUL.md without redeploy) | Manager / backup only | Writes `soul_overrides` |
| `/soul list` | Show runtime overrides vs SOUL.md base | Anyone | Read-only |
| `/soul clear <field|all>` | Drop runtime overrides, revert to SOUL.md | Manager / backup only | Deletes from `soul_overrides` |
| `/model` `/model <id>` | Show or switch this thread's model | Anyone may list; manager/approver may set | Persists to `sessions.model` |
| `/bash <command>` | Run a shell command on the server, output posted to the thread | Manager / backup manager only | `mono` only: runs with the agent child's environment scrub (no gateway-only variable). Refused on a gateway (`SLAUDE_ROLE=gateway`); run the command on a node instead |
| `/compact` | Summarize and compact conversation context | Anyone in the thread | Triggers pre-compact hook |
| `/ignore @user [dur]` | Ignore a user (optional duration `30m`, `1h`, `permanent`) | Manager / approver only | Writes `ignores` |
| `/ignore-thread [dur]` | Ignore this thread | Manager / approver only | Writes `ignores` |
| `/unignore @user` `/unignore-thread` | Remove an ignore | Manager / approver only | Deletes from `ignores` |
| `/cron-add "<expr>" "<prompt>" [channel] [passive]` | Schedule a recurring prompt | Manager / approver only | Writes `cron_jobs` |
| `/cron-list` `/cron ls` | List scheduled crons | Manager / approver only | Read-only |
| `/cron-edit <id> "<expr>" "<prompt>" [channel] [passive]` | Edit a cron's schedule/prompt/target | Manager / approver only | Updates `cron_jobs` |
| `/cron-pause <id>` `/cron-resume <id>` | Pause / resume a cron | Manager / approver only | Flips `paused` flag |
| `/cron-remove <id>` `/cron rm <id>` | Remove a cron (soft-delete) | Manager / approver only | Sets `active=0` |

The canonical list lives in `src/gateway/slack/commands.ts` (`AGENT_COMMANDS`). `/help` renders it — edit that array and every surface (Slack, sim REPL) picks it up.

### 5.2 `/mode` — per-session permission modes

Each session stores its own `permission_mode` in `sessions.permission_mode`. `/mode` switches it live.

**Supported names (aliases in parens):**

| You type | Stored as | Meaning |
|---|---|---|
| `ask` (`default`) | `default` | Prompt per tool via Block Kit Allow / Always / Deny |
| `accept-edits` (`edits`) | `acceptEdits` | Auto-allow Read / Write / Edit; still ask for Bash, WebFetch, etc. |
| `bypass` (`yolo`) | `bypassPermissions` | Every tool auto-allowed — persona mandate + approval gate are expected to gate risk instead |
| `plan` | `plan` | No execution — planning / read-only |
| `dont-ask` (`deny`) | `dontAsk` | Deny anything not pre-approved |

**How to use it:**

```
you:  /mode bypass
slaude: :gear: mode → *bypass (YOLO — every tool auto-allowed)* for this thread.
# every later turn in this thread starts with permissionMode=bypassPermissions
# until you switch again.

you:  /mode
slaude: Current mode: `bypass` — bypass (YOLO…)
      Available:
        • /mode ask — ask (default — prompt per tool)
        • /mode accept-edits — accept-edits (auto-allow Read/Write/Edit…)
        …
```

**Transcript example:**

```
you:  @slaude scaffold the new service        → session starts in default (ask)
slaude: [asks Allow for Write scaffold.ts]    [Allow] [Always] [Deny]

you:  /mode accept-edits
slaude: :gear: mode → accept-edits for this thread.

you:  keep going
slaude: [writes files without prompting for Write/Edit; asks for Bash]
```

Persistence: `Sessions.setPermissionMode(sessionId, mode)` on every `/mode`, and `AgentManager` reads `row.permission_mode` when booting the SDK `Options.permissionMode`. The SDK also respects `allowDangerouslySkipPermissions` when `bypassPermissions` is active.

> **Tip:** Set `SLAUDE_DEFAULT_MODE` in env to choose the initial mode for new threads. Docker compose defaults to `bypass`; local `.env.example` defaults to `ask`.

### 5.3 `/abort`, `/ingest`, `/help`

```
/abort          → aborts the live Query for this session (AbortController).
                  The stream emits type:"error" with "aborted"; the gateway
                  posts a :stop_sign: notice. Next message resumes normally.

/help           → prints AGENT_COMMANDS + the mode list. Same output in the
                  sim REPL — single source of truth.

/ingest         → manager/approver only. Starts a kb ingest job (Task 10).
                  Requires an active session (post one message first). The
                  gateway posts :hourglass: and schedules nightly maintenance.
```

### 5.4 How slash commands are dispatched

1. `gateway.ts` strips the bot mention (including persona mentions like `@Noah`) before parsing.
2. `parseSlashCommand(text)` tries `/mode`, then `/abort`, `/ingest`, `/ignore…`, `/cron…`, `/1on1`, `/mention-only`, `/soul`, `/mcp`, `/model`, `/bash`, `/compact`, `/help`. Returns `null` if no match — the message goes to engagement / model instead.
3. Each `kind` branches in the message handler, enforces auth (`isManagerOrApprover` where needed), touches the DB, and calls `reply()` without waking the model. `/bash` runs a scrubbed `bash -c` in the process (refused in the gateway role).
4. Unknown `/` commands are currently dropped (no help hint) — they do not reach the model.

---

## 6. Cron — scheduled prompts

Cron lets a manager schedule a prompt that fires on a cron expression and posts its result back to Slack.

### 6.1 Cron expression format

Standard 5-field UTC cron: `minute hour day-of-month month day-of-week`.

| Expression | Fires |
|---|---|
| `0 9 * * 1-5` | Weekdays at 09:00 UTC |
| `0 0 * * *` | Daily at midnight UTC |
| `*/30 * * * *` | Every 30 minutes |
| `0 9 1 * *` | First of every month at 09:00 UTC |

Parsing lives in `src/gateway/slack/cron-parser.ts` (`parseCron`, `getNextRun`). Search is capped at ~4 years to avoid infinite loops.

### 6.2 Two posting targets

```
# In a thread — post result in this thread:
you:  /cron-add "0 9 * * 1-5" "post standup summary for #platform" 
slaude: :alarm_clock: cron `a1b2c3d4` scheduled — next run: in 8 hours

# Broadcast to channel root instead:
you:  /cron-add "0 9 * * 1" "weekly platform health report" channel
slaude: :alarm_clock: cron `e5f6g7h8` scheduled (channel) — next run: in 6 days
```

`target` is `thread` (default, posts under the thread that created it) vs `channel` (posts at the channel root via synthetic `cron:<id>` thread). Channel jobs never bind a real thread, so their session key is always the internal cron id.

### 6.3 Passive vs fire

```
/cron-add "*/5 * * * *" "check for stale PRs" passive
```

`when_active="skip"` (opt-in via `passive` flag) defers that tick while a human is live in the target session (`AgentManager.isLive(sessionId)`). Default is `fire` — runs even while someone is chatting. The in-memory `#running` guard prevents same-job re-entry within a tick.

### 6.4 Lifecycle commands

```
/cron-list
# → :alarm_clock: *Scheduled crons* (3)
#   `a1b2c3d4` — `0 9 * * 1-5` — "post standup…" — next: in 8 hours — active
#   `e5f6g7h8` — `0 0 * * *` — "nightly ingest…" — paused

/cron-pause a1b2c3d4
# → :pause_button: cron `a1b2c3d4` paused

/cron-resume a1b2c3d4
# → :arrow_forward: cron `a1b2c3d4` resumed — next run: in 8 hours (recomputed)

/cron-edit a1b2c3d4 "0 10 * * 1-5" "new prompt" channel passive
# → reschedules + moves target + flips whenActive

/cron-remove a1b2c3d4
# → :wastebasket: cron `a1b2c3d4` removed (soft-delete, active=0)
```

Short 8-char prefixes are accepted where they unambiguously identify one job.

### 6.5 Scheduler internals (for operators)

- `CronScheduler` (`src/gateway/slack/cron-scheduler.ts`) polls `findDue(now)` every 60 seconds and on start.
- Each fire boots or resumes a session (`ensureSession(threadKey)`) and sends `envelope = "[scheduled] <prompt>\n\nReply with the result. This is a cron job."`
- Completion is tracked via `AgentManager` `event` (`done` / `error`); then `updateNextRun(id, getNextRun(expr), result)` is written.
- Missing legacy rows without `slackTeamId/slackChannelId` are skipped with `error: missing Slack keys`.
- Jobs created inside a `/1on1` carry `oauthUser` — the fire boots the child under that user's OAuth config dir (same isolation an interactive 1on1 session gets).

---

## 7. Attachments — both directions

### 7.1 Inbound: Slack → agent

When a user attaches files to a message, the gateway downloads them before forwarding the turn.

```ts
// gateway.ts → downloadAttachments(files, botToken, workingDir, inboundTs)
```

Files are streamed via `GET` on `url_private_download` with `Authorization: Bearer <bot_token>` and saved to:

```
$SLAUDE_HOME/workspaces/<sessionId>/attachments/<inbound_ts>/<safeName>
```

Non-deleted files from Slack Enterprise Grid with `url_private` fallback are also handled. Failures are logged (`[slack-attach]`) but do not drop the turn — the message proceeds with whatever subset downloaded successfully. The agent receives the download paths in the prompt and can `Read` them.

### 7.2 Outbound: agent → Slack

When the agent produces a file artifact, it must call `mcp__slaude_surface__upload` (not reply with a path or URL). The file appears in the same thread as an uploaded attachment, which survives expiring private URLs and renders in-thread.

```
agent:  [calls mcp__slaude_surface__upload { path: "/data/workspaces/<id>/report.csv", title: "Q2 report" }]
# → file appears in-thread as an uploaded attachment
```

**Where the file may be.** A regular file under the session's working directory, or under its per-session scratch directory. On a node the scratch directory is the agent's `$TMPDIR` (also `$SLAUDE_SCRATCH`): a private (0700) directory the node creates for the session and removes when the session is no longer warm on that node. It exists because the working directory is created by the gateway and may not be writable by the node's user. Files there last only while the session stays warm on its node: when the session goes cold (idle close, then a later resume) or moves to another node, they are gone, so upload before the turn ends. A worker that crashes leaves its scratch root behind; the next worker start removes `slaude-scratch-*` roots older than a day that it owns. If the node cannot create the directory (a read-only or full temp area) the session still starts, without `$TMPDIR` set for it, and uploads accept the working directory only; the node logs that once. The rest of `/tmp` is not allowed: it is shared by every session on the worker. Anything else is refused with the file's base name and a hint to copy it into one of those two places. This check prevents mistakes; it is not a security boundary against an agent that has a shell on the same node, which can already write to either place and read what its own user can read.

**How the bytes travel.**

- *Single process (mono), or an older node:* the gateway reads the file (confined to the session working directory, opened once and streamed from the checked descriptor) and uploads it with `files.uploadV2`, which holds the whole file in memory. `SLAUDE_UPLOAD_COLOCATED_MAX_BYTES` (default 100 MB) caps that path.
- *A node (gateway plus node):* the node opens the file once, takes its size from the open descriptor and asks the gateway for Slack's presigned upload URL (`upload_begin`). It sends the bytes straight to Slack, streamed, with no time limit but the turn's own stop, then checks Slack's answer (HTTP 200 and `OK - <size>`, with the size it declared). Only then does it ask the gateway to finish the upload (`upload_complete`). The gateway never reads a node path and never carries the bytes. `SLAUDE_UPLOAD_MAX_BYTES` (default 1 GB) caps the declared size.
- *A remote environment turn* (`/env`): refused before any file is looked at, because the file lives on the user's machine.
- *A new node against an older gateway* falls back to the path call once and logs it, so the file must then be visible to the gateway as before.

The caption (`initial_comment`) goes through the owner's reply rules exactly as before, at `upload_complete`: it can be redacted, refused, or held for an approval card, and a refused or denied caption means the file is not posted. The title, file name and alt text are not run through the reply rules (the same as a co-located upload); the file name is cleaned (base name only, control characters removed, length capped). A Slack upload that was started but never completed is never shown in a channel.

**Where the bytes go.** The gateway accepts only an https upload URL on `files.slack.com` (`SLAUDE_UPLOAD_ALLOWED_HOSTS` overrides the exact host list), and the node checks it again before sending a byte and never follows a redirect. When the console holds the session (an operator is driving it) a node upload is refused up front with "upload not sent", without a Slack call and without spending the per-session allowance, and counts as `suppressed`.

**Known limits.** A handle is valid for ten minutes for the session that asked: a handle from one turn of a session completes in another turn of the same session (and channel), always into the destination the begin turn had, and its issue time is not checked beyond that ten minutes. Completing the same handle twice posts the file twice; the older path-based upload has the same property and it is not guarded. The handle carries only the destination, the file id, the name and the declared size (alt text goes to Slack at begin).

The runtime baseline is explicit about this: pointers to local paths are useless to the user — the user cannot read the agent's filesystem.

---

## 8. Slack Agents API status

When the workspace's app manifest enables **Agents & AI Apps** (Assistant view) and the bot token carries `assistant:write`, slaude drives the animated status next to its name in a thread.

| Status text | When |
|---|---|
| `thinking…` | Model start, between tool batches |
| `running \`tool\`` or humanized status (e.g. "Searching the codebase…") | On `toolCall` events (via `humanizeToolStatus`) |
| `Task list` / `Todo list` rendering | When the agent drives `TaskCreate` / TodoWrite |
| Cleared (`""`) | On `done` / `error` / `aborted` |

Implementation is `src/gateway/slack/status.ts` → `client.assistant.threads.setStatus`. If the API returns `missing_scope`, `not_allowed_token_type`, or `not_in_assistant_thread`, status auto-disables and logs once so missing config is visible without spamming.

Suppressed (disengaged) turns set no status and never stamp a thinking indicator.

---

## 9. Idle TTL and resume

A session's SDK Query is not kept alive forever. After `SLAUDE_IDLE_MINUTES` (default `15`) with no new user message **and** no running turn, the gateway closes the prompt iterable and the Query exits cleanly.

```
Timeline (IDLE = 15 min):

t=0   @slaude hi                          → Query boots, permissionMode=default
t=1   … turn completes, session idle …    → #armIdle() re-arms 15-min timer
t=16  (no messages for 15 min)            → timer fires → iterable closed → SDK loop exits
                                            Sessions.status = "idle", #live entry dropped
t=25  you: still there?                   → Sessions.clearStarted? No — resume path:
                                            #startSession() boots new Query with { resume: <same-id> }
                                            Provider replays transcript; no history lost
t=25  slaude: Yes — still here…
```

**Key details:**

- `env.idleMs()` reads `SLAUDE_IDLE_MINUTES` and converts to milliseconds. Set `0` to disable (sessions live forever — not recommended for production).
- The timer is re-armed on every inbound user message (`handleMessage`) and on turn end (`#fanout` for `result`).
- Resume uses the provider-native transcript store keyed by `sessionId`. The local `sessions` row holds `claude_started` to track whether a transcript exists; on resume-miss (provider has no record — e.g. after swapping `ANTHROPIC_BASE_URL` across providers) the gateway clears `claude_started` and reboots without `resume`.
- `sessions` rows survive process restarts, so idle TTL is not the same as persistence — even a restarted gateway reuses the row id and resumes via the provider.

**Do / Don't:**

| Do | Don't |
|---|---|
| Leave idle at `15` for normal teams | Set `0` unless you know the container will not restart for days |
| Let the resume handle gaps — no need to `@slaude` again after idle | Assume resume lost history — the transcript is on the provider, not in RAM |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plain replies never reach the agent | Thread not engaged — no initial `@slaude` | `@slaude hey` once, then plain messages work |
| `@someone` did not disengage | Mention parse saw `<@Uxxx>` only; `@here` / `@channel` / email-style `@foo` are not user IDs | `@` the actual user — `<@Uxxx>` format is what the gate matches |
| After restart, plain replies broke again | `sessions.engaged` is `0` for that thread | `@slaude` once more to flip it to `1` |
| Approval button says "not on the approver allowlist" | Clicker not in resolved set (SOUL.md scopes / env) | Add them to `## Approvers` with a scope that matches the plan summary, or use `SLAUDE_APPROVERS` fallback |
| Approval block never appeared | `request_approval` not wired (missing `ApprovalGate` on transport) or `SOUL.md` has no approvers and `SLAUDE_APPROVERS` is empty | Check `SOUL.md` extraction (`bun run validate-soul`) and verify the ApprovalGate's `request` was awaited |
| `/mode` says "unknown mode" | Alias typo | `/mode` without args lists aliases; valid: `ask`, `accept-edits`, `bypass`/`yolo`, `plan`, `dont-ask` |
| `/ingest` says "Send a message first" | No session row yet for this thread | `@slaude hi` once, then `/ingest` |
| Cron never fires | Row missing `slackTeamId` (legacy job) or `paused=1` | `/cron-list` — look for `paused`; delete and re-add legacy jobs |
| Status never shows "thinking…" | App manifest missing **Agents & AI Apps** / Assistant view, or `assistant:write` not granted | Reinstall the app after regenerating `manifest.json` |
| Attachment not visible | Agent replied with a path instead of `upload` | Nudge the agent: "upload the file via mcp__slaude_slack__upload" |

---

## 11. Source map (where to read more)

| Area | Files |
|---|---|
| Engagement gate | `src/gateway/core/gateway.ts` (`engaged`, `persistEngaged`, `app_mention` + `message` handlers), `src/db/sessions.ts` |
| 1on1 lock | `src/db/one-on-one.ts`, `src/gateway/slack/commands.ts` (`/1on1`), `src/agent/manager.ts` (per-initiator `CLAUDE_CONFIG_DIR`) |
| Mention-only | `src/db/mention-only.ts`, `src/gateway/slack/commands.ts` |
| Channel controls | `src/soul/loader.ts`, `src/soul/extract.ts`, `src/db/soul-overrides.ts` |
| Approval gate | `src/gateway/slack/approval-gate.ts`, `src/soul/loader.ts` (`selectApprovers`, `effectiveSoulForChannel`) |
| Permission gate | `src/gateway/slack/permission-gate.ts` |
| Slash commands | `src/gateway/slack/commands.ts` (`AGENT_COMMANDS`, `parseSlashCommand`, `helpText`) |
| Cron | `src/gateway/slack/cron-parser.ts`, `src/gateway/slack/cron-scheduler.ts`, `src/db/cron-jobs.ts` |
| Attachments | `src/gateway/slack/attachments.ts`, `src/gateway/slack/surface.ts` (`upload`, `uploadBegin`, `uploadComplete`), `src/node/upload.ts`, `src/node/scratch.ts` |
| Status | `src/gateway/slack/status.ts`, `src/gateway/core/status-text.ts` |
| Idle TTL / resume | `src/config/env.ts` (`idleMs`), `src/agent/manager.ts` (`#armIdle`, `#startSession`, `resume`) |

Changes to engagement or approvals must preserve the two durable invariants: (1) `disengage → engaged=0` survives restarts, and (2) approval resolution never trusts user-supplied IDs — only the gateway's allowlist derived from SOUL.md / env.

# Channel session mode

Status: implemented.

## Goal

Let a channel have one dedicated, long-running session for an agent, as an
alternative to one session per root message and to agent-level proactive
wakes. The mode is optional per channel. A channel that does not choose it
behaves exactly as it does today.

## Today

| | Behavior |
|---|---|
| Root mention | New session keyed on the message `ts`, reply in a thread under it |
| Thread mention | One session per thread; follow-ups continue without a mention |
| Wake | One fresh session per agent per slot (`wake:<agent>:<slot>`), covering all its channels; continuity from a notes page and an activity block |
| `/1on1` | Locks one thread to one person |

## Decisions

| Topic | Decision |
|---|---|
| Unit | Per agent, per channel. Two agents in one channel each have their own session. |
| Root mention | Runs a turn in the channel session and replies at root. |
| Root message without a mention | Enters the session and the model does not run, the same way as a mention-only thread. |
| Threads | Unchanged. A mention engages a thread, follow-ups continue, replies under a wake's post get a session. |
| Thread context | A thread session gets no injected channel-session context. The agent can read the channel with its Slack tools. |
| Proactive | Per channel, on or off. When on, wakes run in the channel session. |
| Next wake | The agent proposes it with `finish_round`; code keeps it between one heartbeat slot and the maximum sleep. |
| Per-channel limits | None. `Highest`, `Cooldown` and `Max per day` do not apply in this mode. Operator-wide per-run caps and the daily pool stay as a safety floor. |
| Switch | Declared in the agent's definition, parsed by code, never by an LLM, never by a command. |
| Reset | `/new` at root, manager or that channel's approvers only. |

## Configuration

SOUL.md:

```
## Channel <#C…>
### Session
- Mode: channel
### Proactive
- Enabled: yes
```

`agent.yaml`, a new top-level key:

```yaml
channels:
  C0EXAMPLE:
    session: channel
    proactive: true
```

An absent `Mode` or `session` means today's behavior. An unknown SOUL value
leaves the channel on today's behavior and the soul check warns. An invalid
`agent.yaml` value fails the compile, like its other keys.

A `## Channel` block in an `agent.yaml` soul is prose only, so channel
proactive for those personas has to come through this key. The plan confirms
how the key reaches `proactiveFor` and `proactiveChannels`.

## Routing

In `channel` mode, for that agent:

| Root message | Result |
|---|---|
| Mentions this agent | Turn in the channel session, reply at root |
| Anything else, including mentions of other people or agents | Recorded, no model call |
| `/1on1`, `/env`, `/remote` | Refused: "start a thread for this". Each ties a session to one person. |
| `/mention-only`, `/ignore-thread` | Refused: they have no meaning at root |
| `/new` | Manager or approver: archives the session and the next message starts a new one. Anyone else: refused. |

Messages inside threads, and DMs, take today's path.

### Session key

The channel session uses a reserved thread value, `channel:<channelId>`, in the
existing `slack_thread_ts` column. There is still one row per team, channel,
thread and persona. `isSyntheticThread` learns the prefix, so the console labels
it by channel.

### The key stays out of the turn

The reserved key is used only to find or create the session. A root turn's
`threadTs` stays the triggering message's `ts`, as it is today, so reactions,
status, cards, error posts, lock lookups and the job token's `thread` claim all
keep a real Slack value without changing the code that computes them. Replies
reach root through the existing `postTarget: "channel"` seam. The job token
carries a new signed `post: "channel"` claim, because the `/v1` tool plane
rebuilds its context from the claims.

A wake has no triggering message, so it uses the reserved key as its thread,
as today's `wake:` and `cron:` keys do. A wake never posts to its thread.

### Delivery and de-duplication

Inbound events are claimed once by channel and `ts`, but with one app per agent
every app receives its own copy. A channel-session event is claimed per channel,
`ts` and persona, or only the first agent would record it. An unmentioned root
message is never parsed as a slash command.

### Cards

A permission or approval card for a root turn posts as a thread under the
message that triggered it, so root stays readable.

## Identity

A turn runs as a person only under a `/1on1` lock or a cron that captured its
initiator. Neither exists at root, so every root turn and wake runs as the
agent. No person's credentials are involved.

Known property: the agent's own tool results stay in the session and a later
speaker could ask about them. An unlocked thread has the same property today;
here it lasts longer. Sensitive work belongs in a `/1on1` thread.

## Recording

- Uses the existing suppress path: `handleMessage` with `suppress: true` and the
  `UserPromptSubmit` hook returning `continue: false`.
- Unlike a mention-only thread, the first root message creates the session.
  Recording starts when the mode is on. Older history is not backfilled.
- Attributed to sender and timestamp like a thread message.
- Existing ignore, block and redaction filters run first.
- Files are recorded by name, not downloaded.
- Recordings queue behind a running turn, in order.
- Accepted cost: each root message is a queued job, and a cold session starts in
  order to record it. A later turn pays for the backlog, and busy channels
  compact more often. Batching over a few seconds is the fix if starting cold
  proves heavy. It is not in the first version.

## Wakes

- A new `channel_wake_state` table, keyed on agent and channel, on both database
  schemas. `heartbeat_wake_state` stays as it is for the agent-level wake.
  Changing its primary key would need a table rebuild on sqlite for no benefit.
- A channel-mode channel leaves the agent-level wake, which keeps serving DMs
  and classic channels.
- A channel wake dispatches into the channel session as the agent, with the
  existing caps and daily pool.
- An agent runs one wake at a time across its channels, as it does today. A
  channel that is due while another wake runs goes at the next slot.
- A session boots either as a wake or as a normal session: caps and the wake's
  tool set are fixed when the query starts. The channel session therefore
  restarts on the same transcript when the kind of turn changes. It keeps the
  conversation and costs a process start.
- A wake is never merged with a person's message. A mention waits until the wake
  ends, and a wake waits until a running turn ends.
- A channel session works in its own folder under the agent's proactive folder,
  shared with the threads under that channel's wake posts, one turn at a time.
  The agent-wide folder would make a mention in one channel wait on work in
  another.
- The wake prompt drops the activity and notes blocks, because the session holds
  that history.
- Plain wake text stays silent. Only `proactive_post` reaches people, at root.
- Approval requests stay refused during a wake.
- A mention that arrives during a wake waits its turn.

## Switching mode

- On: existing threads keep working, under their own keys.
- Off: the channel session goes dormant. Root messages return to today's path.
- On again: the same session resumes. `/new` is the way to start clean.

## Failures

| Failure | Result |
|---|---|
| Recording fails | Logged and counted. That message is missing from the session; Slack tools can still read it. |
| Transcript lost on resume | Existing retry; the session starts empty. |
| Wake fails | Existing backoff, per channel, so one channel does not delay another. |
| No node with the capability | The turn fails visibly. It does not fall back to a thread, which would split the conversation. |

## Compatibility

No `Mode` means no change. Nodes advertise a new capability,
`channel-session/1`, and only capable nodes receive jobs on a channel session.
An older node would run a wake on a warm session with a person's tool set. A node
with this capability is newer than `guardrails/1` and `agent-definition/1`, so
one capability check is enough.

## Testing

- Unit: the routing function, including that a reserved key never reaches Slack.
- Simulated gateway: root, thread and wake flows in both modes, `/new` roles,
  refused commands at root.
- Schema-drift test for the migration.
- Ships as an RC, since it touches the database schema and the agent loop, then
  a real Slack smoke test with one channel flipped.

## Out of scope

- Backfilling channel history.
- Per-channel budgets or wake settings.
- Injecting channel-session context into threads.
- Changing DM or thread behavior.

## rc.14: proactive means a channel session

Date: 2026-11-10. Replaces the decisions above where they differ.

Proactive is now defined per channel, and turning it on means a channel session.

| Topic | Decision |
|---|---|
| Switch | `### Proactive` with `Enabled: yes` under a `## Channel` block makes that channel a channel session with wakes. No `### Session` is needed. The session is kept from then on. |
| `Mode: channel` | Stays, for a channel that wants the shared session without wakes. |
| Invalid `Mode` | Reads as off: no session, no wakes, whatever `Enabled` says. Warned. |
| `Enabled: no` with no `Mode` | An ordinary classic channel. |
| Agent-level wake | Removed. No code path starts a `wake:<agent>:<slot>` session. A global `## Proactive` `Enabled: yes` starts no wake and warns once per soul hash. |
| Summarising round | `runHeartbeat` and `Watch:` stay, as a round over watched sources only: no checklist. Its posts reach the manager and people who opted in. It no longer routes to a channel: every proactive channel is a channel session whose ceiling is `act`, and an item from a watched source is untrusted. |
| Checklist | Per channel, `self/heartbeat/<channel>` in the agent's slice, the channel id lowercased in one function (`channelChecklistSlug`) because gbrain stores slugs lowercased. The body goes into that channel's wake prompt as data inside a `<checklist>` block. The wake-due hash covers mandate plus page, so an edit wakes the channel. A page with no mandate is a job; neither is not. |
| Migration | At wake start, a proactive channel with no page of its own gets a copy of the old per-agent `self/heartbeat` page, when the agent has exactly one proactive channel, once (recorded in `background_slots`). The old page stays. With several channels nothing is copied and it warns once. |
| Timing | Unchanged: the heartbeat slot is the tick, `finish_round`'s `next_check_at` proposes the next look inside one slot and `SLAUDE_WAKE_MAX_SLEEP_HOURS`. |
| `/heartbeat now` | At a proactive channel's root, manager only: that channel's wake, now, past the gate. Busy (another wake, a person's turn) says so and marks nothing. Anywhere else it says where it works. |
| `/heartbeat status` | One line per proactive channel. No agent-level line. |

### What this removes

`runWake`, `wakeEligibility`, the `heartbeat-wake` prompt, the wake journal
(`self/wake-journal` is no longer written or read), the activity block and
`wake-activity.ts`. `heartbeat_wake_state` has no reader or writer now; the
table is left in place, unused, and no migration drops it. `deleteWakeSessionsBefore`
stays, so old `wake:` rows still age out.

### What upgrading changes

Every channel with `Enabled: yes` becomes a channel session on upgrade: root
mentions reply at root and root messages are recorded. A channel's `Highest`,
`Cooldown` and `Max per day` have no effect in a channel session; the soul check
warns for each such channel that lost them this way. A proactive channel needs
nodes with `channel-session/1`, so a node on an older version cannot take its
jobs.

## Voice

A wake never waits for a voice call: a wake on a session in a call is refused at once and its run closes. Channel sessions host no voice calls; a voice call runs in a thread.

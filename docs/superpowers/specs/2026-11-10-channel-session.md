# Channel session mode

Status: proposed.

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

### One function for the thread key

`event.thread_ts || eventTs` is computed in nine places in `gateway.ts`. All of
them move to one function that returns the session key and the post target.
The reserved key must never reach Slack as a `thread_ts`. Replies use the
existing `postTarget: "channel"` seam, which drops the thread reference.

Reactions, status and cards anchor on the triggering message, never on the
session key.

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

- `heartbeat_wake_state` moves from per agent to per agent and channel, through
  a migration on both database schemas. Agent-level rows keep working for the
  agent-level wake.
- A channel-mode channel leaves the agent-level wake, which keeps serving DMs
  and classic channels.
- A channel wake dispatches into the channel session as the agent, with the
  existing caps and daily pool.
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

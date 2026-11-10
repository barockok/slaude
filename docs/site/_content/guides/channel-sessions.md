# Channel Sessions

A channel session gives one agent one long-lived session for one channel. Normally each root mention starts a new session and a thread under it. In a channel session, root mentions reply at root in the same conversation, and the agent reads along with everything said at root, so a mention can build on what the channel has been talking about. Threads and DMs do not change.

Use it for a channel where the context builds up over days: a release channel, an incident channel, a team's daily channel. Keep the default for a channel where each question stands alone, because the shared session costs more (see [What it costs](#7-what-it-costs)).

> **Prerequisites:** You have a persona with a `SOUL.md` or `agent.yaml`, and the agent is in the channel. On a multi-node deployment, every node that can receive the channel's jobs must be on a version that advertises `channel-session/1` (see [Node version](#10-node-version)).

---

## 1. Turn it on

It is a per-agent, per-channel setting, declared in the agent's definition. No command turns it on, and nothing is inferred by a model.

There are two ways on:

**A channel where the agent works on its own (wakes included).** Turning on proactive makes it a channel session:

```markdown
## Channel <#C0EXAMPLE>
### Proactive
- Enabled: yes
```

In `agent.yaml`:

```yaml
channels:
  C0EXAMPLE:
    proactive: true
```

**A channel that only wants the shared session, no wakes.**

```markdown
## Channel <#C0EXAMPLE>
### Session
- Mode: channel
```

In `agent.yaml`:

```yaml
channels:
  C0EXAMPLE:
    session: channel
```

`Enabled: no` with no `Mode` is an ordinary channel. An unknown `Mode` in a soul reads as off for that channel, whatever `Enabled` says: no channel session and no wakes, and a warning is logged. An invalid value in `agent.yaml` fails the compile.

`## Proactive` at the top level is not about a channel. `Enabled: yes` there starts no wake and warns once; it only keeps the summarising round going, which reads the sources under `Watch:` and reports to the manager. `Watch:` without it reads nothing and logs a warning.

Two agents in one channel each have their own session and each records the channel for itself.

## 2. What happens at root

| Root message | Result |
|---|---|
| Mentions this agent | A turn in the channel session; the reply is posted at root |
| Anything else, including mentions of other people or agents | Recorded in the session; the model does not run |
| `/new` from the manager or one of this channel's approvers | Archives the session; the next message starts a new one |

Recording starts when the mode is on. Older history is not backfilled. A recorded message carries its sender and timestamp, the same as a message in a thread, and the usual ignore, block and redaction filters run first. Files are recorded by name and are not downloaded.

Permission and approval cards for a root turn appear in a thread under the message that triggered them, so root stays readable.

## 3. Threads

Threads work as they always have. A mention in a thread starts or continues that thread's own session, and replies under a post the agent made during a wake get a session too. A thread session gets no channel-session context injected; if it needs the channel's history, the agent reads it with its Slack tools.

DMs are unchanged.

## 4. Proactive

With `### Proactive` and `Enabled: yes` on a channel, the agent wakes in that channel's session. A wake needs a manager, and a mandate or a checklist page: a persona with no manager does not wake, and a channel with neither is skipped. It already holds the channel's history, so a wake reads no activity or notes block. It picks its own next look when it ends with `finish_round`; the runtime keeps that time between one heartbeat slot and the maximum sleep (default 4 hours if it says nothing).

Each proactive channel has its own checklist page in the agent's memory, `self/heartbeat/<channel id in lowercase>`. The agent keeps it itself. Its text reaches the channel's wake prompt inside a `<checklist>` block, marked as data, and editing it wakes the channel, as a changed mandate does. An agent with the old single `self/heartbeat` page and exactly one proactive channel gets that page copied to the channel's page once, at its first wake, and the old page stays. With more than one proactive channel nothing is copied and it warns once in the logs; the agent writes each channel's page itself.

`/heartbeat now`, from the manager at a proactive channel's root, runs that channel's wake at once, outside the slot. If the channel or the agent is busy with another wake or someone's turn it says so, plainly, and does nothing. Anywhere else (a thread, a DM, a channel that is not proactive) it says where it works. `/heartbeat status` lists one line per proactive channel.

Plain text from a wake stays silent. A wake reaches people with `proactive_post`, which posts at root, and with `post_message` for a follow-up in a thread of a post it made in that channel. It cannot `post_message` to another channel. Approval requests are refused during a wake, because nobody is in the turn to answer them.

A wake uses its own tools only under the `bypass` permission mode (`SLAUDE_DEFAULT_MODE=bypass`). The runtime denies every permission request during a wake, since nobody is there to approve one, so in any other mode a tool that would prompt is refused.

A wake and a person's turn never share a turn. A mention that arrives during a wake waits for it to end, and a wake waits for a running turn. An agent runs one wake at a time across its channels; a channel that is due while another wake runs goes at the next slot.

`Highest`, `Cooldown` and `Max per day` do not apply to a channel in this mode. The operator-wide per-run caps and the daily pool still do. A wake has no per-channel limits, so write what the agent may do in the mandate.

## 5. Starting over with `/new`

`/new` at root, from the manager or one of that channel's approvers, retires the channel session. The next root message starts a new one that remembers nothing of the old conversation. Anyone else is refused, and so is `/new` when the channel has no session yet. Those refusals are shown only to the person who tried it (see section 6); the confirmation that the session was reset stays a normal message, so the channel sees it.

The old session stays in the console, labelled archived, and it is read-only: a console chat into it is refused. Inside a thread, or in a channel without a channel session, `/new` is not a command: it reaches the agent as ordinary text, or a skill named `new`, as any other message would.

## 6. Refused commands and voice

Some commands make no sense for a whole channel, so they are refused at root:

| Command at root | Result |
|---|---|
| `/1on1`, `/env`, `/remote` | Refused: start a thread for this. Each ties a session to one person. |
| `/mention-only`, `/ignore-thread` | Refused: they have no meaning at root. |

`/mode` at root needs a manager or one of this channel's approvers, because it applies to every later speaker and wake in the channel. Anyone else is refused. In a thread, a DM or a channel without a channel session it works as it always has.

At root, a command the sender is not allowed or not able to run is answered with an ephemeral message: only the person who sent the command sees it, nobody else in the channel does. Like any ephemeral message it disappears when Slack clears it, it is not kept in the channel history, and it is shown again each time the command is retried.

These are private:

- The refused commands above (`/1on1`, `/env`, `/remote`, `/mention-only`, `/ignore-thread`, `/unignore-thread`).
- The `/mode` refusal for someone who is not a manager or approver, and the `/new` refusals (not allowed, or no session to start over yet).
- `/compact` while a wake is running ("I'm busy, try again shortly").
- `/heartbeat now` and `/heartbeat` status when the sender is not the manager, when the channel is not proactive, when the channel is busy, or when the wake did not start.
- Other commands the sender may not run: `/soul`, ignoring or unignoring a user, the cron commands, `/model`, `/bash`, `/mcp` global connect, and a cron change the manager denied. Also private are `/link` when the surface cannot reply privately, and `/mcp` when it cannot be used yet.

These stay public: everything that succeeds (including the `/new` confirmation, so the channel sees the session was reset, and "On it." for `/heartbeat now`), command output such as `/help`, and results or input errors such as "cron job not found", an invalid cron expression or an unknown MCP server. Refusals in a thread, a DM or a channel without a channel session are public, as before.

When Slack cannot show the message privately, nothing is posted publicly. This happens when the agent posts as a user, when the sender is outside the workspace (Slack Connect), when the sender is not in the channel, or when the permission is missing. The person sees an x reaction on their message instead, and the failure is logged and counted.

Voice calls run in a thread. A channel session does not host one.

## 7. What it costs

Recording is cheap per message, but a channel session is not free.

- Each root message, mentioned or not, is a queued job, and a session that has gone idle starts its process to record one.
- Recording does not call the model, so the next turn pays for the backlog: everything said since the last turn is in the prompt.
- A busy channel fills the context window sooner and compacts more often.
- Each wake resumes the whole session. As the channel's history grows, wakes get more expensive.
- A wake that hits its per-run budget backs off, like any failed wake. After repeated budget stops in a row the manager is told, once, that the channel's session may be too large for the per-run cap, and that `/new` starts it over.

The budget cap on a wake counts only that wake: a resumed process starts its spend at zero, so a channel's lifetime spend does not count against it.

If a channel is mostly noise, this mode is the wrong fit. Keep the default and mention the agent when you need it.

## 8. Sensitive work belongs in a thread

Every root turn and wake runs as the agent, so no person's credentials are involved. But the agent's own tool results stay in the shared session, and a later speaker in the channel could ask about them. Do sensitive work in a `/1on1` thread, where the session belongs to one person.

## 9. Switching the mode

- **On:** existing threads keep working under their own keys.
- **Off:** set `Mode` absent and `Enabled: no`, or remove the block. The channel session goes dormant. Root messages return to today's path, and the session is not deleted.
- **On again:** the same session resumes. Use `/new` to start clean instead.

## 10. Node version

On a multi-node deployment, a job on a channel session goes only to nodes that advertise `channel-session/1`. If none is available, the turn fails visibly instead of falling back to a thread, which would split the conversation. Upgrade every node before you turn the mode on for a channel.

## See also

- [Engagement and approvals](engagement.md): the mention model, `/1on1`, slash commands.
- [Configuration](../reference/configuration.md): the persona schema, wake settings and budgets.

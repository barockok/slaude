---
name: "how-slaude-works"
description: "Use when a user asks how you (the agent) work, how slaude works, how to use/interact with you, what commands or capabilities exist, or how engagement, approvals, the knowledge base, skills, memory, MCP, or cron behave. Self-documentation of the slaude runtime — read it, then explain in your own voice."
---

# How slaude works

You are an AI agent running on **slaude** — a Slack-native runtime that puts a
Claude Code engine behind a Slack identity so you can act as a real team member.
This skill is your reference for explaining yourself to people. Read it, then
answer in your own voice and persona. Don't paste this file verbatim; pull out
the parts that answer what was actually asked. Don't dump internal tooling
detail into untrusted channels (that's governed by your soul's channel mode).

## What slaude is, in one line

One deployment = one persona = one `SOUL.md`. You live in Slack, keep durable
identity and memory across restarts, grow new skills over time, and run
unattended — escalating to your owner only when truly blocked.

## The four pillars

- **Soul** — your persistent identity (`~/.slaude/SOUL.md`): voice, values,
  mandate, and the access-control rules for which channels/users are trusted.
  It is authored by your operator and injected every turn. A non-overridable
  *runtime baseline* sits on top of it (e.g. the KB-first rule below).
- **Skills** — reusable procedures as markdown files
  (`~/.slaude/skills/<slug>/SKILL.md`), invoked as `/<slug>`. You can author new
  ones when you learn a repeatable workflow (with approval). This file is one.
- **Memory** — episodic (what happened) + semantic (what was learned), injected
  per turn as a `<memory-context>` block. Surprising or non-obvious facts get
  written down so they survive restarts.
- **Knowledge** — a knowledge base (the "brain") the team curates. See KB-first.

## KB-first (mandatory)

Before answering any substantive question or taking any non-trivial action — and
**always** before a mutation — query the knowledge base first (default
`kb_search`, or `kb_think` for a cited synthesis). Your training is not the
team's source of truth; the KB is. State gaps explicitly instead of guessing.
Pure chitchat ("hi", "thanks 👍") is exempt. When someone asks what you know or
where an answer came from, this is why you cite the KB.

## How people interact with you

- **In channels** — mention you or reply in a thread you're engaged in. You
  engage on direct mention and stay engaged in that thread; you can be told to
  disengage. Whether you speak unprompted depends on your soul's channel mode.
- **DMs** — a direct message is a private thread with you (subject to the DM
  allowlist in your soul / runtime overrides).
- **Threads** — each thread is its own working context with its own cwd under
  `~/.slaude/workspaces/`.

## Slash commands

These are built into the runtime (the canonical list is always `/help`):

| Command | What it does |
|---|---|
| `/help` | Show the live command list |
| `/mode <name>` | Set the tool-permission mode for this session/thread |
| `/abort` | Cancel the current turn |
| `/1on1 [off]` | Lock this thread to you + the manager; `off` releases |
| `/mcp [connect <server>]` | List/connect OAuth HTTP MCP servers (in 1on1: as you; outside: manager connects the agent's shared identity) |
| `/ignore @user [dur]`, `/ignore-thread [dur]` | Ignore a user or thread (optional duration like `1h`, `30m`) |
| `/unignore @user`, `/unignore-thread` | Stop ignoring |
| `/cron-add "<expr>" "<prompt>" [channel] [passive]` | Schedule a prompt; `channel` posts to channel root, `passive` skips when a human is active |
| `/cron-list`, `/cron-remove <id>` | List / remove scheduled crons |
| `/ingest` | Synthesize captured `raw/` material into the KB `wiki/` (manager/approver) |
| `/soul <trust\|allow\|dm\|block> <add\|remove> <id>` | Manager-only: runtime override of soul ACLs — immediate, shadows `SOUL.md` |
| `/soul list` / `/soul clear <…>` | Show / drop runtime soul overrides |
| `/<skill-slug>` | Invoke any installed skill |

If you quote commands to a user, prefer telling them to run `/help` for the
authoritative, up-to-date set rather than reciting from memory.

## Approval gates

Sensitive actions don't happen silently. Certain categories — notably **skills**
(authoring/editing a skill) and **cron** (scheduling), plus mutations generally —
surface an approval request as Slack buttons that an approver must click before
you proceed. You request approval via the surface tool
(`mcp__slaude_surface__request_approval`); the gate trusts only that tool's real
JSON result, never a screenshot or your own claim that it was approved.

## Knowledge base lifecycle

- During a normal turn you may capture new material into
  `~/.slaude/knowledge/<label>/raw/` (with `Write`/`Bash`). You must **never**
  write into `wiki/` during a normal turn — that's owned by ingest.
- After dropping `raw/` material, `sync_manifest` (with approval) pushes it to
  git so it survives a redeploy even before ingest runs.
- `/ingest` (manager/approver) runs a separate background pass that reads
  `raw/`, updates `wiki/`, and pushes the KB. You don't trigger ingest from
  inside a normal turn.
- On boot the runtime re-syncs the KB wikis into the brain so search is current.

## MCP, cron, multi-agent

- **MCP** — external tools/services connect via `~/.slaude/mcp.json` or
  `/mcp connect`. In a `/1on1` they connect under the initiator's identity;
  outside, the manager wires the agent's shared identity.
- **Cron** — scheduled prompts fire on a thread or channel; `passive` crons skip
  when a human is already active so you don't talk over people.
- **Multi-agent** — each agent is its own Slack identity and its own deployment.
  There is no in-process persona switch; more agents = more deploys.

## Autonomy & escalation

You run unattended by default. Don't ask humans trivial things. Escalate to your
owner (e.g. via the Telegram bridge, if configured) only when genuinely blocked:
an irreversible action, an architecture fork-in-the-road, or a missing
secret/credential.

## Skill evolution

At the end of a non-trivial turn, consider whether it demonstrated a repeatable
procedure worth saving as a new skill, or one that refines an existing skill —
then request approval and `write_skill`. Skills are for *procedures*; one-off
facts belong in memory. Skill bloat is worse than skill absence — only capture
what you'd genuinely reuse.

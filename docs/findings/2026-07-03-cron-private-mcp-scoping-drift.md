# Cron private-MCP credential scoping is decoupled from `oauth_user`

## Context

Cron jobs carry an `oauth_user` column (the `/1on1` lock owner at creation time,
captured so a scheduled run can reconstruct the initiator's OAuth identity —
see [2026-07-03-cron-oauth-user-null-fallback.md](2026-07-03-cron-oauth-user-null-fallback.md)
and [2026-07-03-cron-private-mcp-no-oauth.md](2026-07-03-cron-private-mcp-no-oauth.md)).
That mechanism only covers `CLAUDE_CONFIG_DIR` isolation (per-user OAuth token
stores under `$SLAUDE_HOME/oauth/<userId>`).

There is a second, separate credential-scoping mechanism: whitelisted
`privateServices` entries in `~/.slaude/.mcp.json` get their embedded
credentials stripped (mounted anonymous) when the session's thread is
`/1on1`-locked, so a locked session runs those servers "as the initiator"
instead of as the agent. This is gated in `mcpResolver`
([src/gateway/core/gateway.ts:334-335](src/gateway/core/gateway.ts#L334-L335)):

```ts
const oneOnOneLock = OneOnOne.find(route.ctx.channel, route.ctx.threadTs);
Object.assign(servers, privateOverrides(externalMcp.servers, privateServiceSet, !!oneOnOneLock));
```

## The bug

This lock lookup is re-derived fresh, per session build, from the **live**
`OneOnOne.find(channel, threadTs)` against whatever thread key the session
currently has — it never consults `job.oauthUser` (the value
`CronScheduler` already resolved and handed to `setCronOAuthUser` for the
config-dir path, [src/gateway/slack/cron-scheduler.ts:76](src/gateway/slack/cron-scheduler.ts#L76)).
The two mechanisms are wired to different keys and drift apart:

- **Channel-target jobs.** Session key is always the synthetic `cron:<id>`
  ([cron-scheduler.ts:62-63](src/gateway/slack/cron-scheduler.ts#L62-L63)).
  `OneOnOne.find` can never match a synthetic thread id — no `/1on1` lock
  row is ever keyed on it — so `oneOnOneLock` is always falsy, every run,
  regardless of `job.oauthUser`. `privateOverrides` therefore always
  returns `{}`, and every whitelisted `privateServices` entry mounts with
  its **real embedded credentials** for every channel-target cron job, full
  stop. There is no code path by which a channel-target job's private MCP
  access can ever be scoped down — it always runs as the agent's standing
  identity.
- **Thread-target jobs.** Session key is the real `slackThreadTs`
  ([cron-scheduler.ts:63](src/gateway/slack/cron-scheduler.ts#L63)). Here
  `oneOnOneLock` reflects whatever lock state that thread happens to hold
  **at execution time**, held by **whoever currently owns it** — not the
  user captured in `job.oauthUser` at creation time. A job created while
  the thread was locked to user A, then run after the lock was released or
  handed to user B, silently picks up B's (or nobody's) privacy scoping
  instead of A's.

Net effect: a scheduled job's access to whitelisted private/workbench MCP
servers is not actually a function of who scheduled it or what identity it
claims to run as — it's a function of the thread-key plumbing accidentally
sharing (or failing to share) a lock lookup that was designed for
interactive sessions, not cron re-entry.

## Why this matters

The `privateServices` whitelist exists specifically so a real API
key/token embedded in `.mcp.json` isn't handed to arbitrary unlocked
sessions. Cron jobs are, by construction, unlocked-thread re-entries
(`cron:<id>` has no lock) or thread re-entries whose lock state has moved
on since scheduling. So the anonymization this whitelist is supposed to
provide silently doesn't apply to the cron path in the case that matters
most (channel-target jobs), and applies inconsistently in the other
(thread-target jobs).

## Fix direction (not yet applied)

`mcpResolver`'s private-service gating needs to consult the same resolved
cron identity the config-dir path already computes
(`job.oauthUser` / `AgentManager#cronOAuthUser`,
[src/agent/manager.ts:169](src/agent/manager.ts#L169) /
[src/agent/manager.ts:400-402](src/agent/manager.ts#L400-L402)) instead of
re-deriving lock state from `OneOnOne.find(route.ctx.channel,
route.ctx.threadTs)`. Both mechanisms should key off one resolved
"effective session identity" (locked user, cron initiator, or none) rather
than two independent lookups that happen to agree only by coincidence for
ordinary interactive threads.

---

_Captured 2026-07-03. No code changed — findings only, per explicit
instruction not to patch._

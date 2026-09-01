# Private Services in /1on1 — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorm)

## Problem

External MCP servers (e.g. `composio`, `workbench`) configured in `~/.slaude/.mcp.json`
run with the **agent's** OAuth baked into env/headers at load time. Every session — public
channel or private 1-on-1 — acts under that single shared agent identity.

In a `/1on1` thread the user expects a *private* session: actions on whitelisted services
should run as **the initiator's own identity**, not the agent's. The agent's shared identity
must stay available everywhere else (other threads, other sessions) unchanged.

## Goal

When a thread enters `/1on1` mode, whitelisted ("private") external MCP servers are mounted
**fresh — agent credentials stripped** — so they boot anonymous and prompt the initiator to
authenticate when first used. Outside 1on1, those same servers keep running under the agent's
identity. Opt-in per service via a config whitelist.

## Non-Goals

- No new prompt/auth UI. We rely on each private service's **native** interactive auth (it
  returns an auth URL when it lacks credentials; the agent relays it via `reply`).
- No per-tool identity split. Clearing is **whole-server**.
- No connect-broker generalization. Private services are raw `.mcp.json` servers, not broker
  proxies. (The broker remains for the per-user `jira`-style flow; untouched here.)
- No per-env-key clearing. The whole `env`/`headers` block is cleared (see Contract).

## Mechanism

### Trigger — `/1on1` reloads the session

In `gateway.ts`, the `one-on-one` slash handler:

- `action === "on"`: after `OneOnOne.lock(...)`, call `route.ctx.reloadSession()`.
- `action === "off"`: after `OneOnOne.unlock(...)`, call `route.ctx.reloadSession()` (restore
  agent-cred mounts).

`reload()` closes the SDK iterable; the **next** turn in the thread reboots the session, which
re-runs the `mcpResolver`. Clearing therefore applies from the next turn — not mid-turn, so no
in-flight tool call is interrupted. The `/1on1` lock message itself runs no agent tools, so
there is no leak window in practice.

`reloadSession` is already wired on the SlackContext (`gateway.ts:184`, `:722`, `:739` →
`agent.reload(sessionId)`); the handler just calls the existing thunk.

### Resolver — clear whitelisted servers when the thread is locked

The `mcpResolver` (`gateway.ts:228`) runs once per session boot. After building `servers`,
look up the lock and replace whitelisted mounts with cleared copies:

```ts
const lock = OneOnOne.find(route.ctx.channel, route.ctx.threadTs);
const isLocked = !!lock;
for (const name of Object.keys(externalMcp)) {
  servers[name] = isLocked && privateServices.has(name)
    ? clearCredentials(externalMcp[name])
    : externalMcp[name];
}
```

`externalMcp` (agent creds) is **never mutated** — `clearCredentials` returns a copy. Other
sessions resolving concurrently keep the agent identity.

**Boot-already-locked is free.** The resolver checks the lock on *every* boot, so a session
that starts inside a locked thread is cleared with no special-casing. This satisfies "if a
session starts in /1on1 mode, make sure the mcp is cleared."

### `clearCredentials(cfg)`

Pure function. Returns a shallow copy of an `McpServerConfig` with secrets removed:

- `env` → `{}`
- `headers` → `{}`
- `url` → userinfo and query string stripped (`https://user:pass@host/p?token=x` →
  `https://host/p`); host/path preserved so the server still reaches its endpoint.
- `command` / `args` preserved unchanged.

The server boots anonymous. It cannot act as the agent.

## Config

`privateServices` is a top-level array in `~/.slaude/.mcp.json`, sibling of `mcpServers`:

```json
{
  "mcpServers": {
    "composio":  { "url": "https://...", "headers": { "Authorization": "Bearer ${COMPOSIO_KEY}" } },
    "workbench": { "command": "npx", "args": ["..."], "env": { "WB_TOKEN": "${WB_TOKEN}" } }
  },
  "privateServices": ["composio", "workbench"]
}
```

`loadExternalMcp()` already parses this file. Extend it to return both the servers map and
`parsed.privateServices` (string array; default `[]`). Names not present in `mcpServers` are
logged with a warn and ignored. Plugin `.mcp.json` servers are **not** eligible — only
top-level externals carry agent OAuth.

`loadExternalMcp` currently returns `Record<string, McpServerConfig>`. Change it to return
`{ servers: Record<string, McpServerConfig>; privateServices: string[] }`; update the single
call site in `gateway.ts:214`.

## Contract (documented loudly)

A service on the whitelist **MUST** support anonymous start + interactive auth. Stripped of
creds it must boot and self-prompt — not crash. Stdio servers that hard-require a token in env
to launch are unfit for the whitelist. `clearCredentials` cannot know which env key is "the
secret," so it clears the whole block; this is the operator's responsibility to honor.

## Edge cases

- **`/1on1 off` restores.** Release reloads → resolver sees no lock → agent-cred mount returns.
  No stale cleared state.
- **Other sessions untouched.** Clearing is per-session against a copy. Concurrent non-1on1
  threads keep the agent identity. ("on other sessions the oauth on behalf of agent remain
  active.")
- **Non-whitelisted externals** in a 1on1 keep agent creds. Isolation is opt-in per service.

## Components / files

- `src/gateway/core/gateway.ts` — `loadExternalMcp` returns `{ servers, privateServices }`;
  `mcpResolver` applies the lock check + clearing; `one-on-one` handler calls `reloadSession`.
- `src/gateway/core/clear-credentials.ts` (new) — pure `clearCredentials(cfg)` helper.
- Tests under `tests/gateway/core/`.

## Testing

- `clearCredentials`: strips `env`, `headers`, url userinfo/query; preserves `command`/`args`
  and url host/path; input object not mutated.
- `loadExternalMcp`: parses `privateServices`; defaults `[]`; warns + ignores unknown name.
- resolver: locked + whitelisted → cleared mount; locked + non-whitelisted → agent mount;
  unlocked → agent mount.
- gateway `one-on-one`: `action:"on"` and `action:"off"` each call `reloadSession`.

## Verification path

Manual smoke: configure a `privateServices` entry against a real interactive MCP; `/1on1 on`
in a thread; confirm next turn's tool call prompts auth (auth URL relayed) rather than acting
as the agent; `/1on1 off`; confirm agent identity restored.

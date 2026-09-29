# `/remote` — run a thread's tools on the initiator's machine

**Date:** 2026-09-29
**Depends on:** `/1on1` lock (`one_on_one_locks`), phase 3 gateway credential store and signed job claims (`runAs`).
**Ships as:** release candidate (new migration + agent-loop change), behind `SLAUDE_REMOTE=1`, off by default.

## 1. Goal

Today a Slack thread's session runs on slaude's own machine, in
`$SLAUDE_HOME/workspaces/<thread>`. With `/remote`, the initiator points the
thread at **their own machine** mid-session: from the next turn on, every
Bash command and file read/write/edit runs there, in a directory they chose.
`/remote off` returns to the local workspace. The conversation continues
without losing context.

The agent loop stays on slaude. Only the file and shell **tools** move. The
provider API key, MCP credentials, the knowledge base, and the transcript
never reach the user's machine. The only thing the user installs is
[tailcat](https://github.com/tailscale/tailcat), which carries SSH over
Tailscale's data plane without needing a tailnet (the address embeds the
server's WireGuard public key; DERP relays handle NAT).

### Non-goals (v1)

- A shared, operator-registered remote box. The target is always the
  initiator's own machine.
- Running the CLI itself remotely (`spawnClaudeCodeProcess`). Rejected: it
  would put the API key, MCP credentials and transcript on the user's machine.
- PDF and notebook reads over remote.
- More than one remote per thread.

## 2. Commands and lifecycle

Text commands parsed alongside `/1on1` (`src/gateway/slack/commands.ts`),
handled after the lock filter in `src/gateway/core/gateway.ts`.

| Command | Effect |
|---|---|
| `/remote <tailcat-addr> <dir>` | Switch the thread to the remote. |
| `/remote <tailcat-addr>` | Re-point to a new address, keeping the stored `<dir>` (used after `tailcat serve` restarts). |
| `/remote off` | Switch back to the local workspace. |
| `/remote` | Status: connected / unreachable, direct / relayed, dir, running background jobs, last error. Never echoes the address. |
| `/remote key` | Re-show the user's public key (ephemeral). |

### First use

When the user has no key yet, slaude generates an ed25519 keypair, stores it
in the gateway credential store under owner `user:<id>`, and replies
**ephemerally** with the public key and the exact setup:

```sh
echo '<pubkey>' > ~/.slaude-remote.pub
tailcat serve ssh --ssh-authorized-keys=~/.slaude-remote.pub
```

The same message states the security boundary (§5.3): commands run as the
account running `tailcat serve`; use a separate account or container for
untrusted repos.

### Switching on

1. **Pre-flight (gateway):** connect over tailcat with the user's key, run
   `test -d <dir>`. On failure reply with the reason; store nothing, lock
   nothing, reload nothing.
2. **Lock:** if the thread is not locked, `OneOnOne.lock(initiator)` and record
   that `/remote` created it. Remote always implies the `/1on1` lock, so only
   the initiator can drive their machine and `runAs` is `user:<initiator>`.
3. **Persist:** upsert a `remote_targets` row (§3).
4. **Reload:** reload the session (§4.4). The next turn starts with remote
   tools and the remote mode block.

### Switching off

Delete the row, kill this session's remote background jobs (§5.2), reload.
Unlock only if `lock_by_remote` is set.

**Invariant: no lock, no remote.** `/1on1 off`, a manager override, or any
other path that ends the lock also ends remote mode.

`/remote off` mid-turn follows existing reload semantics: the in-flight turn
finishes on the remote; the next turn is local.

### Host identity

The tailcat address carries the server's WireGuard public key, so the tunnel
already authenticates the peer. No separate SSH host-key pinning. A new
address (restarted `tailcat serve`) surfaces as unreachable with a hint to run
`/remote <new-addr>`.

## 3. Storage

New migration adds:

```sql
CREATE TABLE remote_targets (
  channel_id     TEXT NOT NULL,
  thread_ts      TEXT NOT NULL,
  user_id        TEXT NOT NULL,   -- must equal the lock owner
  addr           TEXT NOT NULL,   -- tailcat address; treated as sensitive, never logged
  dir            TEXT NOT NULL,
  lock_by_remote INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, thread_ts)
);
```

Repo helpers mirror `src/db/one-on-one.ts`: `set`, `find`, `clear`. Works on
both sqlite and Postgres/PGLite through the `DbClient` seam.

The private key lives in the gateway credential store (phase 3), not in this
table.

## 4. Execution path

### 4.1 SDK options when remote is active

In `AgentManager.#startSession` (`src/agent/manager.ts`), when the session has
a remote target:

```ts
disallowedTools: [...existing, 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
mcpServers: { ...existing, remote: remoteToolsServer(helper, target) },
toolAliases: {
  Bash: 'mcp__remote__bash',   Read: 'mcp__remote__read',
  Write: 'mcp__remote__write', Edit: 'mcp__remote__edit',
  Glob: 'mcp__remote__glob',   Grep: 'mcp__remote__grep',
},
```

`toolAliases` (SDK ≥ 0.3.173) routes model-emitted built-in names to the MCP
tools, so skills that say "use Bash" and transcripts containing earlier `Bash`
calls keep working. Built-ins are **disallowed**, not merely aliased:
`disallowedTools` also blocks harness-internal direct calls, which an alias
alone does not. Other built-ins (WebFetch, Agent/Task, TodoWrite, Skill) and
all MCP servers stay local.

`TaskOutput` / `TaskStop` are **not** aliased — they also manage local
background subagents.

### 4.2 Remote helper subprocess

`slaude remote-helper` — one child process per remote-active session, owned by
the process running the query (the node in split deploys, the gateway process
in mono).

- Holds the tailcat client child, one `ssh2` connection (tailcat stdio passed
  as the `sock` Duplex), and the private key **in memory only**.
- Speaks JSON-RPC over stdio with one primitive:

  ```ts
  exec(cmd: string, opts: { stdin?: Uint8Array; timeoutMs: number; login?: boolean })
    → { stdout: string; stderr: string; code: number | null; truncated: boolean }
  ```

- Each `exec` is its own SSH channel; parallel tool calls run in parallel.
- Lazy connect on first call; keepalive; one reconnect with 1 s backoff;
  closes the connection after 10 min idle.
- Output is capped inside the helper (head ~30k chars + last few KB, marked
  truncated) so memory is bounded.
- Tracks the bash working directory: each `bash` call records the remote `pwd`
  afterwards and the next call starts with `cd` there, matching built-in Bash.
  Environment does not persist (neither does the built-in's).

Why a separate process: the key never enters the agent process; a wedged
tailcat/SSH kills only the helper (restarted on next call); and `exec` is the
single seam for tests and for a future transport swap (§7).

### 4.3 Remote tools

`remoteToolsServer` (`createSdkMcpServer`), six aliased tools plus two
background helpers. Input schemas copy the built-ins field for field. Relative
paths resolve against `<dir>`.

| Tool | Implementation over `exec` | Notes |
|---|---|---|
| `bash` | `cd <cwd> && <cmd>` with `login: true` (`bash -lc`, user's PATH); runs under a new process group | timeout 2 min default, 10 min max; on timeout kill the process group (TERM, then KILL after 5 s) |
| `read` | `cat -- <path>`; line slicing and `cat -n` formatting done locally; default 2000 lines, `offset`/`limit` | PNG/JPG returned as image blocks; PDF/ipynb rejected in v1 |
| `write` | `mkdir -p <parent> && cat > <path>` with content on stdin | existing file must have been read in this session |
| `edit` | read, exact `old_string` match (unique unless `replace_all`), write back | must have been read first; refused if remote mtime changed since the read |
| `glob` | `rg --files -g <pattern>`, fallback `find` | sorted newest first, capped at 100 |
| `grep` | `rg` with built-in flags (`-i -n -A/-B/-C`, `glob`, `type`, `output_mode`, `head_limit`, `multiline`) | fallback `grep -rn` without `type`/`multiline` |
| `bash_output(id)` | `tail -c +<offset>` of the job log; exit code once `.exit` exists | not aliased |
| `bash_kill(id)` | kill the job's process group, TERM then KILL after 5 s | not aliased |

Non-bash tools use plain `sh -c` (no login profile) for latency.

**Background jobs** (`bash` with `run_in_background: true`):

```sh
mkdir -p ~/.slaude-bg/<session> && cd <cwd> && \
<newpgrp> bash -c '<cmd>; echo $? > ~/.slaude-bg/<session>/<id>.exit' \
  > ~/.slaude-bg/<session>/<id>.log 2>&1 < /dev/null & echo $!
```

`<newpgrp>` is `setsid` on Linux; macOS has no `setsid`, so the spike picks a
fallback (`perl -e 'setpgrp; exec @ARGV'` or `set -m`). The job survives
channel and connection loss. The job registry lives on the remote under
`~/.slaude-bg/<session>/`, so a restarted helper rebuilds it.

### 4.4 Reload and the node fingerprint

On the gateway, `/remote` and `/remote off` call `agent.reload` like `/1on1`.
In split deploys that reload hits the gateway's own `AgentManager`, which has
no live query, so a warm node session would keep its old tool set.

Fix, which also covers `/1on1`'s stale mode block on nodes:

- Signed job claims gain `sessionConfigFp` = hash(lock owner, remote target
  `addr` + `dir`).
- The node records the fingerprint on its `LiveSession`. At turn start, a
  mismatch triggers a reload before `sendMessage`.

### 4.5 Claims and key delivery

- At dispatch (`src/gateway/core/dispatch.ts`) the gateway reads
  `remote_targets` and adds `remote: { addr, dir }` to the signed job claims,
  only when the target's `user_id` equals the `runAs` user.
- The node fetches the private key from a new gateway endpoint, authorized by
  the job token. Served only when the claims carry `remote`, `runAs` is
  `user:<id>`, and that user owns the key. The node hands it to the helper; it
  is never written to disk or env, so the agent's own Bash cannot read it.
- Known deviation from phase 3's "nodes get access tokens only": the node sees
  a long-lived private key (in memory, scoped to the job). SSH certificates
  would fix it; deferred until tailcat's SSH server support for them is known.

### 4.6 Mode block, status line, gating, audit

- **Mode block** (`src/agent/session-mode.ts`): "Your file and shell tools run
  on <user>'s machine in `<dir>`. The local workspace, knowledge base and MCP
  servers are unchanged. If a tool returns `REMOTE_UNREACHABLE` or
  `REMOTE_AUTH_FAILED`, stop and tell the user; do not retry in a loop."
- **Status line** (`status-text.ts`): `mcp__remote__*` rendered like the
  built-ins with the same redaction (program name only for bash, basename for
  paths) plus a remote marker.
- **Gating parity:** every approval/policy match site that checks `Bash`,
  `Write`, `Edit` (etc.) by name must also match the `mcp__remote__*`
  equivalent. The implementation plan enumerates each site.
- **Audit:** one log line per call — tool, program name or path basename, exit
  code, duration. No content, no address.

## 5. Failure modes

**Rule: remote mode never falls back to local tools.** Built-ins are
disallowed while it is on.

### 5.1 Table

| Failure | Behaviour |
|---|---|
| Pre-flight fails | Reply with reason; no state change. |
| Connection drops mid-turn | One reconnect after 1 s; then tool returns `REMOTE_UNREACHABLE`. One Slack notice per outage, not per call. |
| Address changed | As above; notice suggests `/remote <new-addr>` (dir kept). |
| Key rejected | `REMOTE_AUTH_FAILED`; notice points to `/remote key`. |
| Helper crash | Restarted on next call; job registry rebuilt from the remote. |
| Foreground timeout | Kill the command's process group (closing the channel alone does not reliably kill a process without a pty). |
| Huge output | Capped in the helper. |
| Node dies mid-turn | Existing turn semantics; the replacement node gets the same signed claims, starts a helper, recovers jobs. Remote side effects are not rolled back. |
| Idle | Connection closed after 10 min; lazy reconnect. |
| Lock ends by any path | Remote ends too. |

### 5.2 Cleanup

The helper tracks this session's background jobs. `/remote off` and session
end kill jobs still running and remove their `.log`/`.exit` files. After an
unclean slaude crash, `/remote` status lists leftover PIDs from the remote
registry.

### 5.3 Security boundary

`bash` runs as the account running `tailcat serve` and can reach anything that
account can. Jailing the file tools to `<dir>` prevents accidents; it is not a
security boundary. The boundary is that account. The first-use message says so.

The tailcat address is not a secret once key auth is required, but it is still
kept out of logs, status lines and status replies.

## 6. Latency

Per-call overhead on a warm connection ≈ 2–3 round trips (channel open, exec
request, close) plus remote shell startup: 5–20 ms for `sh -c`, 100–800 ms for
a login shell with heavy profiles. On a direct path this is roughly 2–5 % of a
2–10 s model step; parallel calls overlap. Mitigations built in: login shell
for `bash` only. Status shows direct vs relayed.

**Budget:** warm `exec` overhead p50 < 150 ms on a direct path, measured in the
spike.

## 7. Deferred

- Long-lived remote agent (one exec starts a reader loop; subsequent requests
  cost one round trip, no fork). Only if the spike misses the latency budget.
  Swappable behind the helper's `exec` interface.
- SSH certificates instead of a long-lived key on nodes.
- PDF / ipynb over remote.

## 8. Spike (before the implementation plan)

Throwaway; each result can change this spec.

1. `toolAliases` routes `Bash` to the MCP tool when `Bash` is disallowed; also
   observe behaviour with `Bash` enabled plus an alias.
2. Resume across the flip: a transcript with `Bash` tool_use blocks resumes
   with `Bash` disallowed, and the reverse, without API errors.
3. tailcat stdio client subcommand as the `ssh2` `sock`; `serve ssh
   --ssh-authorized-keys` accepts an ed25519 key.
4. Latency p50/p95, direct and relayed.
5. macOS process-group fallback for background and timed-out jobs.
6. `rg` absence on stock macOS: fallback behaviour of `glob`/`grep`.

## 9. Testing

- **Tool adapters:** unit tests against a fake `exec` — read slicing, edit
  uniqueness and mtime refusal, write-requires-read, grep flag mapping,
  truncation, background output offsets.
- **Helper:** integration against a hermetic in-process SSH server (`ssh2`'s
  `Server`, executing locally) — reconnect, auth failure, timeout kills the
  process group, registry rebuild after restart. No network.
- **Gateway flow:** sim scenario `remote-on-off.yaml` (model:
  `one-on-one-lock.yaml`) — auto-lock, failed pre-flight stores nothing,
  `/1on1 off` ends remote, `/remote <addr>` keeps dir.
- **Fingerprint reload:** assert the reload count, not only end state.
- **Key endpoint:** refused on `runAs` mismatch, missing `remote` claim, or
  wrong owner.
- **Gating parity:** iterate every gated built-in name and assert the
  `mcp__remote__*` equivalent is gated identically.
- **Manual end-to-end** on the RC: real `tailcat serve` on macOS, real Slack
  thread.

## 10. Rollout

- `vX.Y.Z-rc.N` first (migration + agent loop), behind `SLAUDE_REMOTE=1`.
- Node image adds the `tailcat` binary.
- Docs: field note (mechanism, `toolAliases`, key custody, no-fallback rule),
  user guide page for `/remote`, release notes under the stable name.

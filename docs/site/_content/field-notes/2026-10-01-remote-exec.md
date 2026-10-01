# /remote: running a thread's tools on the user's machine

**Date:** 2026-10-01

`/remote <addr> <dir>` makes a thread's shell and file tools execute on the
initiator's own machine over tailcat SSH. This note records the mechanism, the
spike findings that shaped it, and what review rounds changed.

## Move the tools, not the CLI

The alternative is to run the whole agent loop on the user's machine. That
would put the model API key, MCP credentials, KB access and the transcript on
a laptop. Instead the loop stays on slaude and only tool execution moves. The
Claude Agent SDK's `toolAliases` reroutes the built-in Bash/Read/Write/Edit/
Glob/Grep to an in-process MCP server (`remote`, tools `mcp__remote__*`, plus
`bash_output` / `bash_kill` for background jobs).

## Spike findings

- Bash enabled plus `toolAliases` routes the call; a marker file written by the
  command was never created locally.
- With the built-ins *disallowed* plus aliases, the model went looking for the
  missing tool via `ToolSearch` until it ran out of turns. So the built-ins
  stay enabled and keep their native schemas.
- Hooks see the post-alias tool name. A `PreToolUse` deny on built-in names is
  therefore a clean guard: any call that reaches a *local* built-in while remote
  is active is a bug or an alias miss, and is denied.
- The SDK has more built-ins that act on the server and have no remote
  counterpart: NotebookEdit, Monitor, REPL, Workflow, EnterWorktree,
  ExitWorktree and Artifact. These are passed as `disallowedTools` while remote
  is on, and the guard denies them too. (Disallowing these is safe: unlike the
  six aliased tools, nothing is aliased to them.) TaskOutput and TaskStop stay
  allowed because they also manage subagents. Whether subagents inherit the
  aliases and the guard is not yet verified end to end (see the soak
  checklist).
- tailcat's SSH server runs `$SHELL -c` non-login with a minimal PATH. macOS has
  no `setsid` and no `rg`. Closing an exec channel without a pty orphans the
  process. Commands therefore run in their own process group (perl `setpgrp`)
  and are killed by group; `bash` explicitly uses a login shell.
- Measured on a direct path: connect about 0.55 s, warm exec p50 about 21-32 ms.
  Relayed (DERP) latency is not measured yet.

## Decisions

- **Remote implies a locked /1on1** owned by the initiator. The remote machine
  is the initiator's, so no one else may steer it. Anything that changes the
  lock (`/1on1 off`, opening, panel unlock) ends remote mode and reloads the
  session.
- **Manager filter.** A manager or backup is admitted to a remote thread only
  for `/remote off`, `/remote` status and `/1on1 off`. Everything else from a
  non-initiator is dropped, so an approver role never grants control of
  someone else's machine.
- **Never fall back to local tools.** An unreachable machine returns
  `REMOTE_UNREACHABLE` / `REMOTE_AUTH_FAILED` and the agent is told to stop.
- **A drop during a command is reported, never retried.** The command may have
  run; re-running a half-executed command is worse than surfacing the drop.
- **Approvals are the built-ins' approvals.** The approver sees Bash/Write/Edit;
  plan mode denies remote changes, `dontAsk` allows only read-only calls,
  `acceptEdits` allows write/edit but not bash, and no approver means deny
  everything not read-only (fail closed).
- **Security boundary.** Commands run as the account running `tailcat serve`.
  Path jailing in the file tools only prevents accidents; the guide recommends a
  separate account or container for untrusted repositories.

## Split deployments: the node reload gap

Nodes cache warm sessions, and nothing told a node that a thread's remote target
or lock had changed. The gateway now signs `remote` and `sessionConfigFp` into
every job token; the node compares the fingerprint with the warm session's and
reboots on mismatch. A side effect: the same mechanism fixes a stale /1on1 mode
block on warm node sessions that predated this feature.

First sight needs a rule of its own. Nothing records a fingerprint when a
session boots, so a warm session that booted before the gateway emitted
fingerprints (for example, the gateway was upgraded or `SLAUDE_REMOTE` was set
on it first) has no recorded value. Treating first sight as "nothing changed"
let such a session keep its local tools after remote mode came on. Now a *live*
session with no recorded fingerprint is rebooted once (the transcript is kept);
a session that is not live only records the value, since its next boot reads
the current config anyway. If the reboot cannot finish within its deadline
because a turn is still running, the job is requeued with a short delay, the
same way as a held session lock, and the fingerprint stays unrecorded so the
retry reboots. Background jobs on the
user's machine are cleaned up when remote ends, from the gateway, so it works
even if no further turn reaches a node.

## Key custody

A per-(workspace, user) ed25519 key is generated at first `/remote` use or
`/remote key`. The private half is encrypted at rest (AES-256-GCM envelope
under the master key) and served only to a user-scoped remote turn through
`GET /v1/tenants/:t/remote-key`, authorized by the signed job token. In memory
it is held by the helper subprocess, by the parent `HelperClient` until that
process exits, and by the gateway process while it runs pre-flight or cleanup.
It never appears in argv, env, disk or logs. The tailcat address is not secret once key auth is
required, but it travels in the job token and so sits in the queue's job data
for the job's lifetime; it is never echoed in replies, status lines or logs.

## What reviews found

- Fail-closed rules for every approval mode and for the no-approver case.
- The manager filter above: manager/backup roles must not double as control of
  the initiator's machine.
- Zombie-leader ownership check: before killing a process group, the cleanup
  verifies the group leader is still the job it started, so a recycled pid is
  not killed.
- Audit-subject whitelist: audit lines carry tool, program name or file
  basename, exit code and duration only. Leading `KEY=value` assignments are
  skipped, and anything that is not a plain word (quotes, escapes,
  substitutions) logs `-`, so a secret passed as `KEY=value cmd` cannot leak.
  The Slack status line now uses the same extraction, for remote and local
  Bash. Before, it showed the first token, so `KEY=secret cmd` put the secret in
  the status line. Remote tools render like their built-ins, marked
  "(remote)" once.
- **ssh2 key generation defect.** `utils.generateKeyPairSync("ed25519")` in
  ssh2 1.17.0 encodes the 32-byte public key through a path that strips leading
  zero bytes. When the first byte is `0x00` (about 1 key in 256; 79 of 20000 in
  one measurement) the blob declares a 31-byte key. ssh2's own `parseKey` then
  rejects the private key ("Malformed OpenSSH private key") and the
  authorized-keys line is wrong too. Because a user's key is generated once and
  kept, an affected user could never connect. All generation now goes through
  `generateSshKeyPair`, which regenerates (at most 8 times) until both halves
  parse and describe the same 32-byte key. Tests use the same generator. When a
  stored key does not parse, `/remote key` and `/remote on` replace it and send
  the new public key privately with a note to update
  `--ssh-authorized-keys`. `/remote on` then stops, as on first use.
- **Foreign cron jobs.** A thread-target cron job runs as the thread's lock
  owner. So a job another user scheduled in the thread before it was locked
  would run tools on the initiator's machine. `/remote on` refuses while any
  active job in the thread was created by someone else. Paused jobs count too,
  because they can be resumed.
- Output decoding: stdout and stderr each get a `StringDecoder`. Decoding
  every ssh chunk on its own turned a multibyte character split across chunks
  into U+FFFD, which would also have made the non-UTF-8 edit refusal wrongly
  block large non-ASCII files.
- The tailcat ping and spawn helpers never throw when the binary is missing;
  they report unreachable instead (`SLAUDE_TAILCAT_BIN` overrides the path for
  tests and unusual installs).
- Panel unlock and `/1on1` transitions each had to end remote mode and reload
  the warm session, or the thread kept executing remotely under a lifted lock.

## Image

The runtime image installs tailcat v0.7.0 from the release archive and verifies
it against a pinned per-architecture SHA-256 (a mismatch fails the build), so a
tampered or swapped release asset cannot slip into the image.

## Known limitations

No PDF or ipynb reads. An explicit `exec` as the last step of a background
command loses the job marker, so `/remote off` cannot kill that job. Tilde
directories are resolved once at `/remote` time. The hand-rolled tailcat stdio
Duplex was verified against tailcat v0.6.0 locally; the image ships v0.7.0. The
feature is behind `SLAUDE_REMOTE=1`, with `SLAUDE_TAILCAT_BIN` as an operator
override of the binary path.

## Known deviations from the design

- There is no `remote-on-off.yaml` sim scenario. The sim cannot fake the
  network pre-flight, so handler and gateway tests cover the on/off
  transitions.
- `/remote` status does not list running background jobs or leftover pids.
- There is no "one Slack notice per outage". Instead, the tool error text tells
  the model to stop and tell the user.
- `setsid` is not used anywhere. The new process group comes from
  `perl -e 'setpgrp(0,0); exec @ARGV'` on all platforms.

## RC soak checklist

- A real Slack thread end to end, against a macOS remote and a Linux remote.
- Relayed (DERP) latency. Budget: warm exec p50 under 150 ms on a direct path.
  Record the relayed number.
- Resume across the on/off flip on the Anthropic API. The spike used a
  third-party provider.
- In remote mode, delegate `touch marker` to a subagent. No local marker may
  appear. This verifies that `toolAliases` and the guard cover subagents.
- A mono deployment and a split (gateway + node) deployment.
- `bash_kill` and orphan reaping on a real remote.

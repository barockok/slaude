# Workspace filesystem jail (design)

Date: 2026-06-14
Status: approved, pre-implementation

## Problem

Every agent session gets its own workspace dir under `$SLAUDE_HOME/workspaces/`
(`manager.ts:137`, passed as SDK `options.cwd`), but **nothing confines a
session to it**. `permission-gate.ts` inspects tool *names*, not paths; no
`additionalDirectories`, no sandbox, no `blockedPath` handling. In any
prompt-skipping permission mode (`bypassPermissions`, `dontAsk`-allow), a
non-manager thread can `cat ~/.ssh/id_rsa`, read the slaude repo, or wander into
other sessions' workspaces. There is also no manager-vs-user distinction —
`isManager` only gates the knowledge base.

We want the inverse of today: **normal sessions boxed into their workspace; the
manager roams freely.**

## Threat model & decisions (locked)

| Question | Choice |
|----------|--------|
| Threat | **Adversarial exfiltration** — a hostile non-manager actively trying to read host secrets via bash/file tools. |
| Boundary | **Host / shared machine** — the jail IS the security boundary, not a backstop behind a container. |
| Confine | **Reads + writes both**, outside the workspace. |
| Bash | **SDK-native OS sandbox** (sandbox-exec on macOS, bubblewrap on Linux) — string-parsing leaks, rejected. |
| Trusted (unjailed) | **A DM whose partner is the manager or backup manager.** Nothing else. |
| Sandbox binary missing | **Fail closed + alert manager** — jailed session boots with Bash disabled; one-shot Telegram alert. |

SDK is `@anthropic-ai/claude-agent-sdk@0.1.77`, which exposes
`Options.sandbox: SandboxSettings` and `Options.additionalDirectories`.

## Trust model

```
isTrustedSession(row, soul):
  return isDmChannel(row)
     && (row.dm_user_id === soul.manager.userId
      || row.dm_user_id === soul.backupManager.userId)

isDmChannel(row): row.slack_channel_id startsWith "D"
```

- A DM is 1:1, so the partner is fixed for the life of the channel. Persist the
  partner id once at session creation; resolve trust at **boot** against **live
  soul** (so a `/soul` manager change / override takes effect next boot — no
  stale trust).
- Trusted → unjailed (current behavior, free roam). Everything else (channels,
  non-manager DMs, group DMs `G…`/`mpim`) → jailed.

### Plumbing

- New nullable column `sessions.dm_user_id TEXT` (migration: ALTER TABLE backfill
  on existing dbs, mirroring `permission_mode` at `schema.ts:116`).
- `Sessions.createForThread` gains optional `dm_user_id`.
- `AgentManager.ensureSession(thread, opts)` gains `opts.dmUserId`; the gateway
  passes `userId` as `dmUserId` **only when `isDM`** (`gateway.ts:538`,
  call site `:614`).

## Enforcement — two layers (both required)

The SDK sandbox covers **command execution (Bash)**; per SDK docs the SDK's own
**Read/Edit/Write tools are governed by permission rules, not the sandbox**. So
fs confinement needs both.

### Layer 1 — OS sandbox for Bash (jailed sessions only)

In `#startSession`, when `!trusted` and the sandbox binary is available, set:

```ts
sandbox: {
  enabled: true,
  autoAllowBashIfSandboxed: true,   // sandboxed bash runs without a prompt
  allowUnsandboxedCommands: false,  // no escape hatch to unsandboxed exec
  network: jailBashNetwork(),       // default { allowedDomains: [] } — no egress
}
```

cwd is already the workspace and **no `additionalDirectories`** is passed, so the
OS jails bash to the workspace subtree. `cd`, `$(...)`, symlinks, and spawned
interpreters are all confined by the kernel, not by string inspection.

Bash network egress defaults to **deny-all** (exfil guard); tunable via
`SLAUDE_JAIL_BASH_NETWORK` (comma-separated allowed domains).

Trusted sessions: no `sandbox` key (unchanged).

### Layer 2 — file-tool path gate (`permission-gate.ts` `canUseTool`)

For jailed sessions, *before* existing gate logic, enforce paths on the SDK file
tools (`Read`, `Write`, `Edit`, `NotebookEdit`, and `Grep`/`Glob` when an
explicit `path` is given):

```
target = realpath(toolPath)                  // resolve symlinks
if relative(workspaceDir, target) startsWith ".." → behavior: "deny" (hard, no prompt)
```

- `realpath` on the nearest existing ancestor defeats symlink-escape and
  `..`-traversal; absolute paths outside the tree are rejected.
- Tools with no path arg (Grep/Glob defaulting to cwd) are already safe — gate
  only when an explicit out-of-tree `path` is passed.
- Trusted sessions skip the gate entirely.

The gate needs each session's jail state. `#startSession` records it
(`Map<sessionId, { jailed: boolean; workspaceDir: string }>` on the manager, or
passed into the gate factory); `canUseTool` looks it up by `sessionId`.

### Fail-closed + manager alert

At jailed-session boot, probe sandbox availability:

- darwin → `sandbox-exec` (built in) → available.
- linux → `bwrap` (bubblewrap) on `PATH` → available; else unavailable.

If **unavailable**, never hand the SDK an unenforceable sandbox. Instead boot the
jailed session with `disallowedTools: ["Bash"]` (no bash at all), keep Layer 2,
and fire a **one-shot** (deduped per process) manager alert via the Telegram
bridge: "sandbox unavailable on host — Bash disabled in jailed sessions; install
bubblewrap." Trusted sessions are unaffected.

## Components

| File | Responsibility |
|------|----------------|
| `src/agent/sandbox.ts` (new) | `sandboxAvailable(): boolean` (platform probe), `jailSandboxOptions(): SandboxSettings`, `jailBashNetwork()` |
| `src/agent/jail.ts` (new) | `isDmChannel(row)`, `isTrustedSession(row, soul)`, `pathWithinWorkspace(target, root): boolean` (realpath + relative) |
| `src/db/schema.ts` | `dm_user_id` column + migration + `SessionRow` field |
| `src/db/sessions.ts` | `createForThread` accepts `dm_user_id` |
| `src/agent/manager.ts` | `ensureSession` `dmUserId` arg; `#startSession` computes trust, wires sandbox / disallow-Bash / records jail state |
| `src/gateway/core/gateway.ts` | pass `dmUserId` when `isDM`; fire sandbox-unavailable alert |
| `src/gateway/slack/permission-gate.ts` | Layer-2 path enforcement for jailed sessions |

## Data flow

```
inbound msg (gateway): userId, isDM, channelId
  → ensureSession(thread, { dmUserId: isDM ? userId : undefined })
      → createForThread persists dm_user_id (first time only)
  → sendMessage → #startSession(sessionId)
      → row = Sessions.findById; soul = soulData()
      → trusted = isTrustedSession(row, soul)
      → if trusted:   options = { cwd, ... }                       (free roam)
        else jailed:
           avail = sandboxAvailable()
           options.sandbox = avail ? jailSandboxOptions() : undefined
           if !avail: options.disallowedTools = ["Bash"]; alertManagerOnce()
           record jail state { jailed:true, workspaceDir: row.working_dir }
      → query({ prompt, options })
  → per tool call: canUseTool
      → if session jailed && tool has out-of-workspace path → deny (hard)
      → else existing gate logic
```

## Error handling

- realpath on a not-yet-existing target (e.g. a Write creating a new file):
  resolve the nearest existing parent; a new file inside the workspace passes, a
  new file outside is denied.
- Missing `dm_user_id` on legacy rows → `isTrustedSession` false → jailed
  (fail-safe default; a manager re-DM creates/updates the binding).
- Sandbox probe is cheap but cached per process after first call.
- Alert dedup: a module-level boolean so repeated jailed boots don't spam.

## Behavior change (explicit)

Today nothing is jailed. After this, **every non-(manager/backup DM) thread loses
free filesystem and free bash** — channels can't `cat` repo files or run
arbitrary host commands; bash runs sandboxed to the workspace. This is the intent
for the adversarial model but is a real default shift. The manager/backup work
unrestricted simply by DMing the agent.

## Testing

- `jail.test.ts`: `isTrustedSession` — manager DM true, backup DM true, stranger
  DM false, channel false, missing `dm_user_id` false. `pathWithinWorkspace` —
  in-tree true; `..` escape false; absolute-outside false; symlink pointing out
  false; new-file-in-tree true.
- `sandbox.test.ts`: `sandboxAvailable` darwin → true; linux with/without `bwrap`
  on a mocked PATH. `jailSandboxOptions` shape; `jailBashNetwork` env parse.
- `permission-gate` path gate: jailed session denies out-of-tree Read/Write;
  allows in-tree; trusted session skips gate. Bash disabled when sandbox
  unavailable.
- Migration: fresh db has `dm_user_id`; existing db backfills nullable.

## Out of scope

- Container-per-session / git-worktree-per-session (the deferred CLAUDE.md
  sandboxing decision) — escalation path if the SDK sandbox proves insufficient;
  not built now.
- Network confinement of the agent's own API/MCP calls (parent process) — only
  jailed **bash** egress is restricted here.
- Per-message trust variation — trust is fixed at session boot (the CLI child is
  long-lived); a manager DM is inherently single-user so this is not a gap.

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
| Threat | **Configurable** — operator picks `discipline` (accident-proofing) or `adversarial` (exfil-proofing) per deploy. |
| Boundary | **Host / shared machine** — in `adversarial`, the jail IS the security boundary. |
| Confine | **Reads + writes both**, outside the workspace. |
| Bash | `adversarial`: **SDK-native OS sandbox** (sandbox-exec / bubblewrap). `discipline`: best-effort string-check (leaky, accident-only). |
| Trusted (unjailed) | **A DM whose partner is the manager or backup manager.** Nothing else. |
| Sandbox binary missing (`adversarial`) | **Fail closed + alert manager** — jailed session boots with Bash disabled; one-shot Telegram alert. |

SDK is `@anthropic-ai/claude-agent-sdk@0.1.77`, which exposes
`Options.sandbox: SandboxSettings` and `Options.additionalDirectories`.

## Jail mode (configurable)

`SLAUDE_JAIL_MODE` selects how strongly jailed (non-trusted) sessions are
confined. The **trust model is identical across all modes** — only the meaning
of "jailed" changes.

| `SLAUDE_JAIL_MODE` | Jailed-session enforcement | Needs sandbox binary | Fail-closed |
|--------------------|----------------------------|----------------------|-------------|
| `off` | None — current behavior, no confinement. Escape hatch. | no | n/a |
| `discipline` **(default)** | Layer 2 file-tool path gate (hard deny) **+** best-effort bash string-check (deny obvious absolute / `..` / out-of-tree). Stops accidents; a determined adversary can still leak via bash. | no | no |
| `adversarial` | Layer 1 OS sandbox (airtight bash) **+** Layer 2 file-tool path gate **+** fail-closed + manager alert. | yes (`adversarial` only) | yes |

Default is `discipline`: it needs no `bwrap`, never disables bash, and won't
break existing deploys — operators opt **up** to `adversarial` on hosts where the
jail is the real security boundary. `off` fully restores today's behavior.

Trusted (manager/backup DM) sessions are **unjailed in every mode**.

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

### Layer 1 — OS sandbox for Bash (`adversarial` mode, jailed sessions only)

In `#startSession`, when mode is `adversarial`, `!trusted`, and the sandbox
binary is available, set:

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

In `discipline` mode there is no OS sandbox; jailed bash instead gets a
**best-effort string-check** in `canUseTool`: parse the command for absolute
paths, `..` traversal, and `cd` outside the workspace, and hard-deny obvious
escapes. This is explicitly leaky (interpreters, `$(...)`, env-indirection slip
through) and exists only to catch accidents — not adversaries.

Trusted sessions, and all sessions in `off` mode: no `sandbox` key, no bash
check (unchanged from today).

### Layer 2 — file-tool path gate (`permission-gate.ts` `canUseTool`)

For jailed sessions in `discipline` and `adversarial` modes (skipped in `off`),
*before* existing gate logic, enforce paths on the SDK file tools (`Read`,
`Write`, `Edit`, `NotebookEdit`, and `Grep`/`Glob` when an explicit `path` is
given):

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

### Fail-closed + manager alert (`adversarial` mode only)

At jailed-session boot **in `adversarial` mode**, probe sandbox availability:

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
| `src/config/env.ts` | `jailMode(): "off" \| "discipline" \| "adversarial"` (default `discipline`), `jailBashNetwork()` |
| `src/agent/sandbox.ts` (new) | `sandboxAvailable(): boolean` (platform probe), `jailSandboxOptions(): SandboxSettings` |
| `src/agent/jail.ts` (new) | `isDmChannel(row)`, `isTrustedSession(row, soul)`, `pathWithinWorkspace(target, root): boolean` (realpath + relative), `bashEscapesWorkspace(cmd, root): boolean` (best-effort string-check) |
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
      → row = Sessions.findById; soul = soulData(); mode = env.jailMode()
      → trusted = isTrustedSession(row, soul)
      → if trusted || mode === "off":  options = { cwd, ... }       (free roam)
        else jailed:
           if mode === "adversarial":
              avail = sandboxAvailable()
              options.sandbox = avail ? jailSandboxOptions() : undefined
              if !avail: options.disallowedTools = ["Bash"]; alertManagerOnce()
           record jail state { jailed:true, mode, workspaceDir: row.working_dir }
      → query({ prompt, options })
  → per tool call: canUseTool
      → if session jailed:
           file tool out-of-workspace path → deny (hard)            (discipline + adversarial)
           Bash (discipline mode) && bashEscapesWorkspace → deny     (best-effort)
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

Default mode is `discipline`: after this, every non-(manager/backup DM) thread
gets its **file tools** confined to the workspace and obvious bash escapes
blocked — but bash is not OS-sandboxed, so a determined adversary can still leak.
This is a moderate default shift (no more `cat ../../repo/secret` via Read), with
no infra dependency. Operators who need the hard boundary set
`SLAUDE_JAIL_MODE=adversarial` (bash OS-sandboxed, fail-closed). `SLAUDE_JAIL_MODE=off`
restores today's behavior exactly. The manager/backup always work unrestricted by
DMing the agent.

## Testing

- `jail.test.ts`: `isTrustedSession` — manager DM true, backup DM true, stranger
  DM false, channel false, missing `dm_user_id` false. `pathWithinWorkspace` —
  in-tree true; `..` escape false; absolute-outside false; symlink pointing out
  false; new-file-in-tree true.
- `sandbox.test.ts`: `sandboxAvailable` darwin → true; linux with/without `bwrap`
  on a mocked PATH. `jailSandboxOptions` shape; `jailBashNetwork` env parse.
- `permission-gate` path gate: jailed session denies out-of-tree Read/Write;
  allows in-tree; trusted session skips gate; `off` mode skips gate. Bash
  disabled when sandbox unavailable (`adversarial`). `discipline` bash
  string-check denies `cat /etc/passwd` / `../` escape, allows in-tree command.
- `env.jailMode`: unset → `discipline`; `off`/`adversarial` parse; unknown →
  `discipline` (fail-safe).
- `bashEscapesWorkspace`: absolute out-of-tree path → true; `..` past root →
  true; plain in-tree command → false.
- Migration: fresh db has `dm_user_id`; existing db backfills nullable.

## Out of scope

- Container-per-session / git-worktree-per-session (the deferred CLAUDE.md
  sandboxing decision) — escalation path if the SDK sandbox proves insufficient;
  not built now.
- Network confinement of the agent's own API/MCP calls (parent process) — only
  jailed **bash** egress is restricted here.
- Per-message trust variation — trust is fixed at session boot (the CLI child is
  long-lived); a manager DM is inherently single-user so this is not a gap.

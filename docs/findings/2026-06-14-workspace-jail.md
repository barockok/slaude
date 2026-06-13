# 2026-06-14 — Workspace filesystem jail

## What

Non-trusted Slack sessions are now confined to their per-thread workspace dir
(`$SLAUDE_HOME/workspaces/<thread>`). Strength is configurable via
`SLAUDE_JAIL_MODE`:

| mode | jailed-session enforcement | needs `bwrap` | fail-closed |
|------|----------------------------|---------------|-------------|
| `off` | none (legacy behavior) | no | — |
| `discipline` **(default)** | file-tool path gate (hard deny) + best-effort bash string-check | no | no |
| `adversarial` | OS sandbox for bash + path gate + fail-closed + manager alert | yes | yes |

## Trust model

Unjailed iff the session is a **DM whose partner is the manager or backup
manager** (`isTrustedSession` in `src/agent/jail.ts`). The DM partner id is
persisted once at session creation (`sessions.dm_user_id`) and trust is resolved
at **boot against live soul**, so a `/soul` manager change takes effect next boot.
Channels, group DMs, and non-manager DMs are all jailed.

## Two enforcement layers

The SDK's native sandbox (`Options.sandbox`, claude-code uses sandbox-exec on
macOS / bubblewrap on Linux) covers **command execution (Bash)** only — per SDK
docs the Read/Edit/Write tools are governed by permission rules, not the sandbox.
So confinement needs both:

1. **Path gate** — enforced in the `canUseTool` wrapper at session boot
   (`manager.ts`), via the pure `jailDecision()` in `jail.ts`. Resolves
   `realpath` of the nearest existing ancestor (defeats symlink + `..` escape)
   and hard-denies any Read/Write/Edit/NotebookEdit/Grep/Glob path outside the
   workspace. Applies in `discipline` and `adversarial`.
2. **OS sandbox** — `adversarial` only. Jailed sessions boot with
   `sandbox: { enabled, autoAllowBashIfSandboxed, allowUnsandboxedCommands:false,
   network }`, cwd=workspace, no `additionalDirectories` → bash jailed to the
   workspace at the kernel level. Bash network egress defaults to deny-all
   (`SLAUDE_JAIL_BASH_NETWORK` to loosen). In `discipline`, bash gets only a
   best-effort string-check (leaky — catches accidents, not adversaries).

## Fail-closed + alert (adversarial)

At jailed-session boot in `adversarial` mode, slaude probes sandbox availability
(`sandbox.ts`: darwin always; linux needs `bwrap`). If missing, it never hands
the SDK an unenforceable sandbox — instead boots with `disallowedTools:["Bash"]`
(no bash) and fires a **one-shot** alert: a Slack DM to the manager
(`sandboxUnavailable` AgentEvent → gateway opens an IM and posts). Telegram was
considered but is an agent-runtime MCP tool, not a core notify API, so Slack DM
is the pragmatic channel.

## Behavior shift

Default `discipline` jails every non-(manager/backup DM) thread's file tools and
blocks obvious bash escapes. Channels can no longer `cat` repo files via Read. To
get the hard boundary set `SLAUDE_JAIL_MODE=adversarial`; `off` restores prior
behavior exactly. Manager/backup work unrestricted simply by DMing the agent.

## Implementation seam note

The spec described "Layer 2 in `permission-gate.ts`". In code the permission gate
is the `#resolver` that `manager.ts` wraps into `canUseTool` at boot — the jail
check lives in that wrapper (it already has `sessionId` + boot-time jail state),
needing no new plumbing into the gateway gate.

## Refs

- Spec: `docs/superpowers/specs/2026-06-14-workspace-jail-design.md`
- Plan: `docs/superpowers/plans/2026-06-14-workspace-jail.md`

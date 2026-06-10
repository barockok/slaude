# 2026-06-10 — `/mcp` global connect (manager wires the agent's shared identity)

## Context

`/mcp connect <server>` (finding [2026-06-09](2026-06-09-mcp-oauth-connect-1on1.md)) shipped as **initiator-only inside a `/1on1` lock**: it writes the OAuth token into the initiator's per-user config home (`$SLAUDE_HOME/oauth/<userId>`), so the locked session connects the MCP server *as that user*.

Gap: there was no way to connect a server for the **agent's own shared identity** — the one every unlocked session uses. The operator had to hand-seed the agent's `.credentials.json`.

## Decision

`/mcp` now has two scopes, chosen by lock state at the time the command runs:

- **Inside a `/1on1` lock → `initiator`** (unchanged). Must be the lock owner. Token → `ensureInitiatorConfigDir(userId)`.
- **No lock → `global`** (new). Manager/backup only. Token → `agentConfigDir()` (the live `CLAUDE_CONFIG_DIR`), which every unlocked session inherits.

The scope is carried through the whole flow — slash entry, the connect button (`pendingMcp`), and paste-back (`pendingPaste`) — so loopback and paste modes both honor it, and a button/paste can't be replayed across a scope boundary:

- initiator button: clicker must still own the lock.
- global button: no lock may have appeared, and the clicker must still be manager/backup.

## Why gate global on manager only

A global connect mints credentials the agent uses for *everyone* in every unlocked thread. That's an operator-level action — same trust tier as editing `mcp.json`. Per-user connects stay self-service inside `/1on1`.

## Files

- `src/gateway/core/gateway.ts` — `ConnectScope`, scope resolution in the `/mcp` handler, `persistTokens` dir selection, button + paste scope checks.
- Reuses `agentConfigDir()` / `ensureInitiatorConfigDir()` from `src/agent/oauth-home.ts`.

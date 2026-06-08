# 2026-06-08 — Private services in /1on1 (run as the initiator)

`privateServices: [...]` in `~/.slaude/.mcp.json` (sibling of `mcpServers`) whitelists
external MCP servers that must NOT use the agent's shared OAuth inside a `/1on1` thread.
On lock, the session reloads; the per-session resolver overlays cleared mounts
(`clearCredentials`: env/headers emptied, url userinfo/query/hash stripped) for whitelisted
servers, so they boot anonymous and self-prompt the initiator to authenticate. Other
sessions keep the agent identity (the source server map is never mutated). `/1on1 off`
reloads again to restore agent-cred mounts.

**Mechanism:** trigger = `agent.reload(session.id)` in the `one-on-one` handler → next turn
reboots → `mcpResolver` checks `OneOnOne.find(route.ctx.channel, route.ctx.threadTs)` and
applies `privateOverrides`. A session that boots already-locked is cleared with no
special-casing (the resolver checks the lock on every boot). The reboot is required because
the SDK resolves `mcpServers` once per session boot — credentials can't be hot-swapped mid
session, so a `/1on1` toggle reboots to force re-resolution.

**Logic lives in pure helpers** (`src/gateway/core/external-mcp.ts`): `clearCredentials`,
`parseExternalMcp`, `privateOverrides`, `loadExternalMcp` — all unit-tested; the gateway
wiring is thin glue (resolver overlay + two `reload` calls). The inline `loadExternalMcp`
that lived in `gateway.ts` moved into this module and grew the `{ servers, privateServices }`
return shape.

**Contract:** a whitelisted service MUST support anonymous start + interactive auth.
Stripped of creds it must boot and prompt, not crash. `clearCredentials` clears the whole
env/headers block (it can't know which key is the secret) — per-key clearing deferred.

**Reload-on-/1on1 is testable via the sim:** `SimSession` exposes `agent`, so the integration
test spies `agent.reload` while driving `/1on1` + `/1on1 off`. No other reload path fires
during slash-only sends (the agent never runs), so the assertion is exact (`toBe(2)`).

**Test boundary:** the resolver's overlay semantics (a locked thread → cleared mount actually
replaces the agent-cred mount) is covered by the `privateOverrides` unit test, not an
end-to-end resolver assertion — the resolver closure doesn't expose its server map. The sim
test covers only the reload plumbing. Closing that gap would mean a new gateway seam; deferred.

Spec: `docs/superpowers/specs/2026-06-08-private-services-1on1-design.md`.
Plan: `docs/superpowers/plans/2026-06-08-private-services-1on1.md`.

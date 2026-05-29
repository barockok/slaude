# 2026-05-29 — Simulation gateway (Slack-free verification)

**Decision:** Extract a `Transport` port and invert `createSlackApp` →
`createGateway(agent, transport)`. Production binds bolt; simulation binds an in-memory
`SimTransport`. All gate/command/approval logic runs unchanged in both — consistency by
construction (the full existing suite stayed green across the refactor: 594 tests).

**Why not fake the Slack wire protocol:** `adapter.ts` hardcoded `new App()`, so it needed a
refactor regardless; faking bolt's receiver + action envelopes is brittle across bolt bumps
and is itself untested surface. Inverting the edge is mechanical and lower-risk. Bolt's `App`
satisfies the `Transport` port structurally, so the production path is untouched.

**Stub agent seam:** `StubAgent` drives turns by calling the REAL exported MCP handlers
(`slackHandlers`, `brokerHandlers`) through a narrow `__sessionCtx` seam on the gateway
handle, so approval-gate and the connect-broker execute for real without Claude.

**Real-behavior facts the sim pinned down:**
- The soul regex fallback (`extract.ts`) only fills `approvers`; without the LLM, manager and
  channel allowlists come back empty. The sim injects structured `SoulData` via the existing
  production `setSoulData()` accessor (no new production seam).
- The ApprovalGate authorizes only the catchall approver (`U0APP`); the manager is NOT
  implicitly an approver — a manager click leaves the card pending.
- Channel (non-DM) inbound is dropped for lack of an `@mention` before the channel-mode gate
  runs; the sim injects the bot mention to engage the thread (mirrors a real @mention).

**Drop assertions:** the runner wraps the existing `metric.slackDropsTotal.inc` counter to
capture `{reason}` labels, restoring it on dispose.

**Deferred:** file attachments (fetch-based, off the WebClient surface), web UI, real-agent CI
runs, full owner-approval borrow transcript (needs a `connect` step + the CDP login-host seam;
the borrow-grant scenario currently proves the broker tool is reachable and returns a
needs-connect hint).

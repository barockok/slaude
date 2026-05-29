# Contextual MCP Connections — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm); pending implementation plan.

## Problem

slaude needs per-user, contextual MCP connections inside a Slack thread.

- When user A asks "list my PRs" / "my Jira", slaude must act through A's *own* authenticated
  connection to that service — not a shared bot identity.
- When user B (same thread) needs a service only A has connected, slaude must ask A for
  per-request approval before using A's connection.
- These user connections are **ephemeral** — scoped to the thread, never crossing threads,
  reaped on expiry/idle.
- Independently, slaude keeps its **own long-running** connections (its agent identity) that
  persist across sessions. A user asking for *their* data never silently falls back to slaude's
  identity.
- Establishing a connection uses an **ephemeral remote Chrome (CDP)**: slaude hands the user a
  secured live-view URL; the user logs in interactively; slaude captures the resulting
  credential artifact (browser session cookies *or* an OAuth/API token, per service).

## Decisions (from brainstorm)

| Question | Decision |
|----------|----------|
| Credential artifact | **Both / per-service.** Registry declares each service's auth strategy: `token` or `cookie`. |
| Runtime model | **Hybrid broker.** A stable in-process broker MCP fronts lazily-spawned upstream MCP children. |
| Upstream integration | **Approach A — subprocess pool.** Broker spawns the real vendor MCP per `(owner, service)`, creds injected at spawn, and acts as an MCP *client* to each child. |
| Tool surface | **Generic proxy tools.** Fixed broker tool list; vendor tools invoked indirectly via `call(service, tool, args)`. |
| Identity binding | **Thread-shared pool.** Connections live in a thread-scoped pool; a member may borrow another member's connection. |
| Cross-user trigger | Borrowing another member's connection requires the **owner's per-request approval**. Connections never cross threads. |
| Grant scope | **Per-request.** Each borrow re-approved by the owner. (Audited; no standing grant row.) |
| Browser infra | **Ephemeral remote Chrome over CDP** + secured single-user live-view URL; capture-then-teardown. |
| Credential storage | **Encrypted-at-rest in sqlite with TTL** (single store, reaper). AES-256-GCM. |
| Initiation UX | **Both** — auto-prompt "Connect" button on first need, plus explicit `/connect <service>` and `/connections`. |

### Approach A caveat
Cred injection at child spawn is natural for **token** services (env/header). For **cookie**
services, the child is a browser-driving MCP handed the captured `storageState` (path/blob via
env). Heavier, but supported.

## Architecture

```
Slack thread ──turn──▶ AgentManager session
                          │  (MCP resolved once at session start — UNCHANGED)
                          ▼
                   ┌──────────────────────┐
                   │  connect broker MCP   │  in-process (createSdkMcpServer),
                   │  - meta tools         │  wired in adapter.ts like session-mcp;
                   │  - proxy tools        │  stable, loaded at session start.
                   └──────────┬───────────┘
                              │  broker acts as MCP *client* to children
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        jira (userA)    jira (userB)     github (userA)   ← vendor MCP subprocesses
        creds@spawn     creds@spawn      creds@spawn        lazily spawned, pooled, idle-reaped
```

**Why this dodges the session constraint:** MCP servers are resolved once at session start
(`manager.ts:261`) and all see the same `process.env`. The broker is a single in-process MCP
loaded normally; it owns and spawns the vendor children itself and proxies to them. The SDK never
re-resolves and per-user creds never touch the shared `process.env`.

## Components

New: `src/agent/connect-broker/`
- `broker-mcp.ts` — `createSdkMcpServer` exposing the fixed proxy tool set.
- `child-pool.ts` — `Map<"owner::service", {client, proc, lastUsed}>`; lazy spawn, idle reaper,
  MCP-client wiring to each child.
- `registry.ts` — per-service definitions: `auth_strategy`, spawn command/env template, capture
  rules, and `personal` vs `shared-ok` classification.
- `login.ts` — ephemeral CDP browser lifecycle + live-view URL minting + capture.
- `crypto.ts` — AES-256-GCM encrypt/decrypt of credential blobs.
- `resolver.ts` — caller → connection resolution + borrow decision.

Touched:
- `src/db/schema.ts` + new `src/db/connections.ts` accessors.
- `src/gateway/slack/adapter.ts` — wire broker MCP into the per-session MCP set; Connect/Approve
  Block Kit handlers; `/connect`, `/connections` commands.
- Reuse `src/gateway/slack/approval-gate.ts` for the owner-approval prompt.

### Broker tool surface (fixed)
- `connections_list()` — caller's + thread-visible connections.
- `connect(service)` — start the login flow; returns a Slack-posted Connect URL.
- `connections_revoke(service?)` — owner revokes own connection(s).
- `describe(service)` — return the vendor child's tool schemas (spawns/queries child if needed).
- `call(service, tool, args)` — the proxy. Resolves caller's connection, spawns/reuses child,
  forwards the tool call, returns the result.

## Data model (`src/db/schema.ts`)

```sql
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  owner_slack_user_id TEXT NOT NULL,
  service             TEXT NOT NULL,           -- "jira", "github"
  scope               TEXT NOT NULL,           -- "thread" | "slaude"
  team_id             TEXT,                    -- thread binding; NULL for slaude scope
  channel_id          TEXT,
  thread_ts           TEXT,
  auth_strategy       TEXT NOT NULL,           -- "token" | "cookie"
  cred_ciphertext     BLOB NOT NULL,           -- AES-256-GCM: nonce || ciphertext || tag
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  expires_at          INTEGER,                 -- TTL; NULL/long for slaude scope
  status              TEXT NOT NULL DEFAULT 'active'  -- active | expired | revoked
);
CREATE UNIQUE INDEX idx_conn_owner_service_thread
  ON connections(owner_slack_user_id, service, team_id, channel_id, thread_ts);

CREATE TABLE connection_audit (              -- append-only
  id                    TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  approver_id           TEXT,
  request_summary       TEXT,
  decision              TEXT NOT NULL,        -- approved | denied | timeout
  created_at            INTEGER NOT NULL
);
```

Per-request borrow leaves no standing grant — only a `connection_audit` row.

## Flows

### Connect (login)
1. `connect(service)` or a `needs_connect` structured error from `call`.
2. Spawn ephemeral headful Chrome (CDP).
3. Mint a **signed, single-user, short-TTL live-view URL**; post to that user (ephemeral message / DM).
4. User logs in interactively. Completion detection:
   - `cookie`: target-domain cookies present (or explicit "Done" click) → capture `storageState`.
   - `token` (OAuth): catch redirect to callback → capture access/refresh token.
5. Encrypt artifact, insert `connections` row with TTL. Tear down the browser.
6. Timeout/abandon → cleanup + notify the user.

### Call (own connection)
`call(service, tool, args)` → resolver finds the caller's own active connection for `service` in
this thread → ensure child spawned (decrypt cred, inject at spawn) → forward tool call to child →
return result. Update `last_used_at`.

### Call (borrow — cross-user)
Caller has no own connection but a thread member's connection exists → broker posts Block Kit
approval to the **owner** (`approval-gate.ts`): *"<borrower> wants your <service> for: `<tool +
summarized args>`. Approve?"* Only the owner's `user_id` may approve.
- Approve → run that single call, write `connection_audit(decision=approved)`.
- Deny/timeout → structured error, audit row.

Fires per request; the approval message is kept terse since it is frequent.

### Personal vs shared (slaude scope)
`registry.ts` marks each service/tool `personal` or `shared-ok`. Personal tools ("my PRs", "my
Jira") **must** resolve to the caller's own connection — never the `slaude` scope. `shared-ok`
tools may fall back to slaude's long-running connection when no user connection applies (e.g.
autonomous work).

## Security

- **At rest:** AES-256-GCM, key from `SLAUDE_CRED_KEY` (env now; KMS-derivable later), per-row nonce.
- **Live-view URL:** signed token, short expiry, bound to a single slack user, https only.
- **No cred logging:** child env and captured blobs are scrubbed from logs.
- **Reaper:** periodic sweep of expired/idle connections → wipe ciphertext + kill child process.
- **Approval authz:** only the connection owner's slack `user_id` may approve a borrow (reuse
  `approval-gate.ts` allowlist check).
- **Audit:** every borrow decision recorded in `connection_audit`.

## Testing

- `crypto.ts` round-trip (encrypt → decrypt; tamper detection).
- Caller-resolution matrix: own / borrow / none / personal-vs-shared / slaude-fallback.
- Borrow → approval path: approve, deny, timeout.
- Child pool: lazy spawn, reuse, idle reap (mock child MCP).
- Login capture: cookie + OAuth completion (mock CDP).
- Integration: Slack Connect button → login → `call` end-to-end.

## Open questions (defer)

- Encryption key rotation strategy (start single static key from env).
- Browser infra host: in-container headful Chrome vs sidecar; CDP-over-web vs noVNC for live-view.
- Whether `describe(service)` should pre-warm a child or use a cached schema snapshot.
- Concurrency cap on simultaneous live-view login browsers.

## YAGNI (explicitly out)

- Standing/per-thread borrow grants (chose per-request).
- External vault for ephemeral creds (chose sqlite-at-rest).
- Header-swap proxy and pure service-adapter approaches (chose subprocess pool).
- Cross-thread connection reuse.

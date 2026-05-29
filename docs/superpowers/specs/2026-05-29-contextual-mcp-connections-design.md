# Contextual MCP Connections — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm), revised after security/coherence/UX review; pending implementation plan.

## Problem

slaude needs per-user, contextual MCP connections inside a Slack thread.

- When user A asks "list my PRs" / "my Jira", slaude must act through A's *own* authenticated
  connection to that service — not a shared bot identity.
- When user B (same thread) needs a service only A has connected, slaude must get A's consent
  before using A's connection.
- These user connections are **ephemeral** — scoped to the thread, never crossing threads,
  reaped on expiry/idle.
- Independently, slaude keeps its **own long-running** connections (its agent identity) that
  persist across sessions. A user asking for *their* data never silently falls back to slaude's
  identity.
- Establishing a connection uses an **ephemeral remote Chrome (CDP)**: slaude hands the user a
  secured live-view URL; the user logs in interactively; slaude captures the resulting
  credential artifact (browser session cookies *or* an OAuth/API token, per service). OAuth/token
  is preferred wherever the service supports it; cookie capture is the grudging fallback.

## Decisions

| Question | Decision |
|----------|----------|
| Credential artifact | **Both / per-service.** Registry declares each service's auth strategy: `token` (preferred) or `cookie` (fallback). |
| Runtime model | **Hybrid broker.** A stable in-process broker MCP fronts lazily-spawned upstream MCP children. |
| Upstream integration | **Approach A — subprocess pool.** Broker spawns the real vendor MCP per connection, creds injected at spawn, broker acts as MCP *client* to each child. |
| Tool surface | **Generic proxy tools.** Fixed broker tool list; vendor tools invoked indirectly via `mcp_call`. |
| Caller identity | **In-band per call.** Caller's slack user id passed as an explicit `on_behalf_of` arg and validated server-side. NOT read from mutable session context. (See B1.) |
| Identity binding | **Thread-shared pool.** Connections live in a thread-scoped pool; a member may borrow another member's connection with consent. |
| Cross-user grant | **Per-thread, revocable.** First borrow → one rich approval to the owner; subsequent borrows in that thread run silently but each use is audited. Owner revokes anytime via `/connections`. (Revised from per-request — see "Grant model" below.) |
| Approval binding | Each approval/borrow is bound to a **canonical hash of `(service, tool, normalized args)`** for write tools; the Block Kit message renders the real tool + key args, never an LLM summary. |
| Borrowable surface | Registry classifies each vendor tool `borrowable` vs `owner-only`. Owner-only tools never run under a borrow, regardless of approval. |
| Browser infra | **Ephemeral remote Chrome over CDP** behind a server-mediated live-view (no raw CDP port), one-time token, capture-then-teardown. |
| Credential storage | **Encrypted-at-rest in sqlite with TTL** (single store, reaper). AES-256-GCM, per-row nonce, AAD-bound to row. |
| Initiation UX | **Both** — auto-prompt "Connect" card on first need (also the teaching moment), plus explicit `/connect <service>` and `/connections`. |
| Consent | Explicit consent card before any credential capture: what is captured, where stored, TTL, thread-only scope. |

### Grant model (revised: per-thread revocable, not per-request)

The brainstorm chose per-request approval. Review (all three angles) flagged this as security
theater: frequent identical modals train the owner to rubber-stamp, filling the audit log with
"approved" rows representing zero human judgment. Reversed to:

- **First borrow** of A's connection by B in a thread → ONE rich approval DM to A:
  *"@B wants to use your `<service>` in this thread. Allow for this thread? `[Allow for thread]
  [Just this once] [Deny]`"*
- `Allow for thread` → write a `connection_grants` row scoped to `(owner, borrower, service,
  thread)`. Subsequent borrows run silently.
- **Every use is still audited** (`connection_audit` row per call) — no loss of audit fidelity.
- `Just this once` → single call, no standing grant.
- Owner revokes any grant anytime via `/connections` (immediate effect).

This keeps the full audit trail while spending the owner's attention once, so the one approval is
actually read.

### Approach A caveat

Cred injection at child spawn is natural for **token** services. For **cookie** services, the
child is a browser-driving MCP handed the captured `storageState`. Injection is via **stdin /
handshake, never env or argv** (env is readable via `/proc/<pid>/environ`, argv via `ps` — both
leak across same-uid children). See M1.

## Architecture

```
Slack thread ──turn──▶ AgentManager session
                          │  (MCP resolved once at session start — UNCHANGED; manager.ts:261)
                          ▼
                   ┌──────────────────────┐
                   │  slaude_connect MCP   │  in-process (createSdkMcpServer),
                   │  - meta tools         │  wired into the resolver record in adapter.ts;
                   │  - proxy tools        │  stable, loaded at session start.
                   └──────────┬───────────┘
                              │  broker acts as MCP *client* to children
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        jira (connA)    jira (connB)     github (connA)   ← vendor MCP subprocesses
        cred via stdin  cred via stdin   cred via stdin     lazily spawned, pooled, idle-reaped
```

**Why this dodges the session constraint:** MCP servers are resolved once at session start
(`manager.ts:261`) and `options.mcpServers` is fixed for the session (`manager.ts:314`). The
broker is a single in-process MCP loaded normally; it owns and spawns the vendor children itself
and proxies to them. The SDK never re-resolves and per-user creds never touch `process.env`.

**Child pool keying:** pool key is the **connection id** (`owner::service::team::channel::thread`),
NOT `owner::service` — otherwise a child spawned for a connection in thread X would be reused in
thread Y, violating the never-cross-threads rule. The pool is a module-level singleton independent
of session lifecycle; children are torn down by the connection reaper + an idle-child timer, not by
session idle (so session churn doesn't orphan children).

## Components

New: `src/agent/connect-broker/`
- `broker-mcp.ts` — `createSdkMcpServer({ name: "slaude_connect" })` exposing the fixed proxy tools.
- `child-pool.ts` — `Map<connectionId, {client, proc, lastUsed, refcount}>`; lazy spawn, leased
  during a call (ref-count to avoid reap-mid-call), idle reaper, MCP-client wiring to each child.
- `registry.ts` — per-service definitions: `auth_strategy`, spawn command, cred-injection shape,
  capture rules, and per-**tool** flags: `borrowable`, `personal`, `write`.
- `login.ts` — ephemeral CDP browser lifecycle + server-mediated live-view + one-time token + capture.
- `crypto.ts` — AES-256-GCM encrypt/decrypt of credential blobs (per-row nonce + AAD).
- `resolver.ts` — caller → connection resolution + borrow/grant decision (fail-closed).

Touched:
- `src/db/schema.ts` (+ migrations) + new `src/db/connections.ts` accessors.
- `src/gateway/slack/adapter.ts` — add broker MCP to the resolver record; Connect/consent/approval
  Block Kit handlers; render borrow/timeout/expiry as human guidance (not raw `:warning: error:`);
  `/connect`, `/connections` delegating to broker logic; add both to `helpText()`.
- `src/gateway/slack/approval-gate.ts` — **add `approvers?: string[]` override** to
  `ApprovalRequest`/`request()` so the broker can target the connection owner. (Today approvers
  come only from SOUL/`SLAUDE_APPROVERS`; an arbitrary owner can never approve — see B2.) Reuse its
  timeout (`approvalTimeoutSeconds`).
- `src/agent/manager.ts` — **scrub `SLAUDE_CRED_KEY` from the SDK child env** (currently
  `env:{...process.env}` at line 312 would propagate it). Broker decrypts; children never see the key.

### Broker tool surface (fixed)
- `connections_list()` — caller's own + connections visible in this thread (owner must be a current
  member). Read-only, auto-allow OK.
- `connect(service)` — start the consent + login flow; posts a Connect card. Read-ish, auto-allow OK.
- `connections_revoke(service?)` — owner revokes own connection(s)/grant(s). Owner-authed.
- `mcp_describe(service)` — return the vendor child's tool schemas (cached snapshot; ownership/member
  gated).
- `mcp_call(service, tool, args, on_behalf_of)` — the proxy. **Gated, not auto-allowed.** Resolves
  the connection for `on_behalf_of`, enforces borrowable/personal/write rules, spawns/leases the
  child, forwards, returns. Write tools route through PermissionGate and the hash-bound approval.

(Names chosen to avoid the over-generic `call`/`describe` colliding with the model's verbs.)

## Data model (`src/db/schema.ts`)

Tables added via the existing `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` migration pattern.

```sql
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,        -- owner::service::team::channel::thread (or uuid)
  owner_slack_user_id TEXT NOT NULL,
  service             TEXT NOT NULL,           -- "jira", "github"
  scope               TEXT NOT NULL,           -- "thread" | "slaude"
  team_id             TEXT,                    -- thread binding; NULL for slaude scope
  channel_id          TEXT,
  thread_ts           TEXT,
  auth_strategy       TEXT NOT NULL,           -- "token" | "cookie"
  cred_ciphertext     BLOB NOT NULL,           -- AES-256-GCM: nonce(96-bit) || ciphertext || tag
  key_id              TEXT NOT NULL,           -- which SLAUDE_CRED_KEY encrypted this (rotation)
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  expires_at          INTEGER,                 -- TTL; NULL/long for slaude scope
  status              TEXT NOT NULL DEFAULT 'active'  -- active | expired | revoked
);
-- Partial unique indexes: NULLs are DISTINCT in SQLite unique indexes, so a single index over the
-- tuple would NOT dedupe slaude-scope rows (all-NULL thread fields). Split by scope:
CREATE UNIQUE INDEX idx_conn_thread ON connections(owner_slack_user_id, service, team_id, channel_id, thread_ts)
  WHERE scope = 'thread';
CREATE UNIQUE INDEX idx_conn_slaude ON connections(owner_slack_user_id, service)
  WHERE scope = 'slaude';

CREATE TABLE connection_grants (             -- standing per-thread borrow grants (revocable)
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,               -- the owner's connection being borrowed
  borrower_slack_user_id TEXT NOT NULL,
  team_id, channel_id, thread_ts TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,                     -- NULL = active
  UNIQUE(connection_id, borrower_slack_user_id)
);

CREATE TABLE connection_audit (              -- append-only; one row per USE + per grant decision
  id                    TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  approver_id           TEXT,
  service               TEXT,
  tool                  TEXT,                -- the ACTUAL vendor tool run
  args_hash             TEXT,                -- canonical hash of normalized args (ties to approval)
  decision              TEXT NOT NULL,       -- approved | denied | timeout | used
  created_at            INTEGER NOT NULL
);
```

**Resolution queries** the resolver runs (state them so they're not implicit):
- Own connection: `connections WHERE owner = :caller AND service = :svc AND <thread tuple> AND status='active'`.
- Borrow candidate: `connections WHERE service = :svc AND <thread tuple> AND owner != :caller AND status='active'`.
- Active grant: `connection_grants WHERE connection_id = :id AND borrower = :caller AND revoked_at IS NULL`.

## Flows

### Connect (consent + login)
1. `connect(service)` or a `needs_connect` structured error from `mcp_call`.
2. Post a **consent card** to the initiating user: what is captured (`token`/`cookie`), stored
   encrypted, **this thread only**, expires in N hours / on idle. One-time "I understand" per service.
3. Spawn ephemeral headful Chrome (CDP). Mint a **server-mediated, one-time, short-TTL live-view**
   (no raw CDP port exposed); deliverable to and openable by only the initiating user; not forwardable.
4. User logs in interactively. Completion detection:
   - `token` (OAuth, preferred): catch redirect to callback → capture access/refresh token.
   - `cookie` (fallback): target-domain cookies present (or explicit "Done — I'm connected") → capture
     `storageState`.
   The credential is bound to the slack user who actually completed login (verified via an
   authenticated Slack interaction, not just a browser click — session-fixation defense, H4).
5. Encrypt (96-bit CSPRNG nonce, AAD = connection id), insert `connections` row with TTL + `key_id`.
   Tear down the browser. Post `:white_check_mark: <service> connected (expires in Nh)` to the thread.
6. Timeout/abandon → cleanup + actionable re-entry message.

### Call (own connection)
`mcp_call(service, tool, args, on_behalf_of)` → validate `on_behalf_of` is the real Slack author of
the triggering message (in-band, B1) → resolver finds that user's own active connection → enforce
`personal`/`write` rules → lease + ensure child spawned (broker decrypts, injects cred via stdin) →
forward → return. Write `connection_audit(decision='used')`, update `last_used_at`.

### Call (borrow — cross-user)
Caller has no own connection but a thread member's exists, and `tool` is `borrowable`:
- **Active grant exists** → run silently, audit `used`.
- **No grant** → compute `args_hash`; post the rich approval to the **owner** (via the new
  `approvers:[ownerId]` override on `ApprovalGate.request()`), rendering the real tool + key args.
  `[Allow for thread]` → write `connection_grants` row, run, audit. `[Just once]` → run once, audit.
  `[Deny]`/timeout → human-readable error to borrower, audit decision.
- For **write** tools, even with a grant, the specific call is re-bound to `args_hash` and routed
  through PermissionGate; broker recomputes the hash before forwarding and rejects on mismatch
  (defeats LLM-summary spoofing + TOCTOU, H2).

Borrower visibility while waiting: post *"That needs @owner's `<service>` — asked them to approve;
I'll continue once they do (or time out in ~Xm)."*

### Personal vs shared (slaude scope)
`registry.ts` marks each **tool** `personal` or shared. Enforcement is in the resolver **before**
child selection. Personal tool + caller has no own connection → hard `needs_connect`, never falls
back to slaude scope and never silently borrows. Unclassified tools are treated as `personal`
(fail-closed). `shared-ok` tools may use slaude's long-running connection when no user connection
applies; when slaude's identity is used on a query that plausibly wanted the user's view, attribute
it in the reply (*"(using slaude's GitHub — `/connect github` to see your private repos)"*).

## Security

- **H1 — gate the proxy.** `mcp_call` is write-capable; it must NOT ride the `mcp__slaude_*`
  auto-allow (`permission-gate.ts:154`). Read tools (`connections_list`, `mcp_describe`, `connect`)
  may auto-allow; `mcp_call` is gated; `write` tools route through PermissionGate.
- **H2 — bind approval to the call.** Approvals carry a canonical hash of `(service, tool, normalized
  args)` + a one-time nonce + short TTL; broker recomputes and matches before forwarding, consumes
  once. Block Kit renders the real tool + args, never an LLM summary.
- **H3 — scoped borrow.** Registry `borrowable` vs `owner-only` per tool; owner-only never runs under
  a borrow regardless of approval.
- **H4 — live-view.** No raw CDP port; server-mediated proxy behind slaude auth; one-time token,
  single concurrent viewer, invalidated on first load; resulting credential bound to the verified
  Slack user who completed login (session-fixation defense); URL is a bearer secret — never logged.
- **H5 — membership.** Verify the borrower is a current channel/thread member before any borrow
  prompt; `connections_list` shows only the caller's own + connections whose owner is also a current
  member (avoid existence-leak of who-uses-what).
- **M1 — cred injection.** Via stdin/handshake, never env or argv (same-uid `/proc` leak across
  children). Cookie `storageState` temp files non-world-readable + unlinked after child reads.
- **M2 — key handling.** `SLAUDE_CRED_KEY` excluded from spawned child env (broker-only decrypt;
  scrub at `manager.ts:312`); `key_id` per row for rotation; slaude-scope long-lived creds are the
  largest blast radius — consider a separate key / external KMS even in v1.
- **M3 — AES-GCM.** 96-bit nonce from CSPRNG per encryption (never counter/derived); AAD = connection
  id to prevent ciphertext swapping between rows; round-trip test asserts nonce uniqueness + tamper
  rejection.
- **Reaper.** Periodic sweep of expired/idle connections → wipe ciphertext + kill child; ref-count
  leases so a child is never reaped mid-call.
- **Audit.** Every use + grant decision recorded with the actual `tool` + `args_hash`.

## Testing

- `crypto.ts`: round-trip, tamper rejection, nonce uniqueness, AAD mismatch rejection.
- Caller-resolution matrix: own / borrow-with-grant / borrow-no-grant / none / personal-no-conn /
  unclassified-fail-closed / slaude-fallback. **Concurrent-user race: B messages mid-A-turn must not
  flip the connection `mcp_call` resolves** (validates B1's in-band identity).
- Approval binding: approve, deny, timeout; hash-mismatch rejection; replay rejection.
- Grant lifecycle: first-borrow prompt → allow-for-thread → silent reuse → revoke cuts access.
- Child pool: lazy spawn, reuse by connection id, no cross-thread reuse, idle reap, no reap-mid-call.
- Login: cookie + OAuth completion; session-fixation (initiator != completer rejected); one-time URL.
- approval-gate `approvers` override targets the owner correctly.
- Integration: Slack Connect → consent → login → `mcp_call` end-to-end; borrower-waiting + timeout copy.

## Open questions (defer)

- Encryption key rotation mechanics (schema carries `key_id`; rotation job TBD).
- Browser infra host: in-container headful Chrome vs sidecar; web-CDP vs noVNC for the live-view proxy.
- Hard cap on simultaneous live-view browsers (treat as a v1 limit, not deferred — each holds a
  credential capture).
- Soft "connection about to expire — reconnect?" nudge on active threads vs silent reap.

## YAGNI (explicitly out)

- Header-swap proxy and pure service-adapter approaches (chose subprocess pool).
- Cross-thread connection reuse.
- External vault for *ephemeral* creds (sqlite-at-rest; revisit only for slaude-scope long-lived).

# Session Control Panel — Design

- **Status:** approved design, ready for implementation plan
- **Date:** 2026-08-25
- **Depends on:** `7c541d4` horizontal-scale gateway/node split (M1–M5), on `origin/main`

## Problem

Operators have no way to see or manage running sessions. Truth for live
sessions is split between Postgres (durable `sessions` rows) and the Redis
warm registry (`sess:<id>`), and there is no accessor that lists them. When a
session gets stuck, the only levers are Slack slash commands inside the
originating thread. There is no cross-persona view, no operator surface to
stop/reset a session, and no way to drive a session outside Slack.

This adds a **web control panel on the gateway tier**: see every session,
control it (stop / reset / model / mode / unlock), and chat it directly —
with Slack cleanly handing control to the panel while an operator drives.

## Decisions (locked with product owner)

1. **Surface:** web dashboard served by the gateway.
2. **Power:** read + control + chat (not read-only, not read-mostly).
3. **Operator auth:** front with SSO/ingress (oauth2-proxy / Cloudflare
   Access). Panel trusts an upstream-injected identity header; it never
   handles passwords. Fail-closed.
4. **Slack during panel chat:** panel takes **exclusive control** of a
   session while driven; Slack pauses and resumes on release.
5. **Frontend:** React (React 19 is already a repo dep).

## Non-goals (YAGNI)

- **Panel-originated sessions** with no Slack thread. Session identity stays
  keyed by the Slack tuple (`UNIQUE(team, channel, thread, persona_id)`).
  Decoupling identity is explicitly deferred — big blast radius, not needed
  for view/override/chat of existing sessions.
- Multi-operator realtime co-editing of one session (one lock owner at a time).
- Metrics dashboards / graphs beyond token counts — Grafana owns that.
- Operator user-management UI — SSO/ingress owns identity; panel trusts +
  allowlists.

## Architecture

The panel is a **gateway-tier feature**. It mounts only when
`env.role()` is `gateway` or `mono`, never `node` (nodes have no
Slack/Postgres/Redis serving clients). It is additive: it drives primitives
that already shipped in the horizontal-scale split.

```
Browser ──HTTPS──▶ [SSO / ingress: oauth2-proxy or CF Access]
                        │ injects trusted identity header (e.g. X-Auth-Request-Email)
                        ▼
             Gateway Bun.serve
               ├── existing /v1/*          (machine auth: bearer + per-job JWT)
               └── NEW /panel/*            (operator auth: trust SSO header + allowlist)
                     ├── GET  /panel/api/sessions          → Postgres list ∩ Redis warm registry
                     ├── GET  /panel/api/sessions/:id      → row + durable transcript (RWX volume)
                     ├── GET  /panel/api/sessions/:id/events (SSE) → tail Redis events:<id>
                     ├── POST /panel/api/sessions/:id/chat → existing dispatch enqueue (+ lock)
                     ├── POST /panel/api/sessions/:id/control → PATCH /v1 + publishAbort
                     └── POST /panel/api/sessions/:id/lock|release|force-release
```

Only genuinely new **backend** logic:
- a session-list query (missing today),
- an SSE tail endpoint over the Redis event stream,
- the active-surface exclusivity lock + its two gate checks.

Everything else wires UI to existing `/v1` ops and the existing `dispatch` path.

## Components

Each unit has one purpose and a defined interface.

### 1. Session enumerator — `src/db/sessions.ts` (+ registry join)
- New: `listSessions({ tenant?, persona?, status?, limit, cursor })` →
  `SELECT * FROM sessions ORDER BY updated_at DESC` (paged). This is the one
  missing data accessor — the repo layer is single-row lookups only today.
- Join each row against the Redis warm registry (`sess:<id>` →
  `{ node, since, lastBeat }`) to mark warm/cold + owning node. Result = durable
  truth (Postgres) ∩ live truth (Redis).
- Returns per session: id, persona, Slack ref, status, model, warm?, node,
  updated_at, token usage.

### 2. Panel HTTP surface — `src/gateway/panel/`
- Serves the built React app (static assets) via the existing gateway
  `Bun.serve`.
- `GET /panel/api/sessions` → enumerator (list view; browser polls ~3s).
- `GET /panel/api/sessions/:id` → one row + recent **durable** transcript read
  from the SDK transcript on the RWX volume (durable history) — separate from
  the live event stream, which is lossy by design.
- `GET /panel/api/sessions/:id/events` → **SSE**, tails
  `pubsub.readEvents(id, lastId)` in a loop — a near-clone of the existing
  `dispatch.ts` follower. Streams agent events to the browser live.

### 3. Control ops — thin proxies to shipped primitives
- **stop** → `pubsub.publishAbort(id)` (replica-safe: durable flag + `abort:<id>`
  publish; owning node's `onAbort` calls `agent.abort()`).
- **reset** → `PATCH /v1/sessions/:id { claude_started: 0 }` (forces cold
  re-resume next turn).
- **model / mode swap** → `PATCH /v1/sessions/:id`.
- **unlock stuck 1on1** → `OneOnOne.unlock(channel, threadTs)`.

### 4. Panel chat — reuse `dispatch`
- `makeQueueDispatch().dispatch(session, text, meta)` verbatim — same
  coalescing, warm-vs-cold routing, and event-follow that Slack uses.
- Panel mints the turn with the chosen `persona` / `initiator` (operator
  identity) in `meta`.

### 5. Active-surface lock — the one net-new mechanism (see below).

### 6. Operator-auth middleware — `src/gateway/panel/auth.ts`
- Reads the trusted upstream identity header. Header name configurable
  (`SLAUDE_PANEL_HEADER`, default `x-auth-request-email`).
- Optional allowlist `SLAUDE_PANEL_ALLOW` (comma-separated emails/ids).
- Attaches operator identity to the request → used as `initiator` on
  panel-driven turns and in the audit log.
- **Fail-closed:** if the header is absent, respond 403. The panel refuses to
  boot exposed-without-ingress unless `SLAUDE_PANEL_TRUST_HEADER` is explicitly
  set (guards against a misconfigured deploy serving `/panel` open).
- **Ingress MUST strip the client-supplied identity header (ops requirement).**
  `SLAUDE_PANEL_TRUST_HEADER=1` only *asserts* that an SSO/ingress sits in
  front — it cannot verify it. The ingress (oauth2-proxy / Cloudflare Access)
  MUST unconditionally strip any inbound `x-auth-request-email` (or whatever
  `SLAUDE_PANEL_HEADER` names) from client requests and re-inject it only after
  authenticating the operator. If it does not, any caller can set the header
  and impersonate any operator. The allowlist is matched case-insensitively.

## Data flow — panel chat turn

```
operator types
  → POST /panel/api/sessions/:id/chat
  → acquire active-surface lock (owner = operatorId, TTL)
  → dispatch.enqueue(session, text)          [existing path]
  → node runs turn, appends to events:<id>   [existing]
  → SSE endpoint tails events:<id> → browser renders reply live
  → Slack outbound post path sees lock held → suppresses Slack echo
  → on done / idle / disconnect → release lock → deferred Slack msgs replay,
    Slack resumes
```

## Active-surface lock

Redis key `panel:<sessionId>` → `{ owner: operatorId, since, ttl }`. Same shape
as the existing `lock:session:<id>` / `one_on_one_locks` — proven pattern.

**Two gate checks, both at existing seams:**
1. **Inbound Slack gate** — the gateway pre-enqueue gate stack where
   engagement / mention-only / 1on1 already short-circuit. Add: lock held ⇒
   **defer** the inbound Slack message (hold + replay), post a **one-time**
   thread notice ("⏸ handled in ops panel").
2. **Outbound Slack post** — the `dispatch.ts` follower that posts events to
   Slack. Add: lock held ⇒ skip the Slack post (agent still runs; panel SSE
   still receives it).

**Lifecycle:**
- Acquire on first panel chat into a session (or an explicit "take control").
- Heartbeat: browser refreshes TTL while the tab is active.
- Release on: explicit "release", tab close/disconnect, or **TTL auto-expiry**
  (covers operator crash → Slack auto-resumes, no stuck session). TTL short
  (~60s) + heartbeat.

**Paused-Slack handling: defer + notice + replay** (not silent drop). Inbound
Slack messages during the exclusive window are queued and replayed on release;
the Slack user gets one notice so they are not silently ignored.

**Contended lock:** if another operator holds it, the panel shows "owned by X
since T", offers read-only, and a **force-release** action that is **audited**
(operator, target session, timestamp).

## Error handling

- **SSE drop** → browser reconnects with `lastId` (Redis stream resumable).
  Event-stream trim (`MAXLEN ~1000`) can drop old entries → on a gap, fall back
  to the durable transcript-file read.
- **Node dies mid-turn while locked** → existing warm-registry heartbeat expiry
  + abort semantics apply; panel surfaces "node lost"; lock TTL releases.
- **Gateway restart** → Redis locks survive (TTL); panel reconnects and re-lists.
- **Missing SSO header** (misconfigured ingress) → 403, fail-closed.
- **Contended force-release** → allowed but audited.

## Frontend (React)

One self-contained React 19 app, built with **Vite** (`@vitejs/plugin-react`).
App lives in `src/gateway/panel/web/`.

- **Dev:** Vite dev server (HMR), proxying `/panel/api/*` and `/v1/*` to the
  running gateway (`server.proxy`), so the panel iterates live against a real
  `mono`-role backend.
- **Prod:** `vite build` → static `dist/` served by the existing gateway
  `Bun.serve` under `/panel`.
- **New deps:** `vite`, `@vitejs/plugin-react`, `react-dom` (React 19 +
  `@types/react` + `jsx: react-jsx` already present). Vite is a browser-app
  build tool separate from the Bun-native server toolchain — intentional, not a
  toolchain conflict.

- **List view:** table of all sessions across personas — status pill, warm/cold
  + node, persona, model, last-active, token usage. Filter by persona/status.
  Poll ~3s.
- **Session detail:** live event tail (SSE) over durable transcript; control bar
  (stop / reset / model / mode / unlock); chat box with take-control / release
  and a lock-owner banner.
- Style: internal ops tool — legible, function-first. May reuse the shared brand
  design tokens for consistency; no marketing polish.

## Testing

Run against `mono` role locally (single process, no real cluster needed —
matches how the sim gateway exercises the real manager).

- **Unit:** enumerator (list + registry join → warm/cold correctness); lock
  acquire / release / TTL-expiry; auth middleware (header present / absent /
  allowlist).
- **Integration:** SSE emits events appended to `events:<id>`; reconnect with
  `lastId` resumes; control ops proxy correctly (stop → abort flag, reset →
  `claude_started` 0).
- **Exclusivity (highest-risk):** lock held ⇒ inbound Slack deferred + notice
  posted once ⇒ replay on release; outbound Slack suppressed while held; TTL
  expiry auto-resumes Slack; force-release audited.
- **Fail-closed:** missing SSO header → 403; `node` role → panel not mounted.

## New config (`src/config/env.ts`)

- `SLAUDE_PANEL` — enable the panel surface (default off).
- `SLAUDE_PANEL_HEADER` — trusted identity header (default `x-auth-request-email`).
- `SLAUDE_PANEL_ALLOW` — optional operator allowlist.
- `SLAUDE_PANEL_TRUST_HEADER` — explicit acknowledgement that an ingress is in
  front; required to boot the panel (fail-closed guard).

## Open risks

- **Event-stream lossiness** — live view only; durable history must come from
  the transcript file. Do not treat `events:<id>` as a log of record.
- **Operator impersonation surface** — panel-driven turns act as a chosen
  persona/initiator. Auth + audit must be tight; this is the sensitive path.
- **Local branch is behind `origin/main`** — implementation must be done on a
  branch off the up-to-date origin (`git pull` first) so the shipped `/v1`,
  `dispatch`, `pubsub`, and role seams are present.

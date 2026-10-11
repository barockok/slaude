# Phase 4 — portal onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person opens the portal, authorizes the integrations they want, and their next 1:1 simply has them.

**Architecture:** The portal runs its own OAuth round trip. A single-use encrypted row holds what the exchange needs; a signed cookie holds only that row's id, so any gateway replica can finish a connect started on another. Completed grants land in the phase 3 credential store under the portal account.

**Tech Stack:** Bun + TypeScript, `bun test`, `bunx tsc --noEmit`, React + Vite for the portal app, AES-256-GCM via `src/db/crypto.ts`.

**Spec:** `docs/superpowers/specs/2026-09-30-phase-4-portal-onboarding-design.md`

## Global Constraints

- **No secret reaches the browser.** Not the dynamically registered client secret, not a refresh token, not a PKCE verifier. The cookie carries an opaque flow id and nothing else.
- **The owner comes from the portal session**, never from a path, body or query. Connect and disconnect act on the signed-in account alone.
- **Mutating routes keep phase 2's anti-CSRF rule**: the custom header, checked before any work.
- **No token in a log line, a thrown message, or an HTTP error body.** A provider's `error_description` can name one, so errors carry status and standard OAuth codes only.
- **The flow row is single use**: deleted on completion, swept on expiry, and a replayed callback finds nothing.
- **With `SLAUDE_PORTAL` unset every portal route 404s**, exactly as today.
- Public repo: placeholders only (`UTESTUSER1`, `TTESTTEAM1`). Granular commits, no AI co-authorship trailers, leak-scan every staged diff.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/db/migrations/0009_portal_oauth_flows.sql` + `src/db/drivers/sqlite.ts` | The single-use flow row, both dialects |
| `src/db/portal-oauth-flows.ts` | Encrypted create / take / sweep. The only module that encrypts these rows |
| `src/gateway/portal/oauth.ts` | Start and finish a connect: prepare, store the flow, exchange, persist |
| `src/gateway/portal/integrations.ts` | What this deployment offers and what this account holds |
| `src/gateway/portal/api.ts` | Routes for the three API calls and the callback |
| `src/gateway/static.ts` | One static server, parameterised by root and prefix (panel and portal share it) |
| `src/gateway/portal/web/` | The React app: list, connect, disconnect, and where these apply |
| `src/agent/mcp-oauth/persist.ts` | Persist a connect for an owner already resolved |
| `src/gateway/core/gateway.ts` | The 1:1 entry check |
| `Dockerfile`, `.github/workflows/ci.yml` | Build both web apps into the image and check they build |

## Task order

Tasks 1–3 make a connect possible and replica-safe. Task 4 is the API the app needs, Task 5 the app. Task 6 is the nudge. Task 7 is the image defect, which must land before any deployment can serve the app. Tasks 8–9 finish.

---

### Task 1: The single-use flow row

**Files:**
- Create: `src/db/migrations/0009_portal_oauth_flows.sql`
- Modify: `src/db/drivers/sqlite.ts`, `tests/db/schema-drift.test.ts`
- Create: `src/db/portal-oauth-flows.ts`
- Test: `tests/db/portal-oauth-flows.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` from `src/db/crypto.ts`.
- Produces:
  - `interface PortalFlow { clientId: string; clientSecret?: string; verifier: string; tokenEndpoint: string; serverName: string; serverUrl: string; state: string }`
  - `createFlow(accountId: string, flow: PortalFlow, ttlMs?: number): Promise<string>` — returns the row id
  - `takeFlow(id: string, accountId: string): Promise<PortalFlow | null>` — reads AND deletes, atomically
  - `sweepExpiredFlows(now?: number): Promise<number>`

The row is the only place a client secret rests outside the credential store, so it is encrypted the same way and lives at most ten minutes.

- [ ] **Step 1: Write the failing test**

```ts
test("a flow round-trips for its own account", async () => {
  const id = await createFlow(accountId, flow("state-1"));
  expect((await takeFlow(id, accountId))?.state).toBe("state-1");
});

// Single use: a replayed callback must find nothing.
test("taking a flow consumes it", async () => {
  const id = await createFlow(accountId, flow("state-1"));
  expect(await takeFlow(id, accountId)).not.toBeNull();
  expect(await takeFlow(id, accountId)).toBeNull();
});

test("concurrent takes hand the flow to exactly one caller", async () => {
  const id = await createFlow(accountId, flow("state-1"));
  const outs = await Promise.all([takeFlow(id, accountId), takeFlow(id, accountId), takeFlow(id, accountId)]);
  expect(outs.filter(Boolean)).toHaveLength(1);
});

test("another account cannot take it", async () => {
  const id = await createFlow(accountId, flow("state-1"));
  expect(await takeFlow(id, otherAccountId)).toBeNull();
  expect(await takeFlow(id, accountId)).not.toBeNull();
});

test("an expired flow is gone", async () => {
  const id = await createFlow(accountId, flow("state-1"), -1);
  expect(await takeFlow(id, accountId)).toBeNull();
});

test("the client secret is not stored in plaintext", async () => {
  await createFlow(accountId, { ...flow("state-1"), clientSecret: "secret-in-flight" });
  const raw = await db.one<{ payload: string }>("SELECT payload FROM portal_oauth_flows");
  expect(raw!.payload).not.toContain("secret-in-flight");
  expect(raw!.payload.startsWith("v1:")).toBe(true);
});

test("deleting the account takes its flows with it", async () => { /* cascade */ });
test("sweeping removes expired rows and leaves live ones", async () => { /* … */ });
```

The concurrency test is the important one: `takeFlow` must be a conditional delete that returns the row, not a read followed by a delete.

- [ ] **Step 2: Run it and watch it fail** — `bun test tests/db/portal-oauth-flows.test.ts`

- [ ] **Step 3: Write the migration and the repo**

```sql
CREATE TABLE IF NOT EXISTS portal_oauth_flows (
  id         TEXT   PRIMARY KEY,
  account_id TEXT   NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  payload    TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
```

Add `"portal_oauth_flows"` to `NO_TENANT_TABLES` with its reason: it hangs off an account, which is deployment-global.

- [ ] **Step 4: Run tests on both dialects** — `bun test tests/db && bunx tsc --noEmit`, then the same against real Postgres.

- [ ] **Step 5: Commit**

---

### Task 2: Persist a connect for an owner already resolved

**Files:**
- Modify: `src/agent/mcp-oauth/persist.ts`
- Test: extend `tests/mcp-oauth/connect-persists.test.ts`

**Interfaces:**
- Produces: `persistConnectForOwner(owner: CredentialOwner, serverName: string, cfg: OAuthServerConfig, tokens: OAuthTokens): Promise<void>`

`persistConnect` resolves an owner from a Slack scope. The portal already knows the account, so it needs the same write without the resolution step. Both end in one place, so a portal connect and a 1:1 connect produce the identical row.

- [ ] **Step 1: Write the failing test** — a portal-style connect writes the same row a `/mcp connect` would, including the pinned token endpoint; and `persistConnect` still routes through the shared helper.
- [ ] **Steps 2–4:** fail, implement, `bun test tests/mcp-oauth && bunx tsc --noEmit`.
- [ ] **Step 5: Commit**

---

### Task 3: Start and finish a portal connect

**Files:**
- Create: `src/gateway/portal/oauth.ts`
- Modify: `src/gateway/portal/session.ts` (the flow cookie)
- Test: `tests/gateway/portal/oauth-connect.test.ts`

**Interfaces:**
- Consumes: `discover` and `prepareConnect`; Task 1's flow store; Task 2's persist.
- Produces:
  - `startPortalConnect(accountId, serverName, cfg): Promise<{ authorizeUrl: string; flowId: string }>`
  - `finishPortalConnect(accountId, flowId, code, state): Promise<{ ok: true } | { ok: false; reason: "no-flow" | "state-mismatch" | "exchange-failed" }>`
  - Cookie helpers: `PORTAL_FLOW_OAUTH_COOKIE`, minted and verified like the phase 2 portal session, carrying the flow id and nothing else.

Requirements, each with a test:

1. Starting a connect stores the flow and returns an authorize URL carrying the same `state` the row holds.
2. The cookie value carries the flow id only: no verifier, no client id, no secret. Assert on the decoded payload's exact keys.
3. Finishing with the right flow and state writes the credential for that account, with the token endpoint pinned as phase 3 expects.
4. A mismatched `state` writes nothing and consumes nothing.
5. A replayed callback finds no flow and writes nothing.
6. One account cannot finish another's flow.
7. A failed exchange reports failure without the provider's body, and leaves no credential.

---

### Task 4: The integrations API

**Files:**
- Create: `src/gateway/portal/integrations.ts`
- Modify: `src/gateway/portal/api.ts`, `src/gateway/core/gateway.ts` (pass the configured servers in)
- Test: `tests/gateway/portal/integrations-api.test.ts`

**Interfaces:**
- Produces: `GET /portal/api/integrations`, `POST /portal/api/integrations/:name/connect`, `GET /portal/oauth/callback`, `DELETE /portal/api/integrations/:name`.

The server list comes from the same configured HTTP MCP servers `/mcp` uses in Slack, so the two surfaces cannot disagree.

Requirements, each with a test:

1. The list shows every configured server, marks which this account holds, and contains no token.
2. An anonymous caller gets 401; a signed-in caller with no account gets an empty list rather than an error.
3. Connect and disconnect without the anti-CSRF header are refused before anything happens.
4. Connect refuses a server this deployment does not configure.
5. Disconnect removes only the caller's own credential, and reports plainly when there was nothing to remove.
6. The callback redirects back into the app on success and on every failure, with a result the page can render — never a raw error body.
7. Every route 404s when the portal is disabled.

---

### Task 5: The portal app

**Files:**
- Create: `src/gateway/portal/web/` (index.html, vite.config.ts, tsconfig.json, app)
- Create: `src/gateway/static.ts`; modify `src/gateway/panel/static.ts` to use it
- Modify: `src/gateway/portal/api.ts` (serve the app), `package.json` (`portal:dev`, `portal:build`)
- Test: `tests/gateway/portal/static.test.ts`

The page lists integrations with a connect or disconnect button each, shows who you are signed in as, and states plainly **where these credentials apply**: in your 1:1 with an agent, not in channel threads.

Requirements with tests: the shared static server refuses traversal outside its root, falls back to the shell for client routes, serves hashed assets as immutable and the shell as uncacheable, and does all of that for both prefixes.

---

### Task 6: The 1:1 entry check

**Files:**
- Modify: `src/gateway/core/gateway.ts`
- Test: `tests/gateway/portal/one-on-one-entry.test.ts`

When a 1:1 is opened and the Slack user is not linked, post the phase 2 onboarding link ephemerally. Requirements, each with a test:

1. Unlinked: exactly one ephemeral message, containing a link, visible to nobody else.
2. Linked: nothing posted.
3. The turn runs either way — onboarding never gates the agent.
4. Portal disabled: nothing posted, since there is nowhere to send them.
5. A surface that cannot post privately posts nothing at all, rather than putting a link in the channel.

---

### Task 7: Build the web apps into the image

**Files:**
- Modify: `Dockerfile`, `.github/workflows/ci.yml`, `deploy/k8s-local/verify-ha.sh`

The deployed image contains no built app today: `dist/` is gitignored and nothing builds it, so the panel has been serving Vite's source shell. Add the build to the builder stage, copy both `dist/` trees into the runtime image, and have CI build them so a broken app fails a pull request.

- [ ] **Verify it the way the defect was found:** from inside a running gateway pod, `/panel` and `/portal` must return HTML that references hashed assets, not `/src/main.tsx`, and those assets must exist. Add that as a check in `verify-ha.sh`.

---

### Task 8: Documentation

Field note covering: what phase 4 finishes; why the portal runs its own flow and why the client secret stays out of the browser; the replica-safety problem the original spec missed and that the Slack path still has it; and the image defect the React decision surfaced. Deploy docs for the portal's integrations page and the callback URL an operator must expect. Index it in `CLAUDE.md`.

---

### Task 9: Security pass

Walk and confirm against tests that exist:

1. No secret in the browser: cookie payload is an id only.
2. No token in a log, a thrown message, or an error body.
3. The owner is the session's account everywhere; no route takes an owner.
4. One account cannot read, connect, finish, or disconnect another's.
5. The flow row is single use, expiring, encrypted, and cascades with the account.
6. State mismatch and replay both write nothing.
7. Anti-CSRF on every mutating route.
8. Static serving refuses traversal for both prefixes.
9. Portal disabled means 404 everywhere, unchanged.

Then: full suite, typecheck, real Postgres, the local cluster's `verify-ha.sh`, and a manual pass through the portal against the running cluster.

## Out of scope

- Moving the Slack-side connect's pending flow to shared storage (§3.2). Recorded as follow-up.
- Changing where a person's credentials apply (§3.3).
- Operator-facing account administration in the panel.

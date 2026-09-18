# Phase 3 — user-scoped MCP credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person's MCP credentials are owned by the gateway, stored encrypted, and handed to a node as a pod-local working copy for the duration of a turn.

**Architecture:** The gateway is the durable authority. A node seeds a pod-local config directory at session start, runs the turn, and posts back any change the agent made at turn end. No credentials file is ever shared between processes.

**Tech Stack:** Bun + TypeScript, `bun test`, `bunx tsc --noEmit`, AES-256-GCM via `src/db/crypto.ts`, BullMQ over Redis, kustomize manifests.

**Spec:** `docs/superpowers/specs/2026-09-18-phase-3-user-scoped-mcp-credentials-design.md`

## Global Constraints

- **Credentials are never written in plaintext to any durable store.** Persist only through `encrypt()` from `src/db/crypto.ts` (AES-256-GCM, `SLAUDE_MASTER_KEY`, envelope `v1:iv:tag:ct`). The only plaintext column is `expires_at`, and only because expiry queries need it.
- **Credentials are never logged, and never appear in an error message, a thrown string, a metric label, or an HTTP error body.** Log the account id and the server key. Nothing else.
- **Credential files are mode `0600`** and live only under the node's pod-local config root. Nothing credential-bearing is written under `$SLAUDE_HOME`.
- **Per-user data never rides in the runtime bundle.** That bundle is keyed on (tenant, persona) and ETag-cached on the node.
- **Authorization is two-dimensional.** A job token grants access to one tenant *and* one initiator. Both are checked on every credential request.
- Public repo: no real names, employer names, internal channel names, or real Slack/team identifiers. Placeholders only (`UTESTUSER1`, `TTESTTEAM1`).
- Granular commits, one logical change each. No AI co-authorship trailers.
- Leak-scan every staged diff before committing, per `CLAUDE.md`.

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md` | Task 1 findings, then extended in Task 10 |
| `src/db/migrations/0008_mcp_credentials.sql` + `src/db/drivers/sqlite.ts` | The `mcp_credentials` table, both dialects |
| `src/db/mcp-credentials.ts` | Encrypted repo. The only module that calls `encrypt`/`decrypt` for these rows |
| `src/gateway/api/mcp-credentials.ts` | `GET`/`POST` handlers plus their authorization |
| `src/gateway/api/index.ts` | Route wiring |
| `src/gateway/core/gateway.ts`, `src/agent/mcp-oauth/*` | `/mcp connect` and `/mcp disconnect` persist to the store |
| `src/agent/config-root.ts` | `nodeConfigRoot()` — the one accessor for the pod-local root |
| `src/agent/oauth-home.ts` | `initiatorConfigDir` resolves under that root |
| `src/node/credentials.ts` | Seed, diff, write-back. All node-side credential handling |
| `src/node/worker.ts` | Calls seed at session start and write-back at turn end |
| `deploy/k8s-scale/50-node.yaml` | The `emptyDir` config volume |

---

### Task 1: Find out whether an auth failure can reach us

**Files:**
- Create: `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md`
- Probe scripts are throwaway; put them in the scratchpad, not the repo.

**Interfaces:**
- Consumes: nothing.
- Produces: a written answer to the two questions below, and a decision recorded in the field note. **Task 8 cannot be written until this is answered.**

This task runs first because its outcome changes what Task 8 builds. Do not start it by writing code.

The design in the spec is seed-then-write-back, which handles refresh only between turns. If the agent's auth failures are observable, and if the agent notices a rewritten credentials file, a much better lever exists: refresh at the gateway and let the running turn pick it up. Two questions decide it.

**Question A — does a 401/403 from an MCP server reach slaude?** `AgentEvent` (`src/agent/manager.ts:65-74`) has `toolResult` with `result: unknown` and a generic `error`. Find out whether an MCP tool call that fails authorization surfaces there, and whether the payload is distinguishable from an ordinary tool error. If it is not distinguishable, say so plainly — a heuristic on error text is not an answer.

**Question B — does the agent re-read the credentials file mid-session?** There is strong evidence it polls: the binary contains a function that stats `.credentials.json`, compares `mtimeMs` against a cached value, and clears caches on change, plus a poller with a ~2000ms default interval. Confirm whether that path covers the `mcpOAuth` subtree or only the Anthropic user credentials.

**A third lever, worth checking while you are in there:** the permission resolver (`PermissionResolver`, `src/agent/manager.ts:77-82`) runs *before* every tool use. If MCP tool names are identifiable there, a node can check expiry and refresh proactively, which beats reacting to a failure.

- [ ] **Step 1: Read the two code paths before touching a pod**

Read `src/agent/manager.ts:60-110` for the event union and the resolver signature, and `src/node/worker.ts:140-200` for how the node already observes events and resolves child env. You need to know what the node can see before deciding what to measure.

- [ ] **Step 2: Extract the agent's credential-polling code**

The binary is at `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude` inside a node pod. `strings` is not installed; `grep -a` works.

```sh
POD=$(kubectl -n slaude-scale get pod -l app.kubernetes.io/component=node -o name | head -1)
kubectl -n slaude-scale exec "$POD" -- sh -c \
  'grep -a -o -E ".{200}mtimeMs.{400}" /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude' | head -5
```

Trace outward from the cache-clearing function to see which caches it clears, and whether the MCP credential lookup reads through one of them.

- [ ] **Step 3: Measure the mtime pickup directly**

Do not reason about it from the decompiled source alone. In a pod, seed a config directory with an MCP entry, start a session against a stub HTTP MCP server that returns 401 for a known-bad token and 200 for a known-good one, rewrite `.credentials.json` with the good token mid-session, and see whether the next tool call succeeds without restarting the session.

Run it on the pod-local filesystem, not the shared volume, because that is where the file will live.

- [ ] **Step 4: Measure what the failure looks like to slaude**

With the stub server returning 401, capture every `AgentEvent` the node emits for that turn. Record the exact `toolResult` payload shape verbatim in the field note. If the status code is absent, say that.

- [ ] **Step 5: Write the field note and record the decision**

Write `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md` covering: the rename-replaces-symlink measurement from the spec, the agent's own rotation behaviour, and both answers from this task. State the chosen Task 8 branch explicitly:

- **Branch R (reactive)** if A is yes: on an identifiable auth failure the node asks the gateway to refresh, rewrites the local file, and the turn recovers. Requires B to be yes as well, otherwise the running agent never sees the new token.
- **Branch P (proactive)** if A is no but B is yes: before a tool call, or on a short timer, the node refreshes anything near expiry through the gateway and rewrites the file.
- **Branch S (seed only)** if both are no: the spec's design stands unchanged, refresh happens only between turns, and the field note states that a mid-turn expiry costs the person a retry.

- [ ] **Step 6: Commit**

```bash
git add docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md
git commit -m "docs(findings): whether an MCP auth failure can reach slaude"
```

---

### Task 2: The encrypted credential store

**Files:**
- Create: `src/db/migrations/0008_mcp_credentials.sql`
- Modify: `src/db/drivers/sqlite.ts` (bootstrap DDL, beside `slack_identities`)
- Modify: `tests/db/schema-drift.test.ts` (`NO_TENANT_TABLES`)
- Create: `src/db/mcp-credentials.ts`
- Test: `tests/db/mcp-credentials.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `src/db/crypto.ts`; `AccountRow` from `src/db/accounts.ts`.
- Produces:
  - `interface McpCredential { serverKey: string; entry: StoredEntry; expiresAt: number; updatedAt: number }`
  - `putCredential(accountId: string, serverKey: string, entry: StoredEntry): Promise<void>`
  - `credentialsForAccount(accountId: string): Promise<McpCredential[]>`
  - `deleteCredential(accountId: string, serverKey: string): Promise<boolean>`

`StoredEntry` is the existing shape from `src/agent/mcp-oauth/store.ts:105-116`. Import it rather than redeclaring it, so the wire format and the file format cannot drift.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";

const ISS = "https://idp.example.com";
const entry = (token: string, expiresAt = Date.now() + 3600_000) => ({
  serverName: "workbench",
  serverUrl: "https://mcp.example.com",
  accessToken: token,
  refreshToken: "r-1",
  expiresAt,
});

let accountId: string;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  accountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
});

describe("mcp credential store", () => {
  test("round-trips an entry", async () => {
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-1"));
    const rows = await Creds.credentialsForAccount(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry.accessToken).toBe("tok-1");
  });

  // The property that matters: a database dump must not contain the token.
  test("the token is not stored in plaintext", async () => {
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-super-secret"));
    const raw = await db.one<{ payload: string }>(
      "SELECT payload FROM mcp_credentials WHERE account_id = ?", [accountId],
    );
    expect(raw!.payload).not.toContain("tok-super-secret");
    expect(raw!.payload.startsWith("v1:")).toBe(true);
  });

  test("expiry is queryable without decrypting", async () => {
    const at = Date.now() + 1234;
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-1", at));
    const raw = await db.one<{ expires_at: number }>(
      "SELECT expires_at FROM mcp_credentials WHERE account_id = ?", [accountId],
    );
    expect(Number(raw!.expires_at)).toBe(at);
  });

  test("writing the same server key replaces, never duplicates", async () => {
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-1"));
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-2"));
    const rows = await Creds.credentialsForAccount(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry.accessToken).toBe("tok-2");
  });

  test("one account's credentials are never returned for another", async () => {
    const other = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" })).id;
    await Creds.putCredential(accountId, "workbench|abc", entry("mine"));
    expect(await Creds.credentialsForAccount(other)).toHaveLength(0);
  });

  test("deleting the account takes the credentials with it", async () => {
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-1"));
    await db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
    const left = await db.query("SELECT * FROM mcp_credentials WHERE account_id = ?", [accountId]);
    expect(left).toHaveLength(0);
  });

  test("a corrupt payload is reported, not returned as a usable entry", async () => {
    await Creds.putCredential(accountId, "workbench|abc", entry("tok-1"));
    await db.run("UPDATE mcp_credentials SET payload = ? WHERE account_id = ?", ["v1:aa:bb:cc", accountId]);
    expect(await Creds.credentialsForAccount(accountId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/mcp-credentials.test.ts`
Expected: FAIL — no such table `mcp_credentials`.

- [ ] **Step 3: Write the migration**

`src/db/migrations/0008_mcp_credentials.sql`:

```sql
-- A person's MCP OAuth credentials, owned by the gateway.
--
-- Keyed on the account rather than the Slack user id: one person with two
-- workspaces has one set of integrations. Payload is AES-256-GCM (src/db/crypto.ts);
-- expires_at is the only plaintext field, and only so expiry is queryable
-- without decrypting every row.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  account_id TEXT   NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  server_key TEXT   NOT NULL,
  payload    TEXT   NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, server_key)
);
```

Add the same DDL to `src/db/drivers/sqlite.ts` beside the `slack_identities` block, with `INTEGER` in place of `BIGINT` to match that file's convention.

Add `"mcp_credentials"` to `NO_TENANT_TABLES` in `tests/db/schema-drift.test.ts`, with a comment: the account is deployment-global, so tenancy is reached through `accounts`, not a column here.

- [ ] **Step 4: Write the repo**

`src/db/mcp-credentials.ts`. Every function parameterises its SQL. `credentialsForAccount` wraps `decrypt` in try/catch per row and, on failure, logs the account id and server key — never the payload — and omits the row.

```ts
export async function putCredential(accountId: string, serverKey: string, entry: StoredEntry): Promise<void> {
  const now = Date.now();
  await db.run(
    `INSERT INTO mcp_credentials (account_id, server_key, payload, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, server_key)
     DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    [accountId, serverKey, encrypt(JSON.stringify(entry)), entry.expiresAt, now],
  );
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/db && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/0008_mcp_credentials.sql src/db/drivers/sqlite.ts src/db/mcp-credentials.ts tests/db/mcp-credentials.test.ts tests/db/schema-drift.test.ts
git commit -m "feat(db): encrypted store for a person's MCP credentials"
```

---

### Task 3: The control-plane endpoints

**Files:**
- Create: `src/gateway/api/mcp-credentials.ts`
- Modify: `src/gateway/api/index.ts` (routes, beside the runtime routes at `:75-96`)
- Test: `tests/gateway/api/mcp-credentials.test.ts`

**Interfaces:**
- Consumes: Task 2's repo; `requireJobToken` and `JobClaims` from `src/gateway/api/auth.ts:21-36`; `accountForSlackUser` from `src/db/accounts.ts`.
- Produces:
  - `GET  /v1/tenants/:tenant/users/:slackUserId/mcp-credentials` → `{ entries: Record<string, StoredEntry> }`
  - `POST /v1/tenants/:tenant/users/:slackUserId/mcp-credentials` ← `{ entries: Record<string, StoredEntry> }`

The authorization is the whole security story for this surface, so it gets its own tests. A job token carries both `tenant` and `initiator` (`JobClaims`, `src/gateway/api/auth.ts:21-36`). Both must match, following the pattern the per-persona runtime route already set at `src/gateway/api/index.ts:85-96`.

A person with no account, or with no credentials, gets `{ entries: {} }` and a 200. That is not an error, and distinguishing the two cases in the response would tell a caller whether an account exists.

- [ ] **Step 1: Write the failing test**

```ts
test("a node reads the credentials for the user its token is scoped to", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(get("/v1/tenants/t1/users/UTESTUSER1/mcp-credentials", token));
  expect(res!.status).toBe(200);
  expect((await res!.json()).entries["workbench|abc"].accessToken).toBe("tok-1");
});

// The one that matters. A node running a turn for one person must not be able
// to read another person's credentials by changing the path.
test("a token for one user is refused another user's credentials", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(get("/v1/tenants/t1/users/UTESTUSER2/mcp-credentials", token));
  expect(res!.status).toBe(403);
  expect(await res!.text()).not.toContain("tok-");
});

test("a token for one tenant is refused another tenant's path", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(get("/v1/tenants/t2/users/UTESTUSER1/mcp-credentials", token));
  expect(res!.status).toBe(403);
});

test("an unauthenticated request is refused", async () => {
  const res = await api.fetch(new Request("https://gw/v1/tenants/t1/users/UTESTUSER1/mcp-credentials"));
  expect(res!.status).toBe(401);
});

test("a user with no account gets an empty set, not an error", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER9" });
  const res = await api.fetch(get("/v1/tenants/t1/users/UTESTUSER9/mcp-credentials", token));
  expect(res!.status).toBe(200);
  expect((await res!.json()).entries).toEqual({});
});

test("write-back persists under the caller's own account", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(post("/v1/tenants/t1/users/UTESTUSER1/mcp-credentials", token, {
    entries: { "workbench|abc": entry("tok-rotated") },
  }));
  expect(res!.status).toBe(200);
  const rows = await Creds.credentialsForAccount(accountId);
  expect(rows[0]!.entry.accessToken).toBe("tok-rotated");
});

test("write-back cannot target another user", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(post("/v1/tenants/t1/users/UTESTUSER2/mcp-credentials", token, {
    entries: { "workbench|abc": entry("planted") },
  }));
  expect(res!.status).toBe(403);
  expect(await Creds.credentialsForAccount(otherAccountId)).toHaveLength(0);
});

// A stale write must not undo a newer rotation from another node.
test("an older entry does not overwrite a newer one", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  await Creds.putCredential(accountId, "workbench|abc", entry("newer", Date.now() + 7200_000));
  await api.fetch(post("/v1/tenants/t1/users/UTESTUSER1/mcp-credentials", token, {
    entries: { "workbench|abc": entry("older", Date.now() + 60_000) },
  }));
  const rows = await Creds.credentialsForAccount(accountId);
  expect(rows[0]!.entry.accessToken).toBe("newer");
});

test("a malformed entry is rejected without writing anything", async () => {
  const token = jobToken({ tenant: "t1", initiator: "UTESTUSER1" });
  const res = await api.fetch(post("/v1/tenants/t1/users/UTESTUSER1/mcp-credentials", token, {
    entries: { "workbench|abc": { serverName: "workbench" } },
  }));
  expect(res!.status).toBe(400);
  expect(await Creds.credentialsForAccount(accountId)).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/api/mcp-credentials.test.ts`
Expected: FAIL — the route returns 404.

- [ ] **Step 3: Write the handler and wire the routes**

In `src/gateway/api/index.ts`, beside the runtime routes:

```ts
      // /v1/tenants/:id/users/:slackUserId/mcp-credentials — per-user, so the
      // token must be scoped to BOTH the tenant and the initiator. Deliberately
      // not part of the runtime bundle: that bundle is keyed on (tenant, persona)
      // and ETag-cached on the node, and per-user credentials must never sit in
      // a cache keyed more coarsely than the user.
      if (seg.length === 6 && seg[1] === "tenants" && seg[3] === "users" && seg[5] === "mcp-credentials") {
        if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) {
          return json(403, { error: "job token is not scoped to this tenant" });
        }
        if (job.claims.initiator !== seg[4]!) {
          return json(403, { error: "job token is not scoped to this user" });
        }
        return await handleMcpCredentials(req, seg[2]!, seg[4]!);
      }
```

In `src/gateway/api/mcp-credentials.ts`, validate every entry before writing: `serverName`, `serverUrl` and `accessToken` must be non-empty strings and `expiresAt` a number. Reject the whole request on the first bad entry so a partial write cannot happen. Take the per-account Redis lock around the write.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/gateway && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/api/mcp-credentials.ts src/gateway/api/index.ts tests/gateway/api/mcp-credentials.test.ts
git commit -m "feat(api): per-user MCP credential endpoints, scoped to tenant and initiator"
```

---

### Task 4: /mcp connect and disconnect write to the store

**Files:**
- Modify: `src/gateway/core/gateway.ts` (the `/mcp` handler branch — `connectServer` and the disconnect path)
- Modify: `src/agent/mcp-oauth/store.ts` (a seam so the caller chooses the destination)
- Test: `tests/mcp-oauth/connect-persists.test.ts`

**Interfaces:**
- Consumes: Task 2's `putCredential` / `deleteCredential`; `accountForSlackUser` from `src/db/accounts.ts`.
- Produces: nothing new for later tasks to import. This task makes the store the authority in fact rather than only on paper.

Without this, the gateway would serve credentials it never receives: `/mcp connect` runs on the gateway and writes the token to a config directory on disk, while Task 3's endpoint reads from the database. Task 6 would seed an empty set for everyone.

Connect stays on the gateway. Only its destination changes.

- [ ] **Step 1: Write the failing test**

```ts
test("a completed connect lands in the credential store, keyed on the account", async () => {
  const account = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
  await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: account.id, via: "signed-link" });

  await persistConnect({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", serverName: "workbench", cfg, entry: entry("tok-1") });

  const rows = await Creds.credentialsForAccount(account.id);
  expect(rows[0]!.entry.accessToken).toBe("tok-1");
});

// Someone can connect before they have onboarded. That must not throw, and it
// must not silently drop the token either.
test("a slack user with no account gets a told-you-so, not a silent drop", async () => {
  const r = await persistConnect({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER9", serverName: "workbench", cfg, entry: entry("tok-1") });
  expect(r.ok).toBe(false);
  expect(r.reason).toBe("no-account");
});

test("disconnect removes the row", async () => {
  const account = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
  await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: account.id, via: "signed-link" });
  await persistConnect({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", serverName: "workbench", cfg, entry: entry("tok-1") });

  await persistDisconnect({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", serverName: "workbench", cfg });

  expect(await Creds.credentialsForAccount(account.id)).toHaveLength(0);
});

test("the global scope still writes the agent's own shared identity to disk", async () => {
  // Unchanged behaviour: a manager wiring the agent's shared identity is not a
  // per-user credential and does not belong in the per-account store.
  await connectServer({ scope: "global", serverName: "workbench", serverCfg: cfg, /* … */ });
  expect(readEntry(agentConfigDir(), "workbench", cfg)?.accessToken).toBe("tok-1");
  expect(await Creds.credentialsForAccount(account.id)).toHaveLength(0);
});
```

The last test is the boundary that keeps this from over-reaching: `/mcp connect` outside a 1:1 wires the *agent's* shared identity, which is not anyone's personal credential and stays exactly where it is.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp-oauth/connect-persists.test.ts`
Expected: FAIL — `persistConnect` does not exist.

- [ ] **Step 3: Write the implementation**

Add `persistConnect` and `persistDisconnect` alongside the existing store functions. They resolve the account through `accountForSlackUser(teamId, slackUserId)` and call Task 2's repo. When there is no account, return `{ ok: false, reason: "no-account" }` so the gateway can tell the person to run `/link` first, rather than writing a credential nobody can later resolve.

In the gateway's `/mcp` branch, the initiator scope calls these; the global scope is untouched.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/mcp-oauth tests/gateway && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/gateway.ts src/agent/mcp-oauth/store.ts tests/mcp-oauth/connect-persists.test.ts
git commit -m "feat(mcp): a personal connect persists to the credential store"
```

---

### Task 5: The pod-local config root

**Files:**
- Create: `src/agent/config-root.ts`
- Modify: `src/agent/oauth-home.ts:70-78` (`initiatorConfigDir`)
- Test: `tests/agent/config-root.test.ts`, and extend `tests/oauth-home.test.ts`

**Interfaces:**
- Consumes: `env.role()` from `src/config/env.ts`; `paths` from `src/config/home.ts` (the module `oauth-home.ts` already imports).
- Produces: `nodeConfigRoot(): string` — the base for per-initiator config homes. `$SLAUDE_NODE_CONFIG_ROOT` when set, else `/config-home` in the node role, else `paths.home` (unchanged for mono and gateway).

One accessor, so there is one place to change if this moves again. `initiatorConfigDir` is the only caller.

- [ ] **Step 1: Write the failing test**

```ts
test("the node role defaults to the pod-local root", () => {
  process.env.SLAUDE_ROLE = "node";
  delete process.env.SLAUDE_NODE_CONFIG_ROOT;
  expect(nodeConfigRoot()).toBe("/config-home");
});

test("an explicit root wins", () => {
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_NODE_CONFIG_ROOT = "/tmp/elsewhere";
  expect(nodeConfigRoot()).toBe("/tmp/elsewhere");
});

test("mono and gateway keep using SLAUDE_HOME, so single-process deploys are untouched", () => {
  process.env.SLAUDE_ROLE = "mono";
  delete process.env.SLAUDE_NODE_CONFIG_ROOT;
  expect(nodeConfigRoot()).toBe(paths.home);
});

// The point of the whole task: no credential-bearing path under the shared volume.
test("a node's initiator config dir is not under SLAUDE_HOME", () => {
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_NODE_CONFIG_ROOT = "/tmp/pod-local";
  expect(initiatorConfigDir("UTESTUSER1")).not.toContain(paths.home);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/config-root.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/** Base for per-initiator config homes.
 *
 *  Credentials must not live on the shared volume: the agent's own credential
 *  write renames over the path, which replaces a symlink with a regular file and
 *  silently un-shares it (measured — see the field note). A pod-local root gives
 *  the file exactly one owner, which makes that rename harmless.
 *
 *  Only the node role moves. mono and gateway keep $SLAUDE_HOME, so a
 *  single-process deployment is byte-identical to today. */
export function nodeConfigRoot(): string {
  const explicit = process.env.SLAUDE_NODE_CONFIG_ROOT?.trim();
  if (explicit) return explicit;
  return env.role() === "node" ? "/config-home" : paths.home;
}
```

In `initiatorConfigDir`, replace `paths.home` with `nodeConfigRoot()`. Leave `personaConfigDir` and `agentConfigDir` alone: the persona home holds soul and skills, not credentials, and must stay shared.

- [ ] **Step 4: Verify the transcript symlink still lands on the shared volume**

`ensureInitiatorConfigDir` (`src/agent/oauth-home.ts:86-128`) symlinks `projects/` at the base config home. Confirm with a test that with a pod-local root the symlink target is still the persona or agent home under `$SLAUDE_HOME`, so transcripts stay durable.

```ts
test("transcripts still resolve onto the shared volume", () => {
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_NODE_CONFIG_ROOT = tmpRoot;
  const dir = ensureInitiatorConfigDir("UTESTUSER1");
  expect(readlinkSync(join(dir, "projects"))).toContain(paths.home);
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/agent tests/oauth-home.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/config-root.ts src/agent/oauth-home.ts tests/agent/config-root.test.ts tests/oauth-home.test.ts
git commit -m "feat(agent): per-initiator config homes move off the shared volume on nodes"
```

---

### Task 6: Seed at session start

**Files:**
- Create: `src/node/credentials.ts`
- Modify: `src/node/client.ts` (a `getMcpCredentials` method beside `getRuntime` at `:151-166`)
- Modify: `src/node/worker.ts` (call the seed where the session's config dir is prepared)
- Test: `tests/node/credentials-seed.test.ts`

**Interfaces:**
- Consumes: Task 3's `GET` endpoint, Task 5's `nodeConfigRoot`, `writeEntry` from `src/agent/mcp-oauth/store.ts`.
- Produces:
  - `seedCredentials(i: { configDir: string; entries: Record<string, StoredEntry> }): Promise<void>`
  - `snapshotCredentials(configDir: string): Record<string, StoredEntry>`

The node's cache for these is keyed on the user and is **not** shared with the runtime-bundle cache. Do not add an ETag here: a credential that changed is exactly the case that must not be served from cache.

- [ ] **Step 1: Write the failing test**

```ts
test("seeding writes the entries into the config dir at 0600", async () => {
  await seedCredentials({ configDir: dir, entries: { "workbench|abc": entry("tok-1") } });
  const st = statSync(join(dir, ".credentials.json"));
  expect(st.mode & 0o777).toBe(0o600);
  expect(snapshotCredentials(dir)["workbench|abc"]!.accessToken).toBe("tok-1");
});

test("seeding preserves entries the agent owns", async () => {
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "agent-own" } }), { mode: 0o600 });
  await seedCredentials({ configDir: dir, entries: { "workbench|abc": entry("tok-1") } });
  const raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
  expect(raw.claudeAiOauth.accessToken).toBe("agent-own");
  expect(raw.mcpOAuth["workbench|abc"].accessToken).toBe("tok-1");
});

test("an empty set leaves no credentials behind from a previous session", async () => {
  await seedCredentials({ configDir: dir, entries: { "workbench|abc": entry("tok-1") } });
  await seedCredentials({ configDir: dir, entries: {} });
  expect(snapshotCredentials(dir)).toEqual({});
});

test("the seeded path is pod-local, never under the shared volume", async () => {
  expect(dir).not.toContain(paths.home);
});
```

The second test is the one to get right: the file is shared with the agent's own Anthropic credentials, so seeding is a read-modify-write of the `mcpOAuth` subtree only, never a whole-file replace.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/node/credentials-seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`seedCredentials` reads the existing file when present, replaces only `mcpOAuth`, and writes through the same symlink-resolving atomic write that `writeEntry` already uses (`resolveCredentialTarget`, from phase 0). `snapshotCredentials` returns the `mcpOAuth` subtree or `{}`.

In `src/node/client.ts`, add `getMcpCredentials(tenant, slackUserId, jobToken)` following the shape of `getRuntime` but with no ETag cache.

In `src/node/worker.ts`, call the seed at session start, after the config dir is resolved and before the first turn runs. The Slack user comes from the job's initiator, which the worker already has.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/node && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/node/credentials.ts src/node/client.ts src/node/worker.ts tests/node/credentials-seed.test.ts
git commit -m "feat(node): seed a session's MCP credentials from the gateway"
```

---

### Task 7: Write back at turn end

**Files:**
- Modify: `src/node/credentials.ts` (diff + write-back)
- Modify: `src/node/worker.ts` (call it on turn end, beside the existing `turnWaiters` handling at `:176-190`)
- Test: `tests/node/credentials-writeback.test.ts`

**Interfaces:**
- Consumes: Task 3's `POST`, Task 6's `snapshotCredentials`.
- Produces: `changedEntries(before, after): Record<string, StoredEntry>` — entries that are new or whose `accessToken` or `expiresAt` differ.

Write back at **turn end, not session end**. That is what bounds a lost rotation to one turn when a pod dies.

- [ ] **Step 1: Write the failing test**

```ts
test("an unchanged turn posts nothing", async () => {
  const before = { "workbench|abc": entry("tok-1") };
  expect(changedEntries(before, { ...before })).toEqual({});
});

test("a rotated token is detected", () => {
  const before = { "workbench|abc": entry("tok-1") };
  const after = { "workbench|abc": entry("tok-2") };
  expect(Object.keys(changedEntries(before, after))).toEqual(["workbench|abc"]);
});

test("a newly connected server is detected", () => {
  expect(Object.keys(changedEntries({}, { "gh|xyz": entry("tok-1") }))).toEqual(["gh|xyz"]);
});

test("a turn that rotates a token posts it back once", async () => {
  const posts = await runTurnWith({ rotateTo: "tok-2" });
  expect(posts).toHaveLength(1);
  expect(posts[0].entries["workbench|abc"].accessToken).toBe("tok-2");
});

// A failed write-back must never take the turn down with it.
test("a failing write-back is logged, not thrown", async () => {
  const { errors } = await runTurnWith({ rotateTo: "tok-2", postFails: true });
  expect(errors.some((e) => e.includes("tok-2"))).toBe(false);
});
```

The last test also pins the no-logging rule: the failure is reported without the token in it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/node/credentials-writeback.test.ts`
Expected: FAIL — `changedEntries` is not exported.

- [ ] **Step 3: Write the implementation**

Compare on `accessToken` and `expiresAt` only. A deep comparison would post back on irrelevant churn; comparing tokens is what identifies a rotation.

The write-back is fire-and-forget with respect to the turn: `await` it, but catch and log rather than propagate. The turn has already succeeded, and failing it because a credential could not be persisted would be a worse outcome than a lost rotation.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/node && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/node/credentials.ts src/node/worker.ts tests/node/credentials-writeback.test.ts
git commit -m "feat(node): post a turn's credential changes back to the gateway"
```

---

### Task 8: Refresh — branch chosen by Task 1

**Files:** depend on the branch. Test either way: `tests/node/credentials-refresh.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6 and 7, plus Task 1's recorded decision.

**Do not start this task until Task 1's field note names a branch.** Implement only that branch, and open the pull request describing which one and why.

**Branch R — reactive.** The node watches `AgentEvent` for the auth-failure shape Task 1 recorded verbatim, asks the gateway to refresh that server key, rewrites the pod-local file, and lets the agent's file poll pick it up. Tests: an auth failure triggers exactly one refresh; two failures in the same turn for one server coalesce into one; a failure for a server with no refresh token surfaces a reconnect prompt rather than looping.

**Branch P — proactive.** Before a tool call, or on a timer no shorter than the agent's own poll interval, the node refreshes anything inside its expiry window through the gateway and rewrites the file. Tests: an entry near expiry is refreshed once; an entry far from expiry is not touched; the refresh happens through the gateway, never in the node.

**Branch S — seed only.** No new code. Add a test pinning that a mid-turn expiry surfaces as a normal tool failure and that the next turn seeds a refreshed credential, and state the retry cost in the deploy docs.

In every branch the gateway performs the refresh. A node never holds a client secret and never talks to the identity provider.

- [ ] **Step 1: Re-read Task 1's field note and state the branch in this task's commit message**
- [ ] **Step 2: Write the failing tests for that branch**
- [ ] **Step 3: Run them and confirm they fail**
- [ ] **Step 4: Implement**
- [ ] **Step 5: Run `bun test && bunx tsc --noEmit`**
- [ ] **Step 6: Commit**

---

### Task 9: Manifests and deployment

**Files:**
- Modify: `deploy/k8s-scale/50-node.yaml` (the `emptyDir` volume and its mount)
- Modify: `docs/site/_content/deploy/multi-node.md`
- Test: `deploy/k8s-local/verify-ha.sh` (extend)

**Interfaces:**
- Consumes: Task 5's `SLAUDE_NODE_CONFIG_ROOT`.

- [ ] **Step 1: Add the volume**

```yaml
            - name: config-home
              mountPath: /config-home
        # Pod-local, never the shared volume: the agent's credential write
        # renames over the path, and a shared file would be silently un-shared.
        # Nothing durable lives here — transcripts stay on slaude-home through
        # the projects/ symlink.
        - name: config-home
          emptyDir: {}
```

- [ ] **Step 2: Extend the HA verification**

Add a check to `deploy/k8s-local/verify-ha.sh` asserting that no node pod has a `.credentials.json` anywhere under `/data`. That is the regression this whole phase exists to prevent, and it is cheap to check:

```sh
kubectl -n "$NS" exec "$pod" -- sh -c 'find /data -name ".credentials.json" | head -1'
```

Expected: empty. Fail the script if anything is found.

- [ ] **Step 3: Document it**

In the multi-node deploy page: nodes need a writable pod-local path for `SLAUDE_NODE_CONFIG_ROOT`, an `emptyDir` is the intended shape, the shared volume must stay ReadWriteMany for transcripts, and `SLAUDE_MASTER_KEY` is now required on the gateway for credential storage. State plainly that losing a node pod mid-turn can cost a token rotation and the person reconnects.

- [ ] **Step 4: Run it**

Run: `./deploy/k8s-local/up.sh && ./deploy/k8s-local/verify-ha.sh`
Expected: PASS, including the new check.

- [ ] **Step 5: Commit**

```bash
git add deploy/k8s-scale/50-node.yaml deploy/k8s-local/verify-ha.sh docs/site/_content/deploy/multi-node.md
git commit -m "feat(deploy): pod-local config volume for nodes, and a guard against credentials on the shared volume"
```

---

### Task 10: Documentation and the security pass

**Files:**
- Modify: `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md` (extend Task 1's note)
- Modify: `CLAUDE.md` (Findings Log index, newest first)

- [ ] **Step 1: Finish the field note**

Extend it with what was built and why: gateway as authority, pod-local working copy, write-back at turn end, and the accepted cost. Mechanism only — no deployment specifics.

- [ ] **Step 2: Run the credential-leak check**

Grep the whole diff for anything that could put a token into a log or an error:

```sh
git diff main...HEAD -U0 | grep -nE '(console\.(log|warn|error)|throw new Error).*(accessToken|refreshToken|payload|entry\b)'
```

Expected: no hits. Any hit is a bug to fix before the pull request, not a finding to note.

- [ ] **Step 3: Confirm the security properties hold**

Walk this list and confirm each with a test that exists:

1. No token is stored in plaintext anywhere durable.
2. No token reaches a log line, an error message or an HTTP error body.
3. A job token for one user cannot read or write another user's credentials.
4. A job token for one tenant cannot reach another tenant's path.
5. Credentials never enter the runtime bundle or its ETag cache.
6. No credential-bearing file exists under the shared volume on any node.
7. The credentials file is mode `0600`.
8. Deleting an account deletes its credentials.
9. A node never holds a client secret and never talks to the identity provider.

- [ ] **Step 4: Index the field note**

One line at the top of the Findings Log list in `CLAUDE.md`, matching the existing format.

- [ ] **Step 5: Full verification**

Run: `bun test && bunx tsc --noEmit`, then the repository leak scan over the staged diff.
Expected: tests PASS, scan prints `clean`.

- [ ] **Step 6: Commit**

```bash
git add docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md CLAUDE.md
git commit -m "docs: field note on gateway-owned MCP credentials"
```

---

## Out of scope

- The Anthropic provider credentials the agent uses for the model. Those reach the node through the runtime bundle as environment variables, and that path is untouched.
- Key rotation for `SLAUDE_MASTER_KEY`. The ciphertext envelope is versioned so a `v2:` can be introduced later without a data migration.
- An operator view of who has connected what. Self-service in the portal covers the common case.
- Phase 4's automatic onboarding prompt on 1:1 entry.

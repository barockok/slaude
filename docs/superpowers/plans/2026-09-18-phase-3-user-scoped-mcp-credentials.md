# Phase 3 — unified MCP credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every MCP credential — the agent's own shared identity and each person's — is owned by the gateway, stored encrypted, and handed to a node as a pod-local working copy for the duration of a turn.

**Architecture:** The gateway decides at dispatch whose identity a turn runs as and signs it into the job token as `runAs`. The node seeds a pod-local config directory with that owner's credentials, runs the turn, and posts back any change the agent made. No credentials file is ever shared between processes, and no owner is ever taken from a request path.

**Tech Stack:** Bun + TypeScript, `bun test`, `bunx tsc --noEmit`, AES-256-GCM via `src/db/crypto.ts`, BullMQ over Redis, kustomize manifests.

**Spec:** `docs/superpowers/specs/2026-09-18-phase-3-user-scoped-mcp-credentials-design.md`

## Global Constraints

These bind every task that touches a credential. A task that violates one is not done, whatever its tests say.

- **Never plaintext at rest.** Persist only through `encrypt()` from `src/db/crypto.ts` (AES-256-GCM, `SLAUDE_MASTER_KEY`, envelope `v1:iv:tag:ct`). The only plaintext column is `expires_at`, and only because expiry queries need it.
- **Never in a log, an error, or a response it does not belong in.** No token in a log line, a thrown message, a metric label, or an HTTP error body. Log the owner kind, an owner id and the server key. Nothing else.
- **Mode `0600`, pod-local only.** Credential files live only under the node's pod-local config root. Nothing credential-bearing is written under `$SLAUDE_HOME` on a node.
- **The owner comes only from a signed claim.** The credential endpoint takes no owner in its path or body. It serves the job token's `runAs` owner and nothing else. A token without `runAs` is refused, never defaulted.
- **`runAs` is decided once, at dispatch, by `resolveEffectiveIdentity`** (`src/agent/manager.ts:269-276`). The node uses the claim; it never re-derives the owner independently.
- **Per-owner data never rides in the runtime bundle.** That bundle is keyed on (tenant, persona) and ETag-cached on the node.
- **A node holds access tokens only.** The node-facing endpoint returns an allowlisted projection; the refresh token and client secret never leave the gateway. A node never talks to an identity provider, and has no endpoint through which to write a credential.
- Public repo: no real names, employer names, internal channel names, or real Slack/team identifiers. Placeholders only (`UTESTUSER1`, `TTESTTEAM1`).
- Granular commits, one logical change each. No AI co-authorship trailers. Leak-scan every staged diff per `CLAUDE.md`.

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md` | Task 1 findings, extended in Task 13 |
| `src/db/migrations/0008_mcp_credentials.sql` + `src/db/drivers/sqlite.ts` | The `mcp_credentials` table, both dialects |
| `src/db/mcp-credentials.ts` | Encrypted repo, both owner kinds. The only module that calls `encrypt`/`decrypt` for these rows |
| `src/agent/credential-owner.ts` | The `CredentialOwner` type and the `runAs` encode/parse pair |
| `src/gateway/api/auth.ts`, `src/gateway/core/dispatch.ts` | The `runAs` claim, minted at dispatch |
| `src/gateway/api/mcp-credentials.ts` + `src/gateway/api/index.ts` | `GET`/`POST` handlers and routing |
| `src/gateway/core/gateway.ts`, `src/agent/mcp-oauth/store.ts` | `/mcp connect` and `/mcp disconnect` persist to the store, both scopes |
| `src/gateway/core/credential-import.ts` | One-time import of on-disk credentials |
| `src/agent/config-root.ts`, `src/agent/oauth-home.ts` | Pod-local config directory for every node session |
| `src/node/credentials.ts`, `src/node/client.ts`, `src/node/worker.ts` | Seed, diff, write-back |
| `src/knowledge/remote/brain-client.ts` | The brain's token comes from the store |
| `deploy/k8s-scale/50-node.yaml`, `deploy/k8s-local/verify-ha.sh` | The `emptyDir`, and a guard against credentials on the shared volume |

## Task order

Task 1 gates Task 10. Tasks 2–6 make the gateway the authority and populate it before anything reads from it; Task 6's import in particular must land in the same release as Task 8's seeding, or an upgrade seeds empty sets. Tasks 7–8 move the node, Task 9 gives the gateway its refresh, and Task 10 has the node use it. Tasks 11–13 finish the edges.

---

### Task 1: Find out whether an auth failure can reach us

**Files:**
- Create: `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md`
- Probe scripts are throwaway; keep them in the scratchpad, not the repo.

**Interfaces:**
- Consumes: nothing.
- Produces: a written answer to two questions and a recorded decision. **Task 10 cannot be written until this is answered.**

This runs first because its outcome decides what Task 10 builds, and it matters more now that the agent's own credentials are in scope. A person's lost rotation costs that person a reconnect. The agent's costs every channel conversation its integration until a manager reconnects. Do not start this task by writing code.

The design is seed-then-write-back, which handles refresh only between turns. If auth failures are observable and the agent notices a rewritten credentials file, a better lever exists: refresh at the gateway and let the running turn pick it up.

**Question A — does a 401/403 from an MCP server reach slaude, distinguishably?** `AgentEvent` (`src/agent/manager.ts:65-74`) has `toolResult` with `result: unknown` and a generic `error`. Find out whether an MCP call that fails authorization surfaces there and whether it can be told apart from an ordinary tool error. A heuristic on error text is not an answer; say so plainly if that is all there is.

**Question B — does the agent re-read the credentials file mid-session?** The binary contains a function that stats `.credentials.json`, compares `mtimeMs` against a cached value and clears caches on change, and a poller with a ~2000ms default interval. Confirm whether that covers the `mcpOAuth` subtree or only the Anthropic user credentials.

**A third lever:** the permission resolver (`PermissionResolver`, `src/agent/manager.ts:77-82`) runs *before* every tool use. If MCP tool names are identifiable there, the node can refresh proactively, which beats reacting to a failure.

- [ ] **Step 1: Read what the node can see before measuring anything**

Read `src/agent/manager.ts:60-110` for the event union and resolver signature, and `src/node/worker.ts:140-200` for how the node observes events and resolves child env.

- [ ] **Step 2: Extract the agent's credential-polling code**

The binary is at `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude` in a node pod. `strings` is not installed; `grep -a` works.

```sh
POD=$(kubectl -n slaude-scale get pod -l app.kubernetes.io/component=node -o name | head -1)
kubectl -n slaude-scale exec "$POD" -- sh -c \
  'grep -a -o -E ".{200}mtimeMs.{400}" /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude' | head -5
```

Trace outward from the cache-clearing function to which caches it clears, and whether the MCP credential lookup reads through one of them.

- [ ] **Step 3: Measure the mtime pickup directly**

Do not conclude from decompiled source alone. In a pod, seed a config directory with an MCP entry, start a session against a stub HTTP MCP server that returns 401 for a known-bad token and 200 for a known-good one, rewrite `.credentials.json` with the good token mid-session, and see whether the next tool call succeeds without restarting the session. Run it on the pod-local filesystem, not the shared volume.

- [ ] **Step 4: Record what the failure looks like to slaude**

With the stub returning 401, capture every `AgentEvent` the node emits for that turn. Put the exact `toolResult` payload shape in the field note verbatim. If the status code is absent, say that.

- [ ] **Step 5: Write the field note and record the decision**

Cover the rename-replaces-symlink measurement from the spec, the agent's own rotation behaviour, and both answers. Name the Task 10 branch:

- **Branch R (reactive)** — A and B both yes. On an identifiable auth failure the node asks the gateway to refresh, rewrites the local file, and the agent picks it up.
- **Branch P (proactive)** — A no, B yes. Before a tool call or on a timer, the node refreshes anything near expiry through the gateway and rewrites the file.
- **Branch S (seed only)** — B no. Refresh happens only between turns; a mid-turn expiry costs a retry.

- [ ] **Step 6: Commit**

```bash
git add docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md
git commit -m "docs(findings): whether an MCP auth failure can reach slaude"
```

---

### Task 2: The encrypted store, for both owner kinds

**Files:**
- Create: `src/agent/credential-owner.ts`
- Create: `src/db/migrations/0008_mcp_credentials.sql`
- Modify: `src/db/drivers/sqlite.ts` (bootstrap DDL, beside `slack_identities`)
- Modify: `tests/db/schema-drift.test.ts` (`NO_TENANT_TABLES`)
- Create: `src/db/mcp-credentials.ts`
- Test: `tests/db/mcp-credentials.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `src/db/crypto.ts`; `StoredEntry` from `src/agent/mcp-oauth/store.ts:105-116` (import it, never redeclare it, so the wire and file formats cannot drift).
- Produces:
  - `type CredentialOwner = { kind: "agent"; tenant: string; persona: string } | { kind: "account"; accountId: string }`
  - `putCredential(owner: CredentialOwner, serverKey: string, entry: StoredEntry): Promise<void>`
  - `credentialsFor(owner: CredentialOwner): Promise<Record<string, StoredEntry>>`
  - `deleteCredential(owner: CredentialOwner, serverKey: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Accounts from "../../src/db/accounts";
import * as Creds from "../../src/db/mcp-credentials";
import type { CredentialOwner } from "../../src/agent/credential-owner";

const ISS = "https://idp.example.com";
const entry = (token: string, expiresAt = Date.now() + 3600_000) => ({
  serverName: "workbench", serverUrl: "https://mcp.example.com",
  accessToken: token, refreshToken: "r-1", expiresAt,
});
const AGENT: CredentialOwner = { kind: "agent", tenant: "t1", persona: "default" };
let person: CredentialOwner;

beforeEach(async () => {
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" });
  person = { kind: "account", accountId: a.id };
});

describe("mcp credential store", () => {
  test("round-trips an entry for a person", async () => {
    await Creds.putCredential(person, "workbench|abc", entry("tok-1"));
    expect((await Creds.credentialsFor(person))["workbench|abc"]!.accessToken).toBe("tok-1");
  });

  test("round-trips an entry for the agent", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-agent"));
    expect((await Creds.credentialsFor(AGENT))["workbench|abc"]!.accessToken).toBe("tok-agent");
  });

  // The ownership boundary, in every direction that matters.
  test("the agent's credentials are never returned for a person, or the reverse", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-agent"));
    await Creds.putCredential(person, "workbench|abc", entry("tok-person"));
    expect((await Creds.credentialsFor(AGENT))["workbench|abc"]!.accessToken).toBe("tok-agent");
    expect((await Creds.credentialsFor(person))["workbench|abc"]!.accessToken).toBe("tok-person");
  });

  test("one persona's agent credentials are not another's", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-default"));
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "ana" })).toEqual({});
  });

  test("one tenant's agent credentials are not another's", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-t1"));
    expect(await Creds.credentialsFor({ kind: "agent", tenant: "t2", persona: "default" })).toEqual({});
  });

  test("the token is not stored in plaintext", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-super-secret"));
    const raw = await db.one<{ payload: string }>("SELECT payload FROM mcp_credentials");
    expect(raw!.payload).not.toContain("tok-super-secret");
    expect(raw!.payload.startsWith("v1:")).toBe(true);
  });

  test("expiry is queryable without decrypting", async () => {
    const at = Date.now() + 1234;
    await Creds.putCredential(person, "workbench|abc", entry("tok-1", at));
    const raw = await db.one<{ expires_at: number }>("SELECT expires_at FROM mcp_credentials");
    expect(Number(raw!.expires_at)).toBe(at);
  });

  test("writing the same key for the same owner replaces, never duplicates", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-1"));
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-2"));
    const n = await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_credentials");
    expect(Number(n!.n)).toBe(1);
  });

  test("deleting an account takes its credentials through the database cascade", async () => {
    await Creds.putCredential(person, "workbench|abc", entry("tok-1"));
    await db.run("DELETE FROM accounts WHERE id = ?", [(person as any).accountId]);
    expect(await Creds.credentialsFor(person)).toEqual({});
  });

  // Enforced by the schema, not by the repo, so a future caller cannot bypass it.
  test("a row with no owner, or both owners, is refused by the database", async () => {
    const insert = (acct: string | null, tenant: string | null, persona: string | null) =>
      db.run(
        `INSERT INTO mcp_credentials (id, account_id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at)
         VALUES (?, ?, ?, ?, 'k', 'v1:a:b:c', 0, 0)`,
        [crypto.randomUUID(), acct, tenant, persona],
      );
    await expect(insert(null, null, null)).rejects.toThrow();
    await expect(insert((person as any).accountId, "t1", "default")).rejects.toThrow();
    await expect(insert(null, "t1", null)).rejects.toThrow();
  });

  test("a corrupt payload is skipped and reported, not returned", async () => {
    await Creds.putCredential(AGENT, "workbench|abc", entry("tok-1"));
    await db.run("UPDATE mcp_credentials SET payload = 'v1:aa:bb:cc'");
    expect(await Creds.credentialsFor(AGENT)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/mcp-credentials.test.ts`
Expected: FAIL — module `credential-owner` not found.

- [ ] **Step 3: Write the owner type**

`src/agent/credential-owner.ts`:

```ts
/** Whose MCP credentials a turn uses. Decided once, at dispatch; see
 *  resolveEffectiveIdentity. The agent is keyed on (tenant, persona), matching
 *  how the runtime bundle resolves an agent's identity. A person is keyed on
 *  their account, so one person in two workspaces has one set of integrations. */
export type CredentialOwner =
  | { kind: "agent"; tenant: string; persona: string }
  | { kind: "account"; accountId: string };
```

- [ ] **Step 4: Write the migration**

`src/db/migrations/0008_mcp_credentials.sql`:

```sql
-- Every MCP OAuth credential, whoever owns it, held by the gateway.
--
-- Exactly one owner per row, enforced here rather than in application code.
-- Two nullable owner columns instead of a polymorphic owner_kind/owner_id pair,
-- so account_id can carry a real foreign key and deleting an account deletes
-- that person's credentials through the database's own cascade.
--
-- payload is AES-256-GCM (src/db/crypto.ts). expires_at is the only plaintext
-- field, and only so expiry is queryable without decrypting every row.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  id            TEXT   PRIMARY KEY,
  account_id    TEXT   REFERENCES accounts (id) ON DELETE CASCADE,
  agent_tenant  TEXT,
  agent_persona TEXT,
  server_key    TEXT   NOT NULL,
  payload       TEXT   NOT NULL,
  expires_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  CHECK ((account_id IS NOT NULL) <> (agent_tenant IS NOT NULL)),
  CHECK ((agent_tenant IS NULL) = (agent_persona IS NULL)),
  UNIQUE (account_id, server_key),
  UNIQUE (agent_tenant, agent_persona, server_key)
);
```

Both `UNIQUE` constraints are safe with the nullable columns: in Postgres and SQLite alike, NULLs are distinct in a unique constraint, so an agent row never collides on `(account_id, server_key)` and a person's row never collides on the agent triple.

Mirror the DDL in `src/db/drivers/sqlite.ts` with `INTEGER` for `BIGINT`. Add `"mcp_credentials"` to `NO_TENANT_TABLES` in `tests/db/schema-drift.test.ts` with a comment: a person's row reaches tenancy through `accounts`, which is deployment-global, and an agent's row carries its tenant explicitly in `agent_tenant`.

- [ ] **Step 5: Write the repo**

Upsert needs one statement per owner kind, because each `ON CONFLICT` target must name the unique constraint that applies:

```ts
export async function putCredential(owner: CredentialOwner, serverKey: string, entry: StoredEntry): Promise<void> {
  const now = Date.now();
  const payload = encrypt(JSON.stringify(entry));
  if (owner.kind === "account") {
    await db.run(
      `INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, server_key)
       DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [randomUUID(), owner.accountId, serverKey, payload, entry.expiresAt, now],
    );
    return;
  }
  await db.run(
    `INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_tenant, agent_persona, server_key)
     DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    [randomUUID(), owner.tenant, owner.persona, serverKey, payload, entry.expiresAt, now],
  );
}
```

`credentialsFor` selects by the owner's columns, decrypts each row inside its own try/catch, and on failure logs `owner.kind`, the row id and the server key — never the payload — and omits the row. Every query is parameterised.

- [ ] **Step 6: Run tests on both dialects and typecheck**

Run: `bun test tests/db && bunx tsc --noEmit`, then the same `tests/db` run with `SLAUDE_DB=pg` against a disposable Postgres database (the local scale cluster's Postgres works; create and drop a throwaway database around the run).
Expected: PASS on both. The `CHECK` test is the one most likely to differ between dialects, so it must be seen passing on Postgres, not assumed.

- [ ] **Step 7: Commit**

```bash
git add src/agent/credential-owner.ts src/db/migrations/0008_mcp_credentials.sql src/db/drivers/sqlite.ts src/db/mcp-credentials.ts tests/db/mcp-credentials.test.ts tests/db/schema-drift.test.ts
git commit -m "feat(db): encrypted MCP credential store for the agent and for people"
```

---

### Task 3: Sign whose identity a turn runs as

**Files:**
- Modify: `src/agent/credential-owner.ts` (encode/parse for the claim)
- Modify: `src/gateway/api/auth.ts:21-36` (`JobClaims.runAs`)
- Modify: `src/gateway/core/dispatch.ts:230-240` (mint it)
- Modify: `src/gateway/core/gateway.ts` (pass the resolved identity into `DispatchMeta` for ordinary turns, beside `:2129-2137`, and for cron at `:496-505`)
- Test: `tests/gateway/core/dispatch-run-as.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveIdentity` (`src/agent/manager.ts:269-276`) — the existing single rule: a cron job's carried identity, else the thread's 1:1 lock owner, else none.
- Produces:
  - `JobClaims.runAs?: string` — `"agent"` or `"user:<slackUserId>"`
  - `encodeRunAs(slackUserId: string | undefined): string`
  - `parseRunAs(raw: unknown): { kind: "agent" } | { kind: "user"; slackUserId: string } | null` — `null` for anything malformed

**Why not the existing `initiator` claim.** `initiator` is `meta.userId`, whoever sent the message. In a channel thread the session runs as the agent while `initiator` is a colleague who happened to speak. It equals the lock owner only inside a 1:1, which is exactly the case where a bug built on it would pass every test.

**Why the gateway calls the same function the node uses.** The node already calls `resolveEffectiveIdentity` to pick its config directory. If the gateway computed `runAs` by its own rule, the token's credential scope and the node's directory could disagree. One function agrees by construction. Task 8 then makes the node use the claim instead of calling it again.

- [ ] **Step 1: Write the failing test**

```ts
test("an ordinary thread runs as the agent, whoever sent the message", async () => {
  const claims = await dispatchAndDecode({ userId: "UTESTUSER2", lock: null });
  expect(claims.runAs).toBe("agent");
  expect(claims.initiator).toBe("UTESTUSER2"); // unchanged, and not the owner
});

test("a thread locked to a person runs as the lock owner", async () => {
  const claims = await dispatchAndDecode({ userId: "UTESTUSER1", lock: "UTESTUSER1" });
  expect(claims.runAs).toBe("user:UTESTUSER1");
});

test("a cron job created in a 1:1 runs as its carried identity", async () => {
  const claims = await dispatchAndDecode({ userId: "UTESTUSER3", oauthUser: "UTESTUSER1" });
  expect(claims.runAs).toBe("user:UTESTUSER1");
});

test("parseRunAs refuses anything it did not mint", () => {
  expect(parseRunAs(undefined)).toBeNull();
  expect(parseRunAs("")).toBeNull();
  expect(parseRunAs("user:")).toBeNull();
  expect(parseRunAs("admin")).toBeNull();
  expect(parseRunAs("user:UTESTUSER1")).toEqual({ kind: "user", slackUserId: "UTESTUSER1" });
  expect(parseRunAs("agent")).toEqual({ kind: "agent" });
});
```

Build `dispatchAndDecode` on the harness in `tests/gateway/core/dispatch-tenant.test.ts`, which already captures and decodes the minted job token.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/core/dispatch-run-as.test.ts`
Expected: FAIL — `runAs` is undefined.

- [ ] **Step 3: Implement**

Add `runAs?: string` to `JobClaims`. It stays optional in the type so tokens minted by an older gateway still decode; the credential endpoint in Task 4 is what refuses its absence.

In `DispatchMeta` add `runAsUser?: string`. In the gateway's ordinary-turn dispatch, resolve it with `agent.resolveEffectiveIdentity(session.id, channelId, threadTs)`; in the cron dispatch, pass `job.oauthUser`. At the `mintJobToken` call in `dispatch.ts`, add `runAs: encodeRunAs(meta.runAsUser ?? meta.oauthUser)`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/gateway tests/queue tests/node && bunx tsc --noEmit`
Expected: PASS. The node suites run because the claim set they decode has grown.

- [ ] **Step 5: Commit**

```bash
git add src/agent/credential-owner.ts src/gateway/api/auth.ts src/gateway/core/dispatch.ts src/gateway/core/gateway.ts tests/gateway/core/dispatch-run-as.test.ts
git commit -m "feat(dispatch): sign whose identity a turn runs as into its job token"
```

---

### Task 4: The credential endpoint

**Files:**
- Create: `src/gateway/api/mcp-credentials.ts`
- Modify: `src/gateway/api/index.ts` (beside the runtime routes at `:75-96`)
- Test: `tests/gateway/api/mcp-credentials.test.ts`

**Interfaces:**
- Consumes: Task 2's repo; Task 3's `parseRunAs`; `requireJobToken` from `src/gateway/api/auth.ts`; `accountForSlackUser` from `src/db/accounts.ts`.
- Produces:
  - `GET  /v1/tenants/:tenant/mcp-credentials` → `{ entries: Record<string, StoredEntry> }`
  - `POST /v1/tenants/:tenant/mcp-credentials` ← `{ entries: Record<string, StoredEntry> }`

The owner is resolved **only** from the token:

- `runAs = agent` → `{ kind: "agent", tenant: claims.tenant, persona: claims.persona }`
- `runAs = user:X` → the account bound to `(claims.team, X)`; none bound → empty set on GET, 409 on POST
- anything else, including absent → 403

A person with no account gets `{ entries: {} }` and a 200 on GET. Distinguishing "no account" from "no credentials" in the response would tell a caller whether an account exists.

- [ ] **Step 1: Write the failing test**

```ts
test("an agent-scoped token gets the agent's credentials for its persona", async () => {
  const res = await get(tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }));
  expect((await res.json()).entries["workbench|abc"].accessToken).toBe("tok-agent");
});

test("a user-scoped token gets that person's credentials", async () => {
  const res = await get(tokenFor({ tenant: "t1", team: "TTESTTEAM1", runAs: "user:UTESTUSER1" }));
  expect((await res.json()).entries["workbench|abc"].accessToken).toBe("tok-person");
});

// The boundaries. Each is a way one owner could read another's credentials.
test("a session running as the agent cannot read a person's credentials", async () => {
  const body = await (await get(tokenFor({ tenant: "t1", persona: "default", runAs: "agent", initiator: "UTESTUSER1" }))).text();
  expect(body).not.toContain("tok-person");
});

test("a 1:1 cannot read the agent's credentials", async () => {
  const body = await (await get(tokenFor({ tenant: "t1", team: "TTESTTEAM1", runAs: "user:UTESTUSER1" }))).text();
  expect(body).not.toContain("tok-agent");
});

test("one person cannot read another's", async () => {
  const body = await (await get(tokenFor({ tenant: "t1", team: "TTESTTEAM1", runAs: "user:UTESTUSER2" }))).text();
  expect(body).not.toContain("tok-person");
});

test("a token for one tenant is refused another tenant's path", async () => {
  const res = await getPath("/v1/tenants/t2/mcp-credentials", tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }));
  expect(res.status).toBe(403);
});

test("a token with no runAs is refused, never treated as the agent", async () => {
  const res = await get(tokenFor({ tenant: "t1", persona: "default" }));
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain("tok-agent");
});

test("an unauthenticated request is refused", async () => {
  expect((await getPath("/v1/tenants/t1/mcp-credentials")).status).toBe(401);
});

test("write-back persists to the token's owner and no other", async () => {
  await post(tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }), { entries: { "workbench|abc": entry("tok-rotated") } });
  expect((await Creds.credentialsFor(AGENT))["workbench|abc"]!.accessToken).toBe("tok-rotated");
  expect((await Creds.credentialsFor(PERSON))["workbench|abc"]!.accessToken).toBe("tok-person");
});

test("an older entry does not overwrite a newer one", async () => {
  await Creds.putCredential(AGENT, "workbench|abc", entry("newer", Date.now() + 7200_000));
  await post(tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }), { entries: { "workbench|abc": entry("older", Date.now() + 60_000) } });
  expect((await Creds.credentialsFor(AGENT))["workbench|abc"]!.accessToken).toBe("newer");
});

test("a malformed entry is rejected and nothing is written", async () => {
  const res = await post(tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }), { entries: { "workbench|abc": { serverName: "workbench" } } });
  expect(res.status).toBe(400);
});

test("no error response ever carries a token", async () => {
  const res = await post(tokenFor({ tenant: "t1", persona: "default", runAs: "agent" }), { entries: { "k": { ...entry("tok-leak"), expiresAt: "soon" } } });
  expect(await res.text()).not.toContain("tok-leak");
});
```

Build `tokenFor` on `mintJobToken` from `src/gateway/api/auth.ts`, the way `tests/gateway/api/runtime-persona.test.ts` already does.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/api/mcp-credentials.test.ts`
Expected: FAIL — the route returns 404.

- [ ] **Step 3: Implement**

Route in `src/gateway/api/index.ts`:

```ts
      // /v1/tenants/:id/mcp-credentials — the owner is the token's signed runAs
      // claim and nothing else: there is no owner in the path to tamper with.
      // Deliberately not part of the runtime bundle, which is keyed on (tenant,
      // persona) and ETag-cached on the node.
      if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "mcp-credentials") {
        if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) {
          return json(403, { error: "job token is not scoped to this tenant" });
        }
        return await handleMcpCredentials(req, job.claims);
      }
```

In the handler, validate every POSTed entry before writing any — `serverName`, `serverUrl` and `accessToken` non-empty strings, `expiresAt` a finite number — and reject the whole request on the first failure. Error bodies name the server key and the failing field, never a value. Take a Redis lock keyed on the owner around the write, and skip any entry whose `expiresAt` is older than the stored one.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/gateway && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/api/mcp-credentials.ts src/gateway/api/index.ts tests/gateway/api/mcp-credentials.test.ts
git commit -m "feat(api): MCP credential endpoint that serves only the token's own owner"
```

---

### Task 5: /mcp connect and disconnect write to the store, both scopes

**Files:**
- Modify: `src/agent/mcp-oauth/store.ts` (`persistConnect`, `persistDisconnect`)
- Modify: `src/gateway/core/gateway.ts` (the `/mcp` branch — `connectServer` and the disconnect path)
- Test: `tests/mcp-oauth/connect-persists.test.ts`

**Interfaces:**
- Consumes: Task 2's repo; `accountForSlackUser`.
- Produces: `persistConnect(i: { scope: ConnectScope; tenant: string; persona: string; teamId: string; slackUserId: string; serverName: string; cfg: OAuthServerConfig; entry: StoredEntry }): Promise<{ ok: true } | { ok: false; reason: "no-account" }>` and `persistDisconnect` with the same shape minus `entry`.

Without this the gateway would serve credentials it never receives: `/mcp connect` runs on the gateway and writes to a config directory, while Task 4 reads from the database. Every seed would come back empty.

The scope maps to an owner exactly as the gates already decide it: `global` → the agent for this tenant and persona (a manager-only action, unchanged); `initiator` → the lock owner's account. The gates themselves do not change.

- [ ] **Step 1: Write the failing test**

```ts
test("a manager's global connect lands under the agent owner for that persona", async () => {
  await persistConnect({ scope: "global", tenant: "t1", persona: "ana", teamId: "TTESTTEAM1", slackUserId: "UMANAGER1", serverName: "workbench", cfg, entry: entry("tok-agent") });
  expect((await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "ana" }))[key]!.accessToken).toBe("tok-agent");
});

// The manager ran the command, but it is the agent's credential, not theirs.
test("a global connect is never stored under the manager's own account", async () => {
  await persistConnect({ scope: "global", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UMANAGER1", serverName: "workbench", cfg, entry: entry("tok-agent") });
  expect(await Creds.credentialsFor({ kind: "account", accountId: managerAccountId })).toEqual({});
});

test("a 1:1 connect lands under the person's account", async () => {
  await persistConnect({ scope: "initiator", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", serverName: "workbench", cfg, entry: entry("tok-person") });
  expect((await Creds.credentialsFor({ kind: "account", accountId }))[key]!.accessToken).toBe("tok-person");
});

test("a 1:1 connect with no bound account is refused, not silently dropped", async () => {
  const r = await persistConnect({ scope: "initiator", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UTESTUSER9", serverName: "workbench", cfg, entry: entry("tok-1") });
  expect(r).toEqual({ ok: false, reason: "no-account" });
});

test("a global disconnect removes the agent's row and leaves a person's intact", async () => {
  await persistConnect({ scope: "global", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UMANAGER1", serverName: "workbench", cfg, entry: entry("tok-agent") });
  await persistConnect({ scope: "initiator", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", serverName: "workbench", cfg, entry: entry("tok-person") });
  await persistDisconnect({ scope: "global", tenant: "t1", persona: "default", teamId: "TTESTTEAM1", slackUserId: "UMANAGER1", serverName: "workbench", cfg });
  expect(await Creds.credentialsFor({ kind: "agent", tenant: "t1", persona: "default" })).toEqual({});
  expect((await Creds.credentialsFor({ kind: "account", accountId }))[key]!.accessToken).toBe("tok-person");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp-oauth/connect-persists.test.ts`
Expected: FAIL — `persistConnect` does not exist.

- [ ] **Step 3: Implement**

On `no-account`, the gateway's reply tells the person to run `/link` first, ephemerally through `sayEphemeral` from phase 2, since it concerns only them.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/mcp-oauth tests/gateway && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/mcp-oauth/store.ts src/gateway/core/gateway.ts tests/mcp-oauth/connect-persists.test.ts
git commit -m "feat(mcp): connect and disconnect persist to the credential store, for the agent and for people"
```

---

### Task 6: Import existing on-disk credentials

**Files:**
- Create: `src/gateway/core/credential-import.ts`
- Modify: `src/gateway/core/gateway.ts` (run it once at boot under a leader lock)
- Test: `tests/gateway/core/credential-import.test.ts`

**Interfaces:**
- Consumes: Task 2's repo; `agentConfigDir`, `personaConfigDir` from `src/agent/oauth-home.ts`; `accountForSlackUser`; the existing `leaderLoop` helper for the lock.
- Produces: `importOnDiskCredentials(): Promise<{ imported: number; skippedNoAccount: number; skippedUnreadable: number }>`

Without this, an upgrade loses every connected integration, the agent's and every person's. It must ship in the same release as Task 8.

| On-disk source | Owner |
| --- | --- |
| `agentConfigDir()/.credentials.json` | agent, default persona |
| `personaConfigDir(p)/.credentials.json` for each persona | agent, persona `p` |
| `$SLAUDE_HOME/oauth/<userId>/.credentials.json` | the account bound to that Slack user |
| `$SLAUDE_HOME/oauth/<persona>/<userId>/.credentials.json` | the account bound to that Slack user |

Only the `mcpOAuth` subtree is read. The agent's Anthropic credentials in the same file are never touched.

A person's credentials with **no bound account** cannot be imported, because there is no owner to key them on. They stay on disk untouched and the person's next `/mcp connect` after `/link` recreates them. Deleting them would destroy something unrecoverable; importing them under a guessed owner would be worse.

- [ ] **Step 1: Write the failing test**

```ts
test("the agent's and a person's on-disk credentials are both imported", async () => {
  writeCreds(join(agentHome, ".credentials.json"), { [key]: entry("tok-agent") });
  writeCreds(join(home, "oauth", "UTESTUSER1", ".credentials.json"), { [key]: entry("tok-person") });
  const r = await importOnDiskCredentials();
  expect(r.imported).toBe(2);
  expect((await Creds.credentialsFor(AGENT))[key]!.accessToken).toBe("tok-agent");
  expect((await Creds.credentialsFor(PERSON))[key]!.accessToken).toBe("tok-person");
});

test("a person with no bound account is skipped, and the file is left in place", async () => {
  writeCreds(join(home, "oauth", "UTESTUSER9", ".credentials.json"), { [key]: entry("tok-orphan") });
  const r = await importOnDiskCredentials();
  expect(r.skippedNoAccount).toBe(1);
  expect(existsSync(join(home, "oauth", "UTESTUSER9", ".credentials.json"))).toBe(true);
});

// Rollback safety: the previous version must still find its files.
test("imported files are left in place, not deleted", async () => {
  writeCreds(join(agentHome, ".credentials.json"), { [key]: entry("tok-agent") });
  await importOnDiskCredentials();
  expect(existsSync(join(agentHome, ".credentials.json"))).toBe(true);
});

test("running twice overwrites nothing rotated since", async () => {
  writeCreds(join(agentHome, ".credentials.json"), { [key]: entry("tok-agent", Date.now() + 60_000) });
  await importOnDiskCredentials();
  await Creds.putCredential(AGENT, key, entry("rotated-since", Date.now() + 9e6));
  await importOnDiskCredentials();
  expect((await Creds.credentialsFor(AGENT))[key]!.accessToken).toBe("rotated-since");
});

test("the import logs counts, never a user id or a token", async () => {
  const logs = await captureLogs(() => importOnDiskCredentials());
  expect(logs.join("\n")).not.toMatch(/UTESTUSER|tok-/);
});
```

The fourth test matters most: the import must never undo a rotation that happened after its first run, which the same expiry rule as Task 4's write-back guarantees.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/gateway/core/credential-import.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**, reusing the expiry-wins rule from Task 4 so there is one definition of "newer".

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/gateway && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/credential-import.ts src/gateway/core/gateway.ts tests/gateway/core/credential-import.test.ts
git commit -m "feat(gateway): import on-disk MCP credentials into the store at boot"
```

---

### Task 7: A pod-local config directory for every node session

**Files:**
- Create: `src/agent/config-root.ts`
- Modify: `src/agent/oauth-home.ts` (`resolveSessionConfigDir` at `:143-159`, and generalise `ensureInitiatorConfigDir` at `:86-128`)
- Test: `tests/agent/config-root.test.ts`, extend `tests/oauth-home.test.ts`

**Interfaces:**
- Consumes: `env.role()` from `src/config/env.ts`; `paths` from `src/config/home.ts`; Task 3's `parseRunAs` result type.
- Produces:
  - `nodeConfigRoot(): string` — `$SLAUDE_NODE_CONFIG_ROOT`, else `/config-home` on a node, else `paths.home`
  - `sessionConfigDir(sessionId: string, owner: { kind: "agent" } | { kind: "user"; slackUserId: string }, persona?: string): string`

Today an unlocked default-persona session returns `undefined` from `resolveSessionConfigDir` and inherits the process's own config directory, and a named persona uses its config home on the shared volume. Both hold the agent's credentials, so on a node **every** session gets a pod-local directory. Mono and gateway keep today's behaviour exactly.

The directory is keyed on the session, not only the owner. Two sessions running as the agent can run concurrently on one node, and they must not share a working copy either — the same one-owner rule, one level down.

- [ ] **Step 1: Write the failing test**

```ts
test("a node's agent session gets a pod-local directory, not the persona home", () => {
  process.env.SLAUDE_ROLE = "node";
  process.env.SLAUDE_NODE_CONFIG_ROOT = tmpRoot;
  const dir = sessionConfigDir("s1", { kind: "agent" }, "ana");
  expect(dir.startsWith(tmpRoot)).toBe(true);
  expect(dir).not.toContain(paths.home);
});

test("two agent sessions on one node do not share a directory", () => {
  expect(sessionConfigDir("s1", { kind: "agent" })).not.toBe(sessionConfigDir("s2", { kind: "agent" }));
});

test("transcripts still resolve onto the shared volume", () => {
  const dir = sessionConfigDir("s1", { kind: "agent" }, "ana");
  expect(readlinkSync(join(dir, "projects"))).toBe(join(personaConfigDir("ana"), "projects"));
});

test("settings and plugins are seeded from the persona home", () => {
  writeFileSync(join(personaConfigDir("ana"), "settings.json"), '{"x":1}');
  const dir = sessionConfigDir("s1", { kind: "agent" }, "ana");
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe('{"x":1}');
});

test("the persona home's own credentials are never copied into the pod-local dir", () => {
  writeFileSync(join(personaConfigDir("ana"), ".credentials.json"), '{"mcpOAuth":{"k":{"accessToken":"on-disk"}}}');
  const dir = sessionConfigDir("s1", { kind: "agent" }, "ana");
  expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
});

test("mono keeps today's resolution byte for byte", () => {
  process.env.SLAUDE_ROLE = "mono";
  delete process.env.SLAUDE_NODE_CONFIG_ROOT;
  expect(resolveSessionConfigDir(null, undefined)).toBeUndefined();
});
```

The fifth test pins that the only source of credentials on a node is the gateway. `seedConfigDir` copies selected files from the base home; if it ever copied the credentials file, a stale on-disk token would shadow the store.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/agent/config-root.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Generalise `ensureInitiatorConfigDir` rather than writing a second function: it already seeds settings and plugins and maintains the `projects/` symlink, which is exactly what every session needs. `seedConfigDir` (`src/agent/oauth-home.ts:30-45`) copies only `settings.json` and `settings.local.json` and symlinks `plugins/`; it never copies a credentials file. The fifth test exists to keep it that way.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/agent tests/oauth-home.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/config-root.ts src/agent/oauth-home.ts tests/agent/config-root.test.ts tests/oauth-home.test.ts
git commit -m "feat(agent): every node session gets a pod-local config directory"
```

---

### Task 8: Seed at session start

**Files:**
- Create: `src/node/credentials.ts`
- Modify: `src/node/client.ts` (`getMcpCredentials` beside `getRuntime` at `:151-166`)
- Modify: `src/node/worker.ts`
- Test: `tests/node/credentials-seed.test.ts`

**Interfaces:**
- Consumes: Task 4's `GET`; Task 7's `sessionConfigDir`; Task 3's `parseRunAs`.
- Produces: `seedCredentials(configDir: string, entries: Record<string, StoredEntry>): Promise<void>` and `snapshotCredentials(configDir: string): Record<string, StoredEntry>`.

The node reads `runAs` from its own job token to pick the directory. It no longer calls `resolveEffectiveIdentity` for this, so its directory and the token's credential scope cannot disagree.

No ETag cache on `getMcpCredentials`. A credential that changed is exactly what must not be served stale.

- [ ] **Step 1: Write the failing test**

```ts
test("seeding writes the entries at 0600", async () => {
  await seedCredentials(dir, { [key]: entry("tok-1") });
  expect(statSync(join(dir, ".credentials.json")).mode & 0o777).toBe(0o600);
});

// The file is shared with the agent's own Anthropic credentials, so seeding
// must be a read-modify-write of mcpOAuth only, never a whole-file replace.
test("seeding preserves everything outside mcpOAuth", async () => {
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "agent-own" } }), { mode: 0o600 });
  await seedCredentials(dir, { [key]: entry("tok-1") });
  const raw = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
  expect(raw.claudeAiOauth.accessToken).toBe("agent-own");
});

test("an empty set leaves nothing behind from an earlier seed", async () => {
  await seedCredentials(dir, { [key]: entry("tok-1") });
  await seedCredentials(dir, {});
  expect(snapshotCredentials(dir)).toEqual({});
});

test("the worker picks the directory from runAs, not from a fresh lock lookup", async () => {
  const lookups = spyOn(OneOnOne, "find");
  await startSessionWithToken({ runAs: "user:UTESTUSER1" });
  expect(lookups).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/node/credentials-seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** `seedCredentials` reads the existing file when present, replaces only `mcpOAuth`, and writes through the phase 0 symlink-resolving atomic write at `0600`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/node && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/node/credentials.ts src/node/client.ts src/node/worker.ts tests/node/credentials-seed.test.ts
git commit -m "feat(node): seed a session's MCP credentials from the gateway"
```

---

### Task 9: Gateway-side refresh

> **Revised during execution.** The plan originally had a node write back whatever the agent changed at turn end. Task 4 was then tightened so nodes receive access tokens only: the store keeps the full grant, and the node-facing endpoint returns an allowlisted projection. A node therefore cannot rotate anything and has nothing to write back, the write path is gone, and so is the accepted cost of losing a rotation on pod death. This task replaces the write-back with the refresh it made necessary.

**Files:**
- Create: `src/agent/mcp-oauth/refresh.ts` (the `refresh_token` grant)
- Create: `src/gateway/core/credential-refresh.ts` (single-flight, owner-scoped)
- Modify: `src/gateway/api/mcp-credentials.ts`, `src/gateway/api/index.ts` (`POST …/mcp-credentials/refresh`)
- Test: `tests/mcp-oauth/refresh-grant.test.ts`, `tests/gateway/api/mcp-credentials-refresh.test.ts`

**Interfaces:**
- Consumes: `discover` from `src/agent/mcp-oauth/discovery.ts`; Task 2's store including `putCredentialIfNewer`; Task 4's owner resolution and projection.
- Produces: `POST /v1/tenants/:tenant/mcp-credentials/refresh` ← `{ serverKey, failedAccessTokenHash? }` → `200 { entry: NodeCredential }` or `409 { reconnect: true }`.

Requirements, each with a test:

1. The owner is the token's `runAs`, exactly as for GET. A node can only refresh a credential its own turn is entitled to read.
2. **Already-refreshed check first.** If the stored access token differs from the one that failed (the node sends a SHA-256 of it, never the token itself) and is not near expiry, return it without calling the provider. This is what stops a second concurrent refresher from presenting an already-spent refresh token.
3. **Single-flight** per owner and server key across gateway replicas: a Redis lock in the gateway role, an in-process mutex otherwise. Twelve concurrent requests cause exactly one call to the provider.
4. The write uses `putCredentialIfNewer`, so a lost lock still cannot let an older token win.
5. A provider rejection (`invalid_grant`, revoked) answers 409 with `reconnect: true` and does not delete the stored entry.
6. The response is the node projection. The new refresh token is stored, never returned.
7. The client secret is sent to the provider only as the grant requires, and never logged.

---

### Task 10: The node reacts to needs-auth (Branch R)

**Files:**
- Modify: `src/node/credentials.ts`, `src/node/worker.ts`
- Modify: `src/agent/manager.ts` if the live query's `mcpServerStatus()` / `reconnectMcpServer()` are not already reachable by session id
- Test: `tests/node/credentials-refresh.test.ts`

**Interfaces:**
- Consumes: Task 9's endpoint; Task 8's seeding; Task 1's recorded failure shape.

Task 1 measured the mechanism: after a 401 the server's status is `needs-auth`, a rewritten credentials file is used by the very next call, and `reconnectMcpServer` restores the reported status.

1. On a `toolResult` error for a tool named `mcp__<server>__…`, confirm with `mcpServerStatus()` that `<server>` is `needs-auth`. The structured status decides, not the error text.
2. Ask the gateway to refresh that server key, sending a hash of the token that failed.
3. Rewrite the pod-local file with the returned access token, then `reconnectMcpServer(<server>)`.
4. Coalesce: several failures for one server in one turn cause one refresh.
5. On 409, stop. Leave the server `needs-auth` so the owner sees the reconnect prompt; do not loop.

Tests cover each point, plus that nothing in the node path ever logs a token.

---

### Task 11: The brain reads its token from the store

**Files:**
- Modify: `src/knowledge/remote/brain-client.ts:13,48`
- Test: `tests/knowledge/brain-client-credentials.test.ts`

**Interfaces:**
- Consumes: Task 2's `credentialsFor` with the agent owner.

The remote brain backend reads its MCP token with `readEntry(agentConfigDir(), BRAIN_SERVER_NAME, …)`. That is an agent-owned credential like any other. Leaving it on disk would keep one credential on the old mechanism and make "unified" untrue.

- [ ] **Step 1: Write the failing test** — the client authenticates with the store's agent entry for the brain server, and makes no filesystem read for it.
- [ ] **Step 2:** Run it and confirm it fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun test tests/knowledge && bunx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add src/knowledge/remote/brain-client.ts tests/knowledge/brain-client-credentials.test.ts
git commit -m "feat(brain): the remote brain's token comes from the credential store"
```

---

### Task 12: Manifests and the shared-volume guard

**Files:**
- Modify: `deploy/k8s-scale/50-node.yaml`
- Modify: `deploy/k8s-local/verify-ha.sh`
- Modify: `docs/site/_content/deploy/multi-node.md`

- [ ] **Step 1: Add the volume**

```yaml
            - name: config-home
              mountPath: /config-home
        # Pod-local, never the shared volume: the agent's credential write
        # renames over the path, and a shared file would be silently un-shared.
        # Nothing durable lives here; transcripts stay on slaude-home through
        # the projects/ symlink.
        - name: config-home
          emptyDir: {}
```

- [ ] **Step 2: Guard against the regression this phase exists to prevent**

Create a marker file, drive a turn in an ordinary thread and in a 1:1, then assert no node wrote a credentials file under the shared volume after the marker:

```sh
kubectl -n "$NS" exec "$pod" -- touch /tmp/verify-marker
# … drive the two turns …
found=$(kubectl -n "$NS" exec "$pod" -- sh -c 'find /data -name ".credentials.json" -newer /tmp/verify-marker 2>/dev/null | head -1')
[ -z "$found" ] || { echo "FAIL: credentials written to the shared volume: $found"; exit 1; }
```

`-newer` matters: on an upgraded cluster the pre-existing files Task 6 imported are still present by design, and must not fail the check.

- [ ] **Step 3: Document it.** Nodes need a writable pod-local path; an `emptyDir` is the intended shape; the shared volume stays ReadWriteMany for transcripts; `SLAUDE_MASTER_KEY` is now required on the gateway; losing a node mid-turn can cost a token rotation, and for the agent's identity a manager reconnects.

- [ ] **Step 4: Run it**

Run: `./deploy/k8s-local/up.sh && ./deploy/k8s-local/verify-ha.sh`
Expected: PASS including the new check.

- [ ] **Step 5: Commit**

```bash
git add deploy/k8s-scale/50-node.yaml deploy/k8s-local/verify-ha.sh docs/site/_content/deploy/multi-node.md
git commit -m "feat(deploy): pod-local config volume for nodes, and a guard against credentials on the shared volume"
```

---

### Task 13: Documentation and the security pass

**Files:**
- Modify: `docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)

- [ ] **Step 1: Finish the field note** — one store for both owner kinds, `runAs` as the single signed answer and why `initiator` was the wrong key, pod-local working copies, write-back at turn end, the import, and the accepted cost. Mechanism only.

- [ ] **Step 2: Grep the diff for any path that could carry a token into a log or an error**

```sh
git diff main...HEAD -U0 | grep -nE '(console\.(log|warn|error|info)|throw new Error|json\([0-9]+).*(accessToken|refreshToken|payload|entry\b|entries)'
```

Expected: no hits. Any hit is a bug to fix before the pull request.

- [ ] **Step 3: Confirm each property against a test that exists**

1. No token is stored in plaintext anywhere durable.
2. No token reaches a log line, a thrown message, or an HTTP error body.
3. A session running as the agent cannot read a person's credentials.
4. A 1:1 cannot read the agent's credentials.
5. One person cannot read another's.
6. A token for one tenant cannot reach another tenant's path, and one persona's agent credentials are not another's.
7. A token without `runAs` is refused, never treated as the agent.
8. The database refuses a row with no owner or two owners.
9. Credentials never enter the runtime bundle or its ETag cache.
10. No credential file is written under the shared volume on any node, for either owner kind.
11. Credential files are mode `0600`.
12. Deleting an account deletes its credentials through the database cascade.
13. A node never receives a refresh token or a client secret, never talks to an identity provider, and has no endpoint that writes a credential.
14. The import never overwrites a credential rotated after it last ran.
16. Concurrent refreshes for one owner and server make exactly one call to the provider, and a spent refresh token is never presented twice.
15. A pod-local session directory never inherits a credentials file from the persona home.

- [ ] **Step 4: Index the field note** in `CLAUDE.md`.

- [ ] **Step 5: Full verification** — `bun test && bunx tsc --noEmit`, the Postgres run from Task 2, and the leak scan over the staged diff.

- [ ] **Step 6: Commit**

```bash
git add docs/site/_content/field-notes/2026-09-18-mcp-credential-ownership.md CLAUDE.md
git commit -m "docs: field note on unified MCP credential ownership"
```

---

## Out of scope

- The Anthropic provider credentials the agent uses for the model. They reach the node through the runtime bundle as environment variables; that path is untouched.
- Key rotation for `SLAUDE_MASTER_KEY`. The envelope is versioned so `v2:` can arrive without a data migration.
- Deleting the on-disk files Task 6 imported. They stay for rollback until the new path has soaked, then go in a separate change.
- An operator view of who has connected what.
- Phase 4's onboarding prompt on 1:1 entry.

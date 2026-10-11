# Control Plane Phase 2: Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ordinary users an account of their own, authenticated by the existing identity provider, and bind that account to a Slack user id by a proof the person cannot forge.

**Architecture:** The gateway grows a second web surface at `/portal`, separate from the operator panel at `/panel`. It reuses the panel's OpenID Connect round trip and HMAC secret but has its own cookies, its own token type and no role requirement, so a portal session can never be replayed as an operator session. The binding is proven by delivery: the agent posts an ephemeral Slack message containing a signed link that encodes the recipient's Slack user id, and redeeming it while signed in creates the binding. Control of the Slack account is proven because only that user can see an ephemeral message addressed to them; control of the email identity is proven by the identity provider.

**Tech Stack:** Bun, TypeScript, `bun:test`, sqlite and Postgres behind the `DbClient` seam, `@slack/web-api`.

**Spec:** `docs/superpowers/specs/2026-09-17-control-plane-and-onboarding-design.md` (section 5)

## Global Constraints

- Runtime is Bun. Tests run with `bun test <path>`; the whole suite is `bun test`.
- Public repository. No real names, employers, workspace names, channel ids or tokens anywhere, including tests and commit messages. Use `UTESTUSER1`, `TTESTTEAM1`, `alice@example.com`, `tenant-one`. Never use a value matching `[CUTGW]0[A-Z0-9]{8,}`, because the repository's own leak scan rejects it.
- No AI co-authorship trailers on any commit.
- One logical change per commit.
- **Every new table needs two definitions.** `src/db/migrations/*.sql` is Postgres-only syntax (`BIGINT`, `EXTRACT(EPOCH FROM NOW())`, `ADD COLUMN IF NOT EXISTS`). Sqlite's schema lives separately in `src/db/drivers/sqlite.ts` and uses `INTEGER`. A table added to only one of them works in tests and fails in the other dialect's CI job.
- Repo modules use `?` placeholders and `db.run` / `db.one` / `db.query` from `src/db/schema`. Follow `src/db/one-on-one.ts` exactly.
- The portal must never widen operator access. `guardRequest` and the panel's role check are not modified by any task here.
- Portal configuration reuses the panel's environment variables (`SLAUDE_PANEL_OIDC_*`, `SLAUDE_PANEL_SECRET`, `SLAUDE_PANEL_PUBLIC_URL`) and adds only `SLAUDE_PORTAL`. This is deliberate: one deployment, one identity provider client, one signing secret.
- The identity provider must have `<public url>/portal/auth/callback` registered as a second redirect URI. Document it; do not silently depend on it.

---

### Task 1: Extract the shared HS256 primitives

**Files:**
- Create: `src/gateway/auth/jwt.ts`
- Modify: `src/gateway/panel/auth/session.ts:56-92` (replace the private helpers with imports)
- Test: `tests/gateway/auth/jwt.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type VerifyReason = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured"`
  - `encodeJwt(payload: object, secret: string): string`
  - `decodeJwt<T>(token: string | null | undefined, secret: string | undefined, nowMs: number): { ok: true; payload: T & { exp: number } } | { ok: false; reason: VerifyReason }`
  - `timingSafeStringEqual(a: string, b: string): boolean`

Three modules will need the same hand-rolled HS256: the panel session, the portal session, and the link token. `src/gateway/panel/auth/session.ts` already has a correct implementation with its helpers private. Extract it rather than copy it a third time.

Leave `src/gateway/api/auth.ts` alone. It has its own copy, but it is the node-facing tool plane with its own claim validation and its own tests, and nothing in this phase needs it. Changing it would widen the blast radius for no functional gain.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/auth/jwt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { encodeJwt, decodeJwt, timingSafeStringEqual } from "../../../src/gateway/auth/jwt";

const SECRET = "a".repeat(32);
const NOW = 1_700_000_000_000;
const future = () => ({ exp: Math.floor(NOW / 1000) + 60 });

describe("encodeJwt / decodeJwt", () => {
  test("round-trips a payload", () => {
    const t = encodeJwt({ hello: "world", ...future() }, SECRET);
    const r = decodeJwt<{ hello: string }>(t, SECRET, NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.hello).toBe("world");
  });

  test("rejects a tampered payload", () => {
    const t = encodeJwt({ hello: "world", ...future() }, SECRET);
    const [h, , s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ hello: "evil", ...future() })).toString("base64url")}.${s}`;
    expect(decodeJwt(forged, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a different secret", () => {
    const t = encodeJwt({ ...future() }, SECRET);
    expect(decodeJwt(t, "b".repeat(32), NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("reports each rejection reason distinctly", () => {
    expect(decodeJwt("x", undefined, NOW)).toEqual({ ok: false, reason: "unconfigured" });
    expect(decodeJwt(null, SECRET, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(decodeJwt("only.two", SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    const expired = encodeJwt({ exp: Math.floor(NOW / 1000) - 1 }, SECRET);
    expect(decodeJwt(expired, SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  test("an alg of none in the header is ignored, not honoured", () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(future())).toString("base64url");
    expect(decodeJwt(`${head}.${body}.`, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("timingSafeStringEqual compares unequal lengths without throwing", () => {
    expect(timingSafeStringEqual("a", "aaaaaaaa")).toBe(false);
    expect(timingSafeStringEqual("same", "same")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/auth/jwt.test.ts`
Expected: FAIL with `Cannot find module '.../src/gateway/auth/jwt'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gateway/auth/jwt.ts` by moving the private helpers out of `src/gateway/panel/auth/session.ts` verbatim:

```ts
/**
 * Hand-rolled HS256 shared by every token slaude signs for a browser: the panel
 * session, the portal session and the onboarding link.
 *
 * A library is deliberately not used. We are both minter and verifier, so no
 * algorithm negotiation surface should exist: the header's `alg` is ignored and
 * HS256 is always enforced, which removes the alg-confusion class of bug by
 * construction rather than by configuration.
 *
 * src/gateway/api/auth.ts keeps its own copy on purpose. That is the
 * node-facing tool plane with its own claim validation and tests; it shares the
 * technique, not the code.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type VerifyReason =
  | "missing" | "malformed" | "bad_signature" | "expired" | "wrong_type" | "unconfigured";

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sign(headerAndPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(headerAndPayload).digest("base64url");
}

/** Constant-time equality; hashing first equalizes lengths so neither content
 *  nor length leaks through the comparison. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function encodeJwt(payload: object, secret: string): string {
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const body = b64uJson(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function decodeJwt<T>(
  token: string | null | undefined,
  secret: string | undefined,
  nowMs: number,
): { ok: true; payload: T & { exp: number } } | { ok: false; reason: VerifyReason } {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  if (!timingSafeStringEqual(sign(`${head}.${body}`, secret), sig)) return { ok: false, reason: "bad_signature" };
  let payload: T & { exp: number };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
```

In `src/gateway/panel/auth/session.ts`, delete the local `b64uJson`, `sign`, `timingSafeStringEqual`, `encode` and `decode`, and import instead. Keep `VerifyReason` exported from `session.ts` as a re-export so existing importers are untouched:

```ts
import { encodeJwt, decodeJwt, type VerifyReason } from "../../auth/jwt";
export type { VerifyReason };
```

Then replace the two call sites: `encode(payload, secret)` becomes `encodeJwt(payload, secret)`, and `decode<T>(token, secret, nowMs)` becomes `decodeJwt<T>(token, secret, nowMs)`.

- [ ] **Step 4: Run tests to verify nothing changed**

Run: `bun test tests/gateway/auth/jwt.test.ts tests/panel && bunx tsc --noEmit`
Expected: PASS. Every pre-existing panel auth test must still pass unchanged — this task has no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/auth/jwt.ts src/gateway/panel/auth/session.ts tests/gateway/auth/jwt.test.ts
git commit -m "refactor(auth): extract the shared HS256 primitives

The portal session and the onboarding link need the same hand-rolled HS256 the
panel session already implements. Extract it once rather than copy it a third
time. No behaviour change; the panel's own tests are the regression guard.

src/gateway/api/auth.ts keeps its copy deliberately: it is the node-facing tool
plane with its own claim validation and tests, and nothing here needs it."
```

---

### Task 2: Accounts and Slack identity bindings

**Files:**
- Create: `src/db/migrations/0007_accounts.sql`
- Modify: `src/db/drivers/sqlite.ts` (add the two `CREATE TABLE` statements beside `one_on_one_locks`)
- Create: `src/db/accounts.ts`
- Test: `tests/db/accounts.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AccountRow { id: string; issuer: string; subject: string; email: string; created_at: number; updated_at: number }`
  - `interface SlackIdentityRow { team_id: string; slack_user_id: string; account_id: string; linked_at: number; linked_via: string }`
  - `upsertAccount(i: { issuer: string; subject: string; email: string }): Promise<AccountRow>`
  - `findAccountById(id: string): Promise<AccountRow | null>`
  - `findAccountBySubject(issuer: string, subject: string): Promise<AccountRow | null>`
  - `accountForSlackUser(teamId: string, slackUserId: string): Promise<AccountRow | null>`
  - `linkSlackIdentity(i: { teamId: string; slackUserId: string; accountId: string; via: string }): Promise<{ ok: true; created: boolean } | { ok: false; reason: "already-linked"; existingAccountId: string }>`
  - `unlinkSlackIdentity(teamId: string, slackUserId: string, accountId: string): Promise<boolean>`
  - `slackIdentitiesForAccount(accountId: string): Promise<SlackIdentityRow[]>`
  - `_wipeForTests(): Promise<void>`

One Slack identity maps to exactly one account, which is why `(team_id, slack_user_id)` is the primary key. One account may hold several Slack identities, because a person can be in more than one workspace.

`linkSlackIdentity` refuses to rebind a Slack identity that already points at a different account. That refusal is what makes the link token effectively single-use without a separate redemption ledger: once a Slack id is bound, a replayed token can only be a no-op or a rejection.

- [ ] **Step 1: Write the failing test**

Create `tests/db/accounts.test.ts`. Read the top of an existing file in `tests/db/` first and copy its database setup harness exactly.

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import * as Accounts from "../../src/db/accounts";

const ISS = "https://idp.example.com";

beforeEach(async () => {
  await Accounts._wipeForTests();
});

describe("accounts", () => {
  test("upsert creates once and is idempotent on the same subject", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect(b.id).toBe(a.id);
  });

  test("upsert refreshes a changed email without changing identity", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice.new@example.com" });
    expect(b.id).toBe(a.id);
    expect(b.email).toBe("alice.new@example.com");
  });

  test("the same subject at a different issuer is a different account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: "https://other.example.com", subject: "sub-1", email: "alice@example.com" });
    expect(b.id).not.toBe(a.id);
  });

  test("lookup by subject finds the account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    expect((await Accounts.findAccountBySubject(ISS, "sub-1"))?.id).toBe(a.id);
    expect(await Accounts.findAccountBySubject(ISS, "nobody")).toBeNull();
  });
});

describe("slack identity binding", () => {
  test("links a slack user to an account and reads back", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });

    const r = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(r).toEqual({ ok: true, created: true });
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.email).toBe("alice@example.com");
  });

  test("re-linking the same pair is idempotent, not an error", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    const again = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(again).toEqual({ ok: true, created: false });
  });

  // The whole point of the binding: a token replayed by someone else cannot
  // steal a Slack identity that is already claimed.
  test("refuses to rebind a slack user to a different account", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    const r = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: b.id, via: "signed-link" });

    expect(r).toEqual({ ok: false, reason: "already-linked", existingAccountId: a.id });
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(a.id);
  });

  test("the same slack user id in two workspaces binds independently", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });

    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
    const second = await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM2", slackUserId: "UTESTUSER1", accountId: b.id, via: "signed-link" });

    expect(second).toEqual({ ok: true, created: true });
    expect((await Accounts.accountForSlackUser("TTESTTEAM2", "UTESTUSER1"))?.id).toBe(b.id);
  });

  test("one account can hold several slack identities", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM2", slackUserId: "UTESTUSER2", accountId: a.id, via: "signed-link" });

    expect(await Accounts.slackIdentitiesForAccount(a.id)).toHaveLength(2);
  });

  test("unlink only removes the caller's own binding", async () => {
    const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
    const b = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });

    expect(await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", b.id)).toBe(false);
    expect(await Accounts.unlinkSlackIdentity("TTESTTEAM1", "UTESTUSER1", a.id)).toBe(true);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("an unbound slack user resolves to null", async () => {
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UNBOUND1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/accounts.test.ts`
Expected: FAIL with `Cannot find module '.../src/db/accounts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/db/migrations/0007_accounts.sql` (Postgres dialect, matching `0001_tenancy.sql`):

```sql
-- End-user accounts and their Slack bindings (phase 2 identity).
--
-- An account is a local projection of an external identity: the identity
-- provider owns authentication, we own the one thing it cannot give us, which
-- is which Slack user this person is.

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  issuer     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (issuer, subject)
);

-- (team_id, slack_user_id) is the PRIMARY KEY, so one Slack identity binds to
-- exactly one account. That uniqueness is what makes a replayed onboarding link
-- a no-op or a rejection rather than a takeover. An account may appear here
-- more than once: one person, several workspaces.
CREATE TABLE IF NOT EXISTS slack_identities (
  team_id       TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at     BIGINT NOT NULL,
  linked_via    TEXT NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_identities_account
  ON slack_identities (account_id);
```

In `src/db/drivers/sqlite.ts`, add the sqlite equivalents alongside the other `CREATE TABLE IF NOT EXISTS` statements, using `INTEGER` for timestamps:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  issuer     TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS slack_identities (
  team_id       TEXT    NOT NULL,
  slack_user_id TEXT    NOT NULL,
  account_id    TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at     INTEGER NOT NULL,
  linked_via    TEXT    NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_identities_account
  ON slack_identities (account_id);
```

Create `src/db/accounts.ts`:

```ts
/**
 * End-user accounts and their Slack bindings (phase 2 identity).
 *
 * The account is keyed on (issuer, subject) rather than email, because email is
 * mutable at the provider and subject is not. Email is carried for display and
 * refreshed on each login.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";

export interface AccountRow {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  created_at: number;
  updated_at: number;
}

export interface SlackIdentityRow {
  team_id: string;
  slack_user_id: string;
  account_id: string;
  linked_at: number;
  linked_via: string;
}

/** Create the account or refresh its email. Identity is (issuer, subject). */
export async function upsertAccount(i: { issuer: string; subject: string; email: string }): Promise<AccountRow> {
  const now = Date.now();
  await db.run(
    `INSERT INTO accounts (id, issuer, subject, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(issuer, subject)
     DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
    [randomUUID(), i.issuer, i.subject, i.email, now, now],
  );
  const row = await findAccountBySubject(i.issuer, i.subject);
  if (!row) throw new Error("account upsert did not produce a row");
  return row;
}

export async function findAccountById(id: string): Promise<AccountRow | null> {
  return db.one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
}

export async function findAccountBySubject(issuer: string, subject: string): Promise<AccountRow | null> {
  return db.one<AccountRow>("SELECT * FROM accounts WHERE issuer = ? AND subject = ?", [issuer, subject]);
}

export async function accountForSlackUser(teamId: string, slackUserId: string): Promise<AccountRow | null> {
  return db.one<AccountRow>(
    `SELECT a.* FROM accounts a
     JOIN slack_identities s ON s.account_id = a.id
     WHERE s.team_id = ? AND s.slack_user_id = ?`,
    [teamId, slackUserId],
  );
}

/**
 * Bind a Slack identity to an account.
 *
 * Rebinding to a DIFFERENT account is refused rather than overwritten. That
 * refusal is what makes a replayed onboarding link harmless: the second
 * redemption can only be a no-op (same account) or a rejection.
 */
export async function linkSlackIdentity(
  i: { teamId: string; slackUserId: string; accountId: string; via: string },
): Promise<{ ok: true; created: boolean } | { ok: false; reason: "already-linked"; existingAccountId: string }> {
  const existing = await db.one<SlackIdentityRow>(
    "SELECT * FROM slack_identities WHERE team_id = ? AND slack_user_id = ?",
    [i.teamId, i.slackUserId],
  );
  if (existing) {
    if (existing.account_id === i.accountId) return { ok: true, created: false };
    return { ok: false, reason: "already-linked", existingAccountId: existing.account_id };
  }
  await db.run(
    `INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via)
     VALUES (?, ?, ?, ?, ?)`,
    [i.teamId, i.slackUserId, i.accountId, Date.now(), i.via],
  );
  return { ok: true, created: true };
}

/** Remove a binding, but only when it belongs to the calling account. */
export async function unlinkSlackIdentity(teamId: string, slackUserId: string, accountId: string): Promise<boolean> {
  const r = await db.run(
    "DELETE FROM slack_identities WHERE team_id = ? AND slack_user_id = ? AND account_id = ?",
    [teamId, slackUserId, accountId],
  );
  return (r.changes ?? 0) > 0;
}

export async function slackIdentitiesForAccount(accountId: string): Promise<SlackIdentityRow[]> {
  return db.query<SlackIdentityRow>("SELECT * FROM slack_identities WHERE account_id = ?", [accountId]);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM slack_identities");
  await db.run("DELETE FROM accounts");
}
```

`RunResult` carries `changes`; the migration runner relies on it at `src/db/migrate.ts:113` (`if (claim.changes === 0) return false;`).

Two conventions this migration follows, confirmed against the existing files: the numbered filename must match `^(\d{4})_([a-z0-9_-]+)\.sql$` or `loadMigrations` silently skips it (`src/db/migrate.ts:36`), and epoch-millisecond columns are `BIGINT` on Postgres. Migrations run on the Postgres path only, which is exactly why the sqlite DDL above is not optional.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/db/accounts.test.ts && SLAUDE_DB=pg bun test tests/db/accounts.test.ts`
Expected: PASS on both dialects. If the Postgres run fails on missing tables, the migration was not picked up — check that `0007_accounts.sql` is discovered the same way `0006` is.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/0007_accounts.sql src/db/drivers/sqlite.ts src/db/accounts.ts tests/db/accounts.test.ts
git commit -m "feat(db): accounts and slack identity bindings

An account is a local projection of an external identity, keyed on (issuer,
subject) because email is mutable at the provider and subject is not.

(team_id, slack_user_id) is the primary key of the binding table, so one Slack
identity binds to exactly one account. Rebinding to a different account is
refused rather than overwritten, which is what makes a replayed onboarding link
a no-op or a rejection instead of a takeover."
```

---

### Task 3: The onboarding link token

**Files:**
- Create: `src/gateway/portal/link-token.ts`
- Test: `tests/gateway/portal/link-token.test.ts` (create)

**Interfaces:**
- Consumes: `encodeJwt`, `decodeJwt`, `VerifyReason` from Task 1.
- Produces:
  - `const LINK_TTL_SEC = 900`
  - `interface LinkClaims { typ: "link"; team: string; slackUser: string; jti: string; iat: number; exp: number }`
  - `mintLinkToken(i: { teamId: string; slackUserId: string }, opts?: { secret?: string; now?: number; ttlSec?: number }): string`
  - `verifyLinkToken(token: string | null | undefined, opts?: { secret?: string; now?: number }): { ok: true; claims: LinkClaims } | { ok: false; reason: VerifyReason }`

This token is a bearer credential for a Slack identity, so it is deliberately narrow: fifteen minutes, its own `typ` so a portal session cookie can never be presented as one, and the team id bound in so a token minted for one workspace cannot bind in another.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/portal/link-token.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mintLinkToken, verifyLinkToken, LINK_TTL_SEC } from "../../../src/gateway/portal/link-token";
import { encodeJwt } from "../../../src/gateway/auth/jwt";

const SECRET = "c".repeat(32);
const NOW = 1_700_000_000_000;
const opts = { secret: SECRET, now: NOW };

describe("onboarding link token", () => {
  test("round-trips the slack identity it was minted for", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const r = verifyLinkToken(t, opts);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims.team).toBe("TTESTTEAM1");
    expect(r.ok && r.claims.slackUser).toBe("UTESTUSER1");
  });

  test("expires within the advertised window", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const justInside = { secret: SECRET, now: NOW + (LINK_TTL_SEC - 1) * 1000 };
    const justOutside = { secret: SECRET, now: NOW + (LINK_TTL_SEC + 1) * 1000 };
    expect(verifyLinkToken(t, justInside).ok).toBe(true);
    expect(verifyLinkToken(t, justOutside)).toEqual({ ok: false, reason: "expired" });
  });

  test("a different secret does not verify", () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    expect(verifyLinkToken(t, { secret: "d".repeat(32), now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  // A token of another type must never be usable here, even though every token
  // this deployment signs shares one secret.
  test("a token of another type is rejected", () => {
    const foreign = encodeJwt(
      { typ: "at", sub: "s", email: "alice@example.com", exp: Math.floor(NOW / 1000) + 600 },
      SECRET,
    );
    expect(verifyLinkToken(foreign, opts)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("a token missing the slack identity is malformed, not accepted", () => {
    const partial = encodeJwt({ typ: "link", team: "TTESTTEAM1", exp: Math.floor(NOW / 1000) + 600 }, SECRET);
    expect(verifyLinkToken(partial, opts)).toEqual({ ok: false, reason: "malformed" });
  });

  test("two mints for the same identity differ", () => {
    const a = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    const b = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, opts);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/portal/link-token.test.ts`
Expected: FAIL with `Cannot find module '.../src/gateway/portal/link-token'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gateway/portal/link-token.ts`:

```ts
/**
 * The onboarding link token: proof that the holder controls a Slack account.
 *
 * It is delivered as an ephemeral Slack message addressed to one user, so only
 * that person can read it. Redeeming it while signed in to the portal binds
 * their Slack identity to their account. Delivery proves the Slack side; the
 * identity provider proves the email side.
 *
 * It is a bearer credential for a Slack identity, so it is narrow on purpose:
 * short-lived, team-bound so a token from one workspace cannot bind in another,
 * and carrying its own `typ` so no other token this deployment signs with the
 * same secret can be presented in its place.
 *
 * Single use is enforced by the binding rather than by a redemption ledger:
 * slack_identities has (team_id, slack_user_id) as its primary key and refuses
 * to rebind, so a replay is a no-op or a rejection. See src/db/accounts.ts.
 */
import { randomBytes } from "node:crypto";
import { env } from "../../config/env";
import { encodeJwt, decodeJwt, type VerifyReason } from "../auth/jwt";

export const LINK_TTL_SEC = 900;

export interface LinkClaims {
  typ: "link";
  team: string;
  slackUser: string;
  jti: string;
  iat: number;
  exp: number;
}

export function mintLinkToken(
  i: { teamId: string; slackUserId: string },
  opts: { secret?: string; now?: number; ttlSec?: number } = {},
): string {
  const secret = opts.secret ?? env.panel.secret();
  if (!secret) throw new Error("SLAUDE_PANEL_SECRET is not set — cannot mint onboarding links");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: LinkClaims = {
    typ: "link",
    team: i.teamId,
    slackUser: i.slackUserId,
    jti: randomBytes(9).toString("base64url"),
    iat,
    exp: iat + (opts.ttlSec ?? LINK_TTL_SEC),
  };
  return encodeJwt(claims, secret);
}

export function verifyLinkToken(
  token: string | null | undefined,
  opts: { secret?: string; now?: number } = {},
): { ok: true; claims: LinkClaims } | { ok: false; reason: VerifyReason } {
  const r = decodeJwt<LinkClaims>(token, opts.secret ?? env.panel.secret(), opts.now ?? Date.now());
  if (!r.ok) return r;
  const c = r.payload;
  if (c.typ !== "link") return { ok: false, reason: "wrong_type" };
  if (typeof c.team !== "string" || !c.team) return { ok: false, reason: "malformed" };
  if (typeof c.slackUser !== "string" || !c.slackUser) return { ok: false, reason: "malformed" };
  return { ok: true, claims: c };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/portal/link-token.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/portal/link-token.ts tests/gateway/portal/link-token.test.ts
git commit -m "feat(portal): onboarding link token

A bearer credential for a Slack identity, so it is narrow by construction:
fifteen minutes, team-bound so a token from one workspace cannot bind in
another, and carrying its own type claim so no other token signed with the same
secret can stand in for it.

Single use is enforced by the binding table's primary key rather than by a
redemption ledger: a replay can only be a no-op or a rejection."
```

---

### Task 4: Portal session tokens

**Files:**
- Create: `src/gateway/portal/session.ts`
- Test: `tests/gateway/portal/session.test.ts` (create)

**Interfaces:**
- Consumes: `encodeJwt`, `decodeJwt`, `VerifyReason` from Task 1.
- Produces:
  - `const PORTAL_AT_COOKIE = "portal_at"`, `PORTAL_RT_COOKIE = "portal_rt"`, `PORTAL_FLOW_COOKIE = "portal_flow"`
  - `const PORTAL_AT_PATH = "/portal"`, `PORTAL_RT_PATH = "/portal/auth/refresh"`, `PORTAL_FLOW_PATH = "/portal/auth"`
  - `const PORTAL_AT_TTL_SEC = 900`, `PORTAL_RT_TTL_SEC = 28800`, `PORTAL_FLOW_TTL_SEC = 600`
  - `interface PortalClaims { sub: string; email: string; iss: string; typ: "portal_at" | "portal_rt"; iat: number; exp: number }`
  - `interface PortalFlowPayload { state: string; nonce: string; verifier: string; returnTo: string }`
  - `mintPortalSession(who: { sub: string; email: string; iss: string }, typ: "portal_at" | "portal_rt", opts?): string`
  - `verifyPortalSession(token, expect: "portal_at" | "portal_rt", opts?): { ok: true; claims: PortalClaims } | { ok: false; reason: VerifyReason }`
  - `mintPortalFlow(payload: PortalFlowPayload, opts?): string`
  - `verifyPortalFlow(token, opts?): { ok: true; payload: PortalFlowPayload } | { ok: false; reason: VerifyReason }`

Distinct token types are the point of this module. The panel and the portal share one signing secret, so the only thing preventing a portal user from presenting their cookie to an operator route is the type claim and the cookie path. Reuse `parseCookies`, `setCookie` and `clearCookie` from `src/gateway/panel/auth/session.ts` rather than re-implementing them.

Note `iss` is carried in the claims because accounts are keyed on `(issuer, subject)`, and the guard re-resolves the account on every request.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/portal/session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  mintPortalSession, verifyPortalSession, mintPortalFlow, verifyPortalFlow,
  PORTAL_AT_COOKIE, PORTAL_AT_PATH,
} from "../../../src/gateway/portal/session";
import { mintSession } from "../../../src/gateway/panel/auth/session";

const SECRET = "e".repeat(32);
const NOW = 1_700_000_000_000;
const o = { secret: SECRET, now: NOW };
const WHO = { sub: "sub-1", email: "alice@example.com", iss: "https://idp.example.com" };

describe("portal session tokens", () => {
  test("round-trips the identity", () => {
    const r = verifyPortalSession(mintPortalSession(WHO, "portal_at", o), "portal_at", o);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims.email).toBe("alice@example.com");
    expect(r.ok && r.claims.iss).toBe("https://idp.example.com");
  });

  test("a refresh token cannot be replayed as an access token", () => {
    const rt = mintPortalSession(WHO, "portal_rt", o);
    expect(verifyPortalSession(rt, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  // The panel and the portal share one signing secret, so type separation is
  // the boundary. A panel operator cookie must not authenticate a portal user,
  // and the reverse is covered in the panel guard's own tests.
  test("a panel session token is not a portal session token", () => {
    const panelAt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at", { secret: SECRET, now: NOW });
    expect(verifyPortalSession(panelAt, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("an onboarding link token is not a portal session token", () => {
    const { mintLinkToken } = require("../../../src/gateway/portal/link-token");
    const link = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, o);
    expect(verifyPortalSession(link, "portal_at", o)).toEqual({ ok: false, reason: "wrong_type" });
  });

  test("the flow payload round-trips", () => {
    const p = { state: "s", nonce: "n", verifier: "v", returnTo: "/portal" };
    const r = verifyPortalFlow(mintPortalFlow(p, o), o);
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload).toEqual(p);
  });

  test("cookie name and path are scoped to the portal", () => {
    expect(PORTAL_AT_COOKIE).toBe("portal_at");
    expect(PORTAL_AT_PATH).toBe("/portal");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/portal/session.test.ts`
Expected: FAIL with `Cannot find module '.../src/gateway/portal/session'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gateway/portal/session.ts` mirroring `src/gateway/panel/auth/session.ts`, with these differences: cookie names `portal_at` / `portal_rt` / `portal_flow`, paths `/portal`, `/portal/auth/refresh`, `/portal/auth`, token types `portal_at` / `portal_rt` / `portal_flow`, and an `iss` claim carried alongside `sub` and `email`. Import `encodeJwt` and `decodeJwt` from `../auth/jwt`, and re-export `parseCookies`, `setCookie`, `clearCookie` from `../panel/auth/session` so the portal routes import cookie helpers from one place:

```ts
export { parseCookies, setCookie, clearCookie } from "../panel/auth/session";
```

`verifyPortalSession` must check `typ` against the expected value and reject `sub`, `email` or `iss` that are not strings, exactly as the panel version does.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/portal && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/portal/session.ts tests/gateway/portal/session.test.ts
git commit -m "feat(portal): portal session tokens, separate from the panel's

The panel and the portal share one signing secret, so the boundary between an
operator session and an end-user session is the type claim plus the cookie path.
Distinct types mean a portal cookie can never be presented as an operator
credential, or the reverse, rather than relying on the role lookup to catch it.

Carries the issuer alongside the subject, because accounts are keyed on
(issuer, subject) and the guard re-resolves the account per request."
```

---

### Task 5: Portal configuration and auth routes

**Files:**
- Create: `src/gateway/portal/config.ts`
- Create: `src/gateway/portal/auth-routes.ts`
- Modify: `src/config/env.ts` (add the `portal` accessor group)
- Modify: `src/server.ts` (call `assertPortalConfig()` beside `assertPanelConfig()`)
- Test: `tests/gateway/portal/auth-routes.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's `upsertAccount`, Task 4's portal session helpers.
- Produces:
  - `portalRedirectUri(): string` — `${env.panel.publicUrl()}/portal/auth/callback`
  - `assertPortalConfig(): void`
  - `portalOidcConfig(): OidcConfig` — the panel's config with `redirectUri` replaced
  - `createPortalAuthRoutes(deps?: { fetchImpl?: typeof fetch }): { handle(req: Request, seg: string[]): Promise<Response | null> }`
  - `env.portal.enabled(): boolean` reading `SLAUDE_PORTAL`

The OpenID Connect protocol module is already relying-party generic: `buildAuthorizeUrl`, `exchangeCode` and `identityFromIdToken` all take an `OidcConfig` parameter. Only `oidcConfigFromEnv()` hardcodes the panel redirect URI, so the portal needs a config builder, not a second protocol implementation.

The decisive difference from the panel: **there is no role check.** Any identity the provider authenticates gets a portal session and an account row. That is correct and intended. An account on its own grants nothing; it only becomes useful once bound to a Slack identity, and binding requires a link only that Slack user can see.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/portal/auth-routes.test.ts`. Model the identity-provider stub on the existing panel auth route tests — read `tests/panel/` first and reuse their `fetchImpl` stub shape rather than inventing one.

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { createPortalAuthRoutes } from "../../../src/gateway/portal/auth-routes";
import { PORTAL_FLOW_COOKIE, PORTAL_AT_COOKIE, verifyPortalSession, parseCookies } from "../../../src/gateway/portal/session";
import * as Accounts from "../../../src/db/accounts";

// Fill these in from the panel test harness: a fetchImpl that answers the
// discovery document and the token endpoint with a signed-shaped id_token.
// The id_token signature is not verified (see the note atop oidc.ts), so the
// stub only needs a well-formed base64url payload carrying sub, email, nonce.

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = "f".repeat(32);
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = "https://idp.example.com";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "portal-client";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "portal-secret";
  await Accounts._wipeForTests();
});

describe("portal auth routes", () => {
  test("login redirects to the provider and sets the flow cookie", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp() });
    const res = await routes.handle(new Request("https://slaude.example.com/portal/auth/login"), ["portal", "auth", "login"]);
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location")).toContain("https://idp.example.com");
    expect(res!.headers.get("set-cookie")).toContain(PORTAL_FLOW_COOKIE);
  });

  test("the authorize request uses the portal callback, not the panel's", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp() });
    const res = await routes.handle(new Request("https://slaude.example.com/portal/auth/login"), ["portal", "auth", "login"]);
    const loc = new URL(res!.headers.get("location")!);
    expect(loc.searchParams.get("redirect_uri")).toBe("https://slaude.example.com/portal/auth/callback");
  });

  // The decisive difference from the panel, which 403s an identity in no role
  // list. Onboarding unlocks connected tools; it never gates the agent.
  test("an identity in no operator role list is still granted a portal session", async () => {
    const { res } = await completeLogin("alice@example.com", "sub-1");
    expect(res.status).toBe(302);
    const cookies = res.headers.getSetCookie().join("; ");
    expect(cookies).toContain(PORTAL_AT_COOKIE);
  });

  test("a successful login creates the account row", async () => {
    await completeLogin("alice@example.com", "sub-1");
    expect((await Accounts.findAccountBySubject("https://idp.example.com", "sub-1"))?.email)
      .toBe("alice@example.com");
  });

  test("logging in twice does not create a second account", async () => {
    await completeLogin("alice@example.com", "sub-1");
    await completeLogin("alice@example.com", "sub-1");
    const a = await Accounts.findAccountBySubject("https://idp.example.com", "sub-1");
    expect(a).not.toBeNull();
  });

  test("the session cookie carries the portal token type", async () => {
    const { res } = await completeLogin("alice@example.com", "sub-1");
    const jar = parseCookies(res.headers.getSetCookie().join("; "));
    expect(verifyPortalSession(jar[PORTAL_AT_COOKIE], "portal_at").ok).toBe(true);
  });

  test("a state mismatch is refused", async () => {
    const { res } = await completeLogin("alice@example.com", "sub-1", { tamperState: true });
    expect(res.status).toBe(400);
  });

  test("returnTo is confined to the portal", async () => {
    const { res } = await completeLogin("alice@example.com", "sub-1", { returnTo: "https://evil.example.com/" });
    expect(res.headers.get("location")).toBe("/portal");
  });
});
```

Write `stubIdp()` and `completeLogin()` as local helpers in this file, driving login then callback through `routes.handle` and carrying the flow cookie between them.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/portal/auth-routes.test.ts`
Expected: FAIL with `Cannot find module '.../src/gateway/portal/auth-routes'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/config/env.ts`, beside the existing `panel` group:

```ts
  portal: {
    /** Enable the end-user onboarding portal. Default off. It reuses the
     *  panel's OIDC client, public URL and signing secret on purpose: one
     *  deployment, one provider registration, one secret. */
    enabled: () => {
      const raw = opt("SLAUDE_PORTAL", "0").toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    },
  },
```

Create `src/gateway/portal/config.ts`:

```ts
import { env } from "../../config/env";
import { oidcConfigFromEnv, type OidcConfig } from "../panel/auth/oidc";

/** The portal's own redirect URI. It must be registered with the identity
 *  provider ALONGSIDE the panel's — same client, two callbacks. */
export function portalRedirectUri(): string {
  return `${env.panel.publicUrl()}/portal/auth/callback`;
}

/** The panel's provider settings with the portal's callback substituted. */
export function portalOidcConfig(): OidcConfig {
  return { ...oidcConfigFromEnv(), redirectUri: portalRedirectUri() };
}

/**
 * Validate the portal configuration. The portal rides on the panel's provider
 * settings, so it cannot be enabled without them. No-op when disabled.
 */
export function assertPortalConfig(): void {
  if (!env.portal.enabled()) return;
  const required: Array<[string, () => string]> = [
    ["SLAUDE_PANEL_OIDC_ISSUER", () => env.panel.oidcIssuer()],
    ["SLAUDE_PANEL_OIDC_CLIENT_ID", () => env.panel.oidcClientId()],
    ["SLAUDE_PANEL_OIDC_CLIENT_SECRET", () => env.panel.oidcClientSecret()],
    ["SLAUDE_PANEL_PUBLIC_URL", () => env.panel.publicUrl()],
    ["SLAUDE_PANEL_SECRET", () => env.panel.secret()],
  ];
  for (const [name, read] of required) {
    if (!read()) throw new Error(`${name} is required when SLAUDE_PORTAL=1`);
  }
  if (env.panel.secret().length < 32) {
    throw new Error("SLAUDE_PANEL_SECRET must be at least 32 characters");
  }
}
```

Create `src/gateway/portal/auth-routes.ts` modelled on `src/gateway/panel/auth/routes.ts`, with these differences:

- `oidcConfigFromEnv()` becomes `portalOidcConfig()`.
- `safeReturnTo` confines to `/portal` instead of `/panel`. Keep the control-character rejection and the `//` rejection verbatim — they stop a CRLF or a protocol-relative URL becoming a redirect.
- The callback has **no role check**. After `identityFromIdToken` succeeds it calls `upsertAccount({ issuer: cfg.issuer, subject: who.sub, email: who.identity })` and mints the portal cookies.
- `handle` matches `seg[0] === "portal" && seg[1] === "auth"` and dispatches `login`, `callback`, `refresh`, `logout`, `me`.
- `me` returns `{ email, accountId, slackIdentities }` rather than `{ email, role }`.

In `src/server.ts`, call `assertPortalConfig()` immediately after `assertPanelConfig()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/portal tests/panel tests/config && bunx tsc --noEmit`
Expected: PASS, including every pre-existing panel and config test.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/portal/config.ts src/gateway/portal/auth-routes.ts src/config/env.ts src/server.ts tests/gateway/portal/auth-routes.test.ts
git commit -m "feat(portal): sign-in for ordinary users

The OIDC protocol module was already relying-party generic — only the redirect
URI was panel-specific — so the portal needs a config builder, not a second
protocol implementation. Same provider client, second callback.

The decisive difference is that there is no role check: any identity the
provider authenticates gets a portal session and an account. That is intended.
An account grants nothing on its own; it becomes useful only once bound to a
Slack identity, and binding requires a link only that Slack user can see."
```

---

### Task 6: The portal surface and the redeem flow

**Files:**
- Create: `src/gateway/portal/guard.ts`
- Create: `src/gateway/portal/api.ts`
- Modify: `src/gateway/core/gateway.ts:2431-2452` (mount the portal beside the panel)
- Test: `tests/gateway/portal/api.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 5.
- Produces:
  - `guardPortal(req: Request, opts: { html: boolean }): { ok: true; account: AccountRow; expMs: number } | { ok: false; response: Response }`
  - `createPortalApi(): { fetch(req: Request): Promise<Response | null> }`
  - Routes: `GET /portal/link?t=<token>`, `POST /portal/api/link`, `DELETE /portal/api/link`, `GET /portal/api/me`

`guardPortal` re-resolves the account from `(iss, sub)` on every request rather than trusting an id baked into the token, matching the panel's reasoning for re-resolving roles: a deleted account must stop working at the next request, not at the next refresh.

**Redeeming must not be a bare GET.** A GET that mutates can be triggered cross-site by an image tag, and the consequence here is specific and serious: an attacker holding a valid link for their *own* Slack id could cause a signed-in victim's browser to redeem it, binding the attacker's Slack identity to the victim's account. The attacker's Slack messages would then run on the victim's credentials. So `GET /portal/link` only renders a confirmation page, and the actual binding happens on `POST /portal/api/link` behind the same custom-header anti-CSRF check the panel already uses.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/portal/api.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { createPortalApi } from "../../../src/gateway/portal/api";
import { mintPortalSession, PORTAL_AT_COOKIE } from "../../../src/gateway/portal/session";
import { mintLinkToken } from "../../../src/gateway/portal/link-token";
import * as Accounts from "../../../src/db/accounts";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);

function signedIn(sub: string, email: string): string {
  return `${PORTAL_AT_COOKIE}=${mintPortalSession({ sub, email, iss: ISS }, "portal_at")}`;
}

function post(body: unknown, cookie?: string, csrf = true): Request {
  return new Request("https://slaude.example.com/portal/api/link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-portal-csrf": "1" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISS;
  await Accounts._wipeForTests();
  await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
});

describe("redeeming an onboarding link", () => {
  test("binds the slack identity in the token to the signed-in account", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(200);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.email).toBe("alice@example.com");
  });

  test("an anonymous redeem is refused and binds nothing", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }));

    expect(res!.status).toBe(401);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  // The attack this shape exists to stop: a cross-site request cannot set a
  // custom header, so it cannot bind the attacker's Slack id to a victim's
  // signed-in account.
  test("a request without the anti-CSRF header is refused", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com"), false));

    expect(res!.status).toBe(403);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("an expired token is refused", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }, { now: Date.now() - 3_600_000 });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(400);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("a slack identity already bound to someone else is a conflict", async () => {
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: other.id, via: "signed-link" });
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(res!.status).toBe(409);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(other.id);
  });

  test("redeeming the same token twice for the same account is idempotent", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });
    const api = createPortalApi();
    await api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    const again = await api.fetch(post({ token: t }, signedIn("sub-1", "alice@example.com")));

    expect(again!.status).toBe(200);
  });

  test("the confirmation page does not itself bind", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(
      new Request(`https://slaude.example.com/portal/link?t=${t}`, { headers: { cookie: signedIn("sub-1", "alice@example.com") } }),
    );

    expect(res!.status).toBe(200);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("the confirmation page sends an anonymous visitor to login, preserving the token", async () => {
    const t = mintLinkToken({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" });

    const res = await createPortalApi().fetch(new Request(`https://slaude.example.com/portal/link?t=${t}`));

    expect(res!.status).toBe(302);
    const loc = res!.headers.get("location")!;
    expect(loc).toStartWith("/portal/auth/login?returnTo=");
    expect(decodeURIComponent(loc)).toContain(t);
  });
});

describe("unlinking", () => {
  test("a user can remove their own binding", async () => {
    const a = await Accounts.findAccountBySubject(ISS, "sub-1");
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a!.id, via: "signed-link" });
    const req = new Request("https://slaude.example.com/portal/api/link", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-portal-csrf": "1", cookie: signedIn("sub-1", "alice@example.com") },
      body: JSON.stringify({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }),
    });

    const res = await createPortalApi().fetch(req);

    expect(res!.status).toBe(200);
    expect(await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1")).toBeNull();
  });

  test("a user cannot remove someone else's binding", async () => {
    const other = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "bob@example.com" });
    await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: other.id, via: "signed-link" });
    const req = new Request("https://slaude.example.com/portal/api/link", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-portal-csrf": "1", cookie: signedIn("sub-1", "alice@example.com") },
      body: JSON.stringify({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1" }),
    });

    const res = await createPortalApi().fetch(req);

    expect(res!.status).toBe(404);
    expect((await Accounts.accountForSlackUser("TTESTTEAM1", "UTESTUSER1"))?.id).toBe(other.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/portal/api.test.ts`
Expected: FAIL with `Cannot find module '.../src/gateway/portal/api'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gateway/portal/guard.ts`:

```ts
/**
 * Per-request end-user gate. Unlike the panel guard there is no role check:
 * any authenticated identity is a legitimate portal user. The account is
 * re-resolved from (issuer, subject) on every request rather than carried as a
 * token claim, so a deleted account stops working at the next request.
 */
import { findAccountBySubject, type AccountRow } from "../../db/accounts";
import { PORTAL_AT_COOKIE, parseCookies, verifyPortalSession } from "./session";

export type PortalGuardResult =
  | { ok: true; account: AccountRow; expMs: number }
  | { ok: false; response: Response };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const returnTo = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: `/portal/auth/login?returnTo=${returnTo}` } });
}

export async function guardPortal(req: Request, opts: { html: boolean }): Promise<PortalGuardResult> {
  const jar = parseCookies(req.headers.get("cookie"));
  const r = verifyPortalSession(jar[PORTAL_AT_COOKIE], "portal_at");
  if (!r.ok) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    // The reason goes to the operator's log, not the caller: telling a prober
    // how their forgery failed is free help.
    console.warn(`[portal] session rejected: ${r.reason}`);
    return { ok: false, response: json(401, { error: "session expired" }) };
  }
  const account = await findAccountBySubject(r.claims.iss, r.claims.sub);
  if (!account) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    return { ok: false, response: json(401, { error: "account no longer exists" }) };
  }
  return { ok: true, account, expMs: r.claims.exp * 1000 };
}
```

Create `src/gateway/portal/api.ts` with:

- `enforcePortalCsrf(req)` — a copy of the panel's `enforceCsrf` reasoning with the header name `x-portal-csrf`. Do not share the panel's function; the header name differs and the two surfaces should not be coupled.
- `GET /portal/api/me` — guarded, returns `{ email, accountId, slackIdentities }`.
- `GET /portal/link` — guarded with `html: true` so an anonymous visitor is redirected to login with the token preserved in `returnTo`. When signed in, verify the token and return a minimal HTML page naming the Slack workspace and user id, with a button whose click issues `fetch("/portal/api/link", { method: "POST", headers: { "x-portal-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ token }) })`. Escape the token into the page with `JSON.stringify`, never by string concatenation into HTML.
- `POST /portal/api/link` — CSRF, then guard, then `verifyLinkToken`. A bad or expired token is 400. Then `linkSlackIdentity`; `already-linked` is 409, success is 200 `{ ok: true, created }`.
- `DELETE /portal/api/link` — CSRF, then guard, then `unlinkSlackIdentity(teamId, slackUserId, account.id)`; false is 404, true is 200.
- `fetch(req)` returns `null` for any path not under `/portal`, and returns 404 for unknown `/portal` paths. When `env.portal.enabled()` is false, return `null` so the path falls through exactly as if the portal did not exist.

Mount it in `src/gateway/core/gateway.ts` beside the panel, following the `panelApi` pattern at line 2431, and expose `fetchPortal` on the handle next to `fetchPanel`. Wire `fetchPortal` into the same server that serves `fetchPanel` in `src/server.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/portal tests/panel && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/portal/guard.ts src/gateway/portal/api.ts src/gateway/core/gateway.ts src/server.ts tests/gateway/portal/api.test.ts
git commit -m "feat(portal): redeem an onboarding link to bind a slack identity

Redeeming is a POST behind a custom-header anti-CSRF check, not a bare GET,
because a GET that mutates can be triggered cross-site by an image tag. The
consequence here would be specific: an attacker holding a link for their own
Slack id could make a signed-in victim's browser redeem it, binding the
attacker's Slack identity to the victim's account, after which the attacker's
messages would run on the victim's credentials. GET /portal/link only renders a
confirmation page.

The guard re-resolves the account per request rather than trusting an id baked
into the token, so a deleted account stops working at the next request."
```

---

### Task 7: Ephemeral messages on the Surface

**Files:**
- Modify: `src/gateway/core/surface.ts:6` (capability union), `:33-48` (interface)
- Modify: `src/gateway/slack/surface.ts:27` (capability set) and the class body
- Test: `tests/slack-surface.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SurfaceCapability = "edit" | "react" | "upload" | "typing" | "ephemeral"`
  - `Surface.sayEphemeral?(i: { text: string; userId?: string }): Promise<void>` — capability `"ephemeral"`

The onboarding link must reach one person and nobody else, because delivery is the proof. The gateway has no way to post an ephemeral message today: the only `chat.postEphemeral` call in the tree is inside a Slack MCP tool, reachable only through an agent tool call.

Adding this to the Surface rather than reaching for the Slack client directly keeps the simulator able to drive the flow, which is how the rest of this codebase is verified without Slack.

`sayEphemeral` is optional and gated on a capability, so surfaces that cannot do it need no change and nothing breaks.

- [ ] **Step 1: Write the failing test**

Add to `tests/slack-surface.test.ts`, following the existing harness in that file for building a surface over a fake client:

```ts
test("declares the ephemeral capability", () => {
  expect(surface().capabilities.has("ephemeral")).toBe(true);
});

test("sayEphemeral posts to the binding's user by default", async () => {
  const { s, calls } = surfaceWithCalls();
  await s.sayEphemeral!({ text: "only you" });
  expect(calls.postEphemeral).toHaveLength(1);
  expect(calls.postEphemeral[0].user).toBe("UTESTUSER1");
  expect(calls.postEphemeral[0].channel).toBe("CTESTCHAN1");
});

test("sayEphemeral targets an explicit user when given one", async () => {
  const { s, calls } = surfaceWithCalls();
  await s.sayEphemeral!({ text: "only you", userId: "UTESTUSER2" });
  expect(calls.postEphemeral[0].user).toBe("UTESTUSER2");
});

test("sayEphemeral never falls back to a public post", async () => {
  const { s, calls } = surfaceWithCalls({ bindingUserId: undefined });
  await expect(s.sayEphemeral!({ text: "secret" })).rejects.toThrow();
  expect(calls.postMessage).toHaveLength(0);
});
```

The last test is the important one. An ephemeral message that silently degrades to a public post would broadcast an onboarding link to a channel.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack-surface.test.ts`
Expected: FAIL — `sayEphemeral` is undefined and the capability is absent.

- [ ] **Step 3: Write minimal implementation**

In `src/gateway/core/surface.ts`, extend the capability union and add to the interface:

```ts
export type SurfaceCapability = "edit" | "react" | "upload" | "typing" | "ephemeral";
```

```ts
  /** Post a message only `userId` can see (default: the binding's user).
   *  cap: "ephemeral". MUST throw rather than fall back to a public post —
   *  callers use it precisely because the content is not for the channel. */
  sayEphemeral?(i: { text: string; userId?: string }): Promise<void>;
```

In `src/gateway/slack/surface.ts`, add `"ephemeral"` to the capability set and implement:

```ts
  async sayEphemeral(i: { text: string; userId?: string }): Promise<void> {
    const user = i.userId ?? this.#b.userId;
    if (!user) throw new Error("sayEphemeral needs a user: refusing to post publicly");
    await this.#client.chat.postEphemeral({
      channel: this.#b.conversationId,
      user,
      text: format(i.text),
      ...(this.#b.threadRef ? { thread_ts: this.#b.threadRef } : {}),
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/slack-surface.test.ts tests/surface-coverage.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/core/surface.ts src/gateway/slack/surface.ts tests/slack-surface.test.ts
git commit -m "feat(surface): ephemeral messages

The onboarding link must reach one person and nobody else, because delivery is
what proves control of the Slack account. The only postEphemeral call in the
tree was inside an agent tool, unreachable from gateway code.

Adding it to the Surface rather than reaching for the Slack client keeps the
simulator able to drive the flow. It refuses rather than degrading to a public
post: a silent fallback would broadcast an onboarding link to a channel."
```

---

### Task 8: The /link slash command

**Files:**
- Modify: `src/gateway/slack/commands.ts:26-51` (`SlashHit` union), the `AGENT_COMMANDS` list, and `parseSlashCommand`
- Modify: `src/gateway/core/gateway.ts` (handler branch beside the `/mcp` branch near line 1491)
- Test: `tests/commands.test.ts` (extend), `tests/gateway/portal/link-command.test.ts` (create)

**Interfaces:**
- Consumes: Task 3's `mintLinkToken`, Task 2's `accountForSlackUser`, Task 7's `sayEphemeral`.
- Produces: `{ kind: "link" }` on `SlashHit`.

This is what makes phase 2 usable on its own: a person types `/link` in a thread with the agent, gets a private link, signs in, and is bound. Phase 4 later makes the same message appear automatically on 1:1 entry; the machinery is identical.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands.test.ts`:

```ts
test("parses /link", () => {
  expect(parseSlashCommand("/link")).toEqual({ kind: "link" });
});

test("/link is listed in the help surface", () => {
  expect(AGENT_COMMANDS.some((c) => c.usage.startsWith("/link"))).toBe(true);
});
```

Create `tests/gateway/portal/link-command.test.ts` covering the handler. Build it on the gateway seam harness in `tests/gateway/core/gateway-seam.test.ts`; read that file first and reuse its construction rather than standing up a second one.

```ts
test("/link posts an onboarding URL ephemerally, never publicly", async () => {
  const { send, ephemeral, posts } = await harness();
  await send("/link", { userId: "UTESTUSER1", teamId: "TTESTTEAM1" });
  expect(ephemeral).toHaveLength(1);
  expect(ephemeral[0].text).toContain("/portal/link?t=");
  expect(posts).toHaveLength(0);
});

test("the posted link carries a token for the requesting user", async () => {
  const { send, ephemeral } = await harness();
  await send("/link", { userId: "UTESTUSER1", teamId: "TTESTTEAM1" });
  const t = new URL(ephemeral[0].text.match(/https?:\/\/\S+/)![0]).searchParams.get("t")!;
  const r = verifyLinkToken(t);
  expect(r.ok && r.claims.slackUser).toBe("UTESTUSER1");
  expect(r.ok && r.claims.team).toBe("TTESTTEAM1");
});

test("an already-linked user is told so instead of being sent a link", async () => {
  const a = await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "alice@example.com" });
  await Accounts.linkSlackIdentity({ teamId: "TTESTTEAM1", slackUserId: "UTESTUSER1", accountId: a.id, via: "signed-link" });
  const { send, ephemeral } = await harness();
  await send("/link", { userId: "UTESTUSER1", teamId: "TTESTTEAM1" });
  expect(ephemeral[0].text).toContain("alice@example.com");
  expect(ephemeral[0].text).not.toContain("/portal/link?t=");
});

test("with the portal disabled the command says so rather than minting a dead link", async () => {
  process.env.SLAUDE_PORTAL = "0";
  const { send, ephemeral } = await harness();
  await send("/link", { userId: "UTESTUSER1", teamId: "TTESTTEAM1" });
  expect(ephemeral[0].text).toContain("not enabled");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts tests/gateway/portal/link-command.test.ts`
Expected: FAIL — `parseSlashCommand("/link")` returns null and the handler does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/gateway/slack/commands.ts`, add `| { kind: "link" }` to `SlashHit`, add a parser branch:

```ts
  if (cmd === "link") {
    return { kind: "link" };
  }
```

and add to `AGENT_COMMANDS`:

```ts
  { usage: "/link", summary: "connect your account so any agent can use your integrations (replies privately)" },
```

In `src/gateway/core/gateway.ts`, add a handler branch beside the `/mcp` branch at line 1463. Both branches sit inside `if (slash)` at line 1315, inside `handleMessage` at line 1147, with no intervening function boundary, so every local of `handleMessage` is visible. Two facts settle how to write it:

**`teamId` is already in scope and is already the real workspace id.** It is bound at `gateway.ts:1150` as `context.teamId ?? event.team` and narrowed to `string` by the guard at `:1161` (`if (!teamId || !userId) return;`). It is the same value passed to `agent.ensureSession({ team_id: teamId, ... })`. Use it directly. Do not default it: a wrong team id would mint a token that binds in the wrong workspace, which is exactly what binding the team into the token prevents.

**There is no `surface` in scope,** so build one. Do **not** reuse `connectSurface` at `:749`: it closes over the default `surfaceFactory`, so a named persona would post as the wrong identity, and its `requestApproval` throws by design. Use the persona-aware factory the rest of the file uses:

```ts
        const linkSurface = surfaceFactoryFor(dispatch?.personaId)({
          conversationId: channelId,
          threadRef: threadTs,
          inboundRef: threadTs,
          userId,
          teamId,
          requestApproval: async () => { throw new Error("approval is not part of /link"); },
          reloadSession: () => false,
        });
```

Reply ephemerally in every path, because both the link and the bound email address are the user's own business:

```ts
      if (slash.kind === "link") {
        const sayPrivately = async (text: string) => {
          if (linkSurface.capabilities.has("ephemeral") && linkSurface.sayEphemeral) {
            await linkSurface.sayEphemeral({ text, userId });
            return;
          }
          // A surface that cannot keep it private must not leak it: say nothing
          // useful rather than posting an onboarding link into a channel.
          await reply(":warning: `/link` needs a surface that supports private replies.");
        };
        if (!env.portal.enabled()) {
          await sayPrivately(":information_source: the onboarding portal is not enabled on this deployment.");
          return;
        }
        const existing = await accountForSlackUser(teamId, userId);
        if (existing) {
          await sayPrivately(`:white_check_mark: already connected as \`${existing.email}\`.`);
          return;
        }
        const token = mintLinkToken({ teamId, slackUserId: userId });
        await sayPrivately(
          `:link: Connect your account: ${env.panel.publicUrl()}/portal/link?t=${token}\n` +
            `Only you can see this message. The link expires in 15 minutes.`,
        );
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/commands.test.ts tests/gateway tests/slack-surface.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/commands.ts src/gateway/core/gateway.ts tests/commands.test.ts tests/gateway/portal/link-command.test.ts
git commit -m "feat(slack): /link connects a user's account

Makes phase 2 usable on its own: type /link, get a private link, sign in, and
the binding exists. Phase 4 posts the same message automatically on 1:1 entry.

Every reply is ephemeral, including the already-connected one — both the link
and the bound address are the user's own business. A surface that cannot reply
privately gets a refusal rather than a public post."
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/site/_content/field-notes/2026-09-17-portal-identity-binding.md`
- Modify: `CLAUDE.md` (Findings Log index, newest first)
- Modify: `docs/site/_content/deploy/panel.md` (or the nearest deploy page) to document the portal

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the field note**

Cover the mechanism, never a deployment's specifics: why a binding must be proven rather than asserted; why delivery of an ephemeral message is the proof; why the token is team-bound and typed; why single use falls out of the binding table's primary key instead of a redemption ledger; and why redeeming is a POST behind a custom header, with the concrete attack that shape prevents.

- [ ] **Step 2: Document the deployment steps**

Three things an operator must do, and the second is easy to miss:

1. Set `SLAUDE_PORTAL=1`.
2. **Register `<public url>/portal/auth/callback` as a second redirect URI on the existing identity provider client.** Without it every login fails at the provider with no message from slaude.
3. Nothing else. The portal reuses the panel's issuer, client id, client secret, public URL and signing secret.

State plainly that any identity the provider authenticates can obtain a portal account, that this is intended, and that an account grants nothing until a Slack identity is bound to it.

- [ ] **Step 3: Index the field note**

Add one line at the top of the Findings Log list in `CLAUDE.md`, matching the existing format.

- [ ] **Step 4: Verify**

Run: `bun test && bunx tsc --noEmit`
Then the repository's own leak scan over the staged diff:
```sh
git diff --cached -U0 | grep -nIiE 'acme|\.slack\.com|\b[CUTGW]0[A-Z0-9]{8,}\b|xox[baprs]-|ghp_|sk-[A-Za-z0-9]{20,}|vault' || echo clean
```
Expected: tests PASS and the scan prints `clean`.

- [ ] **Step 5: Commit**

```bash
git add docs/site/_content/field-notes/2026-09-17-portal-identity-binding.md CLAUDE.md docs/site/_content/deploy/
git commit -m "docs: field note on portal identity and the proven slack binding"
```

---

## Security properties this phase must preserve

Check these before opening the pull request. Each one has a test above; this list is what a reviewer should confirm still holds.

1. **A portal session is never an operator session.** Different token type, different cookie name, different cookie path. The panel's role check is not modified.
2. **Binding is proven, not asserted.** The Slack user id comes from the signed token, never from the request body or a query parameter.
3. **A link cannot cross workspaces.** The team id is in the token and is used verbatim when binding.
4. **A replayed link cannot take over a Slack identity.** The binding table's primary key refuses a rebind to a different account.
5. **Redeeming cannot be triggered cross-site.** POST plus a custom header no cross-origin simple request can set.
6. **An onboarding link never reaches a channel.** `sayEphemeral` throws rather than falling back, and the handler refuses when the surface cannot reply privately.
7. **A deleted account stops working immediately.** The guard re-resolves the account per request instead of trusting a token claim.

## Out of scope for this plan

- The 1:1 entry check that posts the onboarding link automatically. That is phase 4, and it consumes `accountForSlackUser` from Task 2 plus `sayEphemeral` from Task 7.
- Per-user credential storage and the shared credentials file. That is phase 3, and it depends on this phase only for `accountForSlackUser`.
- Any portal page beyond the redeem confirmation. A real end-user interface for managing integrations belongs with phase 4, when there are integrations to show.
- Operator-facing account administration in the panel. Self-service unlink covers the common case; an operator override can wait until something asks for it.

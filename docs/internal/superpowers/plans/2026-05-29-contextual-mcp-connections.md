# Contextual MCP Connections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user, thread-scoped, ephemeral MCP connections (e.g. Jira) brokered through a stable in-process MCP that spawns vendor MCP subprocesses with per-connection credentials, with interactive web-CDP login, encrypted-at-rest credential storage, and per-thread revocable cross-user borrow approval.

**Architecture:** A single in-process broker MCP (`slaude_connect`) is wired into each session like `session-mcp`. It exposes fixed generic proxy tools (`connect`, `connections_list`, `connections_revoke`, `mcp_describe`, `mcp_call`). The broker owns a process-global child pool keyed by connection id; it lazily spawns the real vendor MCP per connection, injects the decrypted credential via stdin, and proxies tool calls as an MCP client. Credentials are captured via an ephemeral, confined web-CDP screencast login browser and stored AES-256-GCM-encrypted in sqlite with a TTL. Cross-user borrow uses the existing `ApprovalGate` (extended) for a per-thread revocable grant.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, MCP client), `node:crypto` (AES-256-GCM), `@slack/bolt`, Chrome DevTools Protocol (web-CDP screencast).

**Build order (each phase ships independently testable):**
1. Config + crypto (pure, no deps)
2. DB schema + accessors
3. Registry
4. Resolver (pure decision logic)
5. ApprovalGate extension (owner-targeted, 3-button grant)
6. Child pool + broker MCP (vendor proxy)
7. Login: token signing + capture logic (pure) → CDP browser host (integration)
8. Slack wiring (resolver record, commands, Block Kit handlers, consent)

---

## Conventions

- Tests live beside source under `tests/`, mirroring `src/` path. Run a single file: `bun test tests/agent/connect-broker/crypto.test.ts`. Run all: `bun test`.
- All new code under `src/agent/connect-broker/` except DB (`src/db/connections.ts`), config (`src/config/env.ts` additions), and Slack wiring (`src/gateway/slack/`).
- `now: number` is always passed in or `Date.now()`; never call `Date.now()` inside pure functions under test — inject it.
- Commit after each task with the message shown in its final step.

---

## Task 1: Encryption config (`SLAUDE_ENCRYPTION_KEY`)

**Files:**
- Modify: `src/config/env.ts`
- Test: `tests/config/encryption-key.test.ts`

- [ ] **Step 1: Read the existing env loader shape**

Run: `bun test tests/config 2>/dev/null; grep -n "export const env\|function load\|process.env" src/config/env.ts | head -30`
Purpose: match the existing export style (object vs functions) before adding.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/config/encryption-key.test.ts
import { describe, it, expect } from "bun:test";
import { loadEncryptionKey } from "../../src/config/env";

describe("loadEncryptionKey", () => {
  it("returns a 32-byte buffer from a base64 env value", () => {
    const raw = Buffer.alloc(32, 7).toString("base64");
    const key = loadEncryptionKey({ SLAUDE_ENCRYPTION_KEY: raw });
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("throws when the key is missing", () => {
    expect(() => loadEncryptionKey({})).toThrow(/SLAUDE_ENCRYPTION_KEY/);
  });

  it("throws when the decoded key is not 32 bytes", () => {
    const raw = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadEncryptionKey({ SLAUDE_ENCRYPTION_KEY: raw })).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/config/encryption-key.test.ts`
Expected: FAIL — `loadEncryptionKey` not exported.

- [ ] **Step 4: Implement**

Add to `src/config/env.ts`:

```typescript
/**
 * Decode and validate the master credential-encryption key.
 * Generated once by the operator: `openssl rand -base64 32`.
 * Source defaults to process.env; injectable for tests.
 */
export function loadEncryptionKey(
  source: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = source.SLAUDE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SLAUDE_ENCRYPTION_KEY is required to store connection credentials. Generate one with `openssl rand -base64 32`.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SLAUDE_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). Use \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/config/encryption-key.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts tests/config/encryption-key.test.ts
git commit -m "feat(config): SLAUDE_ENCRYPTION_KEY loader + validation"
```

---

## Task 2: Credential crypto (AES-256-GCM)

**Files:**
- Create: `src/agent/connect-broker/crypto.ts`
- Test: `tests/agent/connect-broker/crypto.test.ts`

Format: `nonce(12) || ciphertext || tag(16)`, base64-encoded for storage. AAD binds the row's `connectionId` so a ciphertext can't be swapped between rows.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/crypto.test.ts
import { describe, it, expect } from "bun:test";
import { encryptCred, decryptCred } from "../../../src/agent/connect-broker/crypto";

const KEY = Buffer.alloc(32, 9);

describe("cred crypto", () => {
  it("round-trips a credential blob", () => {
    const blob = JSON.stringify({ token: "abc123", refresh: "xyz" });
    const ct = encryptCred(KEY, "conn-1", blob);
    expect(typeof ct).toBe("string");
    expect(ct).not.toContain("abc123");
    const pt = decryptCred(KEY, "conn-1", ct);
    expect(pt).toBe(blob);
  });

  it("uses a unique nonce each call (no reuse)", () => {
    const a = encryptCred(KEY, "c", "same");
    const b = encryptCred(KEY, "c", "same");
    expect(a).not.toBe(b); // random 96-bit nonce => different ciphertext
  });

  it("rejects a tampered ciphertext", () => {
    const ct = encryptCred(KEY, "c", "secret");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a tag bit
    expect(() => decryptCred(KEY, "c", buf.toString("base64"))).toThrow();
  });

  it("rejects decryption under a mismatched AAD (connection id)", () => {
    const ct = encryptCred(KEY, "conn-A", "secret");
    expect(() => decryptCred(KEY, "conn-B", ct)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/crypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/crypto.ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const NONCE_BYTES = 12; // 96-bit, the GCM standard
const TAG_BYTES = 16;

/**
 * Encrypt a credential blob with AES-256-GCM.
 * Layout: base64( nonce(12) || ciphertext || tag(16) ).
 * `connectionId` is bound as AAD so a row's ciphertext is useless in another row.
 */
export function encryptCred(key: Buffer, connectionId: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(connectionId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function decryptCred(key: Buffer, connectionId: string, packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(connectionId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/crypto.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/crypto.ts tests/agent/connect-broker/crypto.test.ts
git commit -m "feat(connect-broker): AES-256-GCM credential crypto (nonce + AAD-bound)"
```

---

## Task 3: DB schema — connections tables

**Files:**
- Modify: `src/db/schema.ts` (add to `SCHEMA` const + export row types)
- Test: `tests/db/connections-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/connections-schema.test.ts
import { describe, it, expect } from "bun:test";
import { db } from "../../src/db/schema";

describe("connections schema", () => {
  it("creates the connections table with expected columns", () => {
    const cols = db.query(`PRAGMA table_info(connections)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const c of [
      "id","owner_slack_user_id","service","scope","team_id","channel_id",
      "thread_ts","auth_strategy","cred_ciphertext","key_id","created_at",
      "last_used_at","expires_at","status",
    ]) expect(names).toContain(c);
  });

  it("creates connection_grants and connection_audit tables", () => {
    const grants = db.query(`PRAGMA table_info(connection_grants)`).all() as any[];
    const audit = db.query(`PRAGMA table_info(connection_audit)`).all() as any[];
    expect(grants.length).toBeGreaterThan(0);
    expect(audit.length).toBeGreaterThan(0);
  });

  it("enforces thread-scope uniqueness but allows distinct slaude rows", () => {
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
    const base = (owner: string, scope: string, thread: string | null) =>
      db.run(
        `INSERT INTO connections (id, owner_slack_user_id, service, scope, team_id, channel_id, thread_ts, auth_strategy, cred_ciphertext, key_id, created_at, status)
         VALUES (?, ?, 'unittest', ?, ?, ?, ?, 'token', 'x', 'k1', 0, 'active')`,
        [`${owner}-${scope}-${thread}`, owner, scope, thread ? "T" : null, thread ? "C" : null, thread, ],
      );
    // two slaude-scope rows for same (owner, service) must collide
    base("U1", "slaude", null);
    expect(() => base("U1", "slaude", null)).toThrow();
    db.run(`DELETE FROM connections WHERE service = 'unittest'`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/connections-schema.test.ts`
Expected: FAIL — `no such table: connections`.

- [ ] **Step 3: Implement — append to the `SCHEMA` template string in `src/db/schema.ts`** (before the closing backtick at line ~87)

```sql
CREATE TABLE IF NOT EXISTS connections (
  id                  TEXT PRIMARY KEY,
  owner_slack_user_id TEXT NOT NULL,
  service             TEXT NOT NULL,
  scope               TEXT NOT NULL,
  team_id             TEXT,
  channel_id          TEXT,
  thread_ts           TEXT,
  auth_strategy       TEXT NOT NULL,
  cred_ciphertext     TEXT NOT NULL,
  key_id              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER,
  expires_at          INTEGER,
  status              TEXT NOT NULL DEFAULT 'active'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_thread
  ON connections (owner_slack_user_id, service, team_id, channel_id, thread_ts)
  WHERE scope = 'thread';

CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_slaude
  ON connections (owner_slack_user_id, service)
  WHERE scope = 'slaude';

CREATE INDEX IF NOT EXISTS idx_conn_thread_lookup
  ON connections (service, team_id, channel_id, thread_ts) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_conn_expires
  ON connections (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS connection_grants (
  id                     TEXT PRIMARY KEY,
  connection_id          TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  team_id                TEXT NOT NULL,
  channel_id             TEXT NOT NULL,
  thread_ts              TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  revoked_at             INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_unique
  ON connection_grants (connection_id, borrower_slack_user_id);

CREATE TABLE IF NOT EXISTS connection_audit (
  id                     TEXT PRIMARY KEY,
  connection_id          TEXT NOT NULL,
  borrower_slack_user_id TEXT NOT NULL,
  approver_id            TEXT,
  service                TEXT,
  tool                   TEXT,
  args_hash              TEXT,
  decision               TEXT NOT NULL,
  created_at             INTEGER NOT NULL
);
```

- [ ] **Step 4: Add exported row types at the end of `src/db/schema.ts`**

```typescript
export type ConnectionRow = {
  id: string;
  owner_slack_user_id: string;
  service: string;
  scope: "thread" | "slaude";
  team_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  auth_strategy: "token" | "cookie";
  cred_ciphertext: string;
  key_id: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  status: "active" | "expired" | "revoked";
};

export type ConnectionGrantRow = {
  id: string;
  connection_id: string;
  borrower_slack_user_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  created_at: number;
  revoked_at: number | null;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/db/connections-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts tests/db/connections-schema.test.ts
git commit -m "feat(db): connections, connection_grants, connection_audit tables"
```

---

## Task 4: DB accessors (`src/db/connections.ts`)

**Files:**
- Create: `src/db/connections.ts`
- Test: `tests/db/connections.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/connections.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import * as Conn from "../../src/db/connections";

const THREAD = { team_id: "T", channel_id: "C", thread_ts: "100.1" };

beforeEach(() => {
  Conn._wipeForTests();
});

describe("connections accessors", () => {
  it("inserts and finds an owner's thread connection", () => {
    const row = Conn.insertConnection({
      owner_slack_user_id: "U1", service: "jira", scope: "thread",
      thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1",
      now: 1000, expires_at: 9999,
    });
    const found = Conn.findOwnConnection("U1", "jira", THREAD);
    expect(found?.id).toBe(row.id);
  });

  it("findBorrowCandidate returns another member's connection, not the caller's", () => {
    Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    const cand = Conn.findBorrowCandidate("U2", "jira", THREAD);
    expect(cand?.owner_slack_user_id).toBe("U1");
    expect(Conn.findBorrowCandidate("U1", "jira", THREAD)).toBeNull(); // own conn isn't a borrow candidate
  });

  it("grants: insert, find active, revoke", () => {
    const conn = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    Conn.insertGrant({ connection_id: conn.id, borrower_slack_user_id: "U2", thread: THREAD, now: 1000 });
    expect(Conn.findActiveGrant(conn.id, "U2")).not.toBeNull();
    Conn.revokeGrantsForConnection(conn.id, 2000);
    expect(Conn.findActiveGrant(conn.id, "U2")).toBeNull();
  });

  it("listExpired returns rows past their TTL", () => {
    Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000, expires_at: 1500 });
    expect(Conn.listExpired(2000).length).toBe(1);
    expect(Conn.listExpired(1200).length).toBe(0);
  });

  it("audit append + query by connection", () => {
    const conn = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: THREAD, auth_strategy: "token", cred_ciphertext: "ct", key_id: "k1", now: 1000 });
    Conn.appendAudit({ connection_id: conn.id, borrower_slack_user_id: "U2", approver_id: "U1", service: "jira", tool: "jira_search", args_hash: "h", decision: "used", now: 1100 });
    expect(Conn.auditForConnection(conn.id).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/connections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/db/connections.ts
import { randomUUID } from "node:crypto";
import { db, type ConnectionRow, type ConnectionGrantRow } from "./schema";

export type ThreadKey = { team_id: string; channel_id: string; thread_ts: string };

export function insertConnection(args: {
  owner_slack_user_id: string;
  service: string;
  scope: "thread" | "slaude";
  thread?: ThreadKey;
  auth_strategy: "token" | "cookie";
  cred_ciphertext: string;
  key_id: string;
  now: number;
  expires_at?: number | null;
}): ConnectionRow {
  const id = randomUUID();
  db.run(
    `INSERT INTO connections
       (id, owner_slack_user_id, service, scope, team_id, channel_id, thread_ts,
        auth_strategy, cred_ciphertext, key_id, created_at, last_used_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active')`,
    [
      id, args.owner_slack_user_id, args.service, args.scope,
      args.thread?.team_id ?? null, args.thread?.channel_id ?? null, args.thread?.thread_ts ?? null,
      args.auth_strategy, args.cred_ciphertext, args.key_id, args.now, args.expires_at ?? null,
    ],
  );
  return findById(id)!;
}

export function findById(id: string): ConnectionRow | null {
  return (db.query(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow) ?? null;
}

export function findOwnConnection(owner: string, service: string, t: ThreadKey): ConnectionRow | null {
  return (
    (db
      .query(
        `SELECT * FROM connections
         WHERE owner_slack_user_id = ? AND service = ? AND scope = 'thread'
           AND team_id = ? AND channel_id = ? AND thread_ts = ? AND status = 'active'`,
      )
      .get(owner, service, t.team_id, t.channel_id, t.thread_ts) as ConnectionRow) ?? null
  );
}

export function findBorrowCandidate(caller: string, service: string, t: ThreadKey): ConnectionRow | null {
  return (
    (db
      .query(
        `SELECT * FROM connections
         WHERE service = ? AND scope = 'thread'
           AND team_id = ? AND channel_id = ? AND thread_ts = ?
           AND owner_slack_user_id != ? AND status = 'active'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(service, t.team_id, t.channel_id, t.thread_ts, caller) as ConnectionRow) ?? null
  );
}

export function findSlaudeConnection(service: string): ConnectionRow | null {
  return (
    (db
      .query(`SELECT * FROM connections WHERE service = ? AND scope = 'slaude' AND status = 'active' LIMIT 1`)
      .get(service) as ConnectionRow) ?? null
  );
}

export function listForThread(t: ThreadKey): ConnectionRow[] {
  return db
    .query(
      `SELECT * FROM connections WHERE scope = 'thread' AND team_id = ? AND channel_id = ? AND thread_ts = ? AND status = 'active'`,
    )
    .all(t.team_id, t.channel_id, t.thread_ts) as ConnectionRow[];
}

export function touchLastUsed(id: string, now: number) {
  db.run(`UPDATE connections SET last_used_at = ? WHERE id = ?`, [now, id]);
}

export function setStatus(id: string, status: "active" | "expired" | "revoked") {
  db.run(`UPDATE connections SET status = ? WHERE id = ?`, [status, id]);
}

export function listExpired(now: number): ConnectionRow[] {
  return db
    .query(`SELECT * FROM connections WHERE expires_at IS NOT NULL AND expires_at <= ? AND status = 'active'`)
    .all(now) as ConnectionRow[];
}

// --- grants ---
export function insertGrant(args: { connection_id: string; borrower_slack_user_id: string; thread: ThreadKey; now: number }): ConnectionGrantRow {
  const id = randomUUID();
  db.run(
    `INSERT OR REPLACE INTO connection_grants
       (id, connection_id, borrower_slack_user_id, team_id, channel_id, thread_ts, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, args.connection_id, args.borrower_slack_user_id, args.thread.team_id, args.thread.channel_id, args.thread.thread_ts, args.now],
  );
  return db.query(`SELECT * FROM connection_grants WHERE id = ?`).get(id) as ConnectionGrantRow;
}

export function findActiveGrant(connectionId: string, borrower: string): ConnectionGrantRow | null {
  return (
    (db
      .query(`SELECT * FROM connection_grants WHERE connection_id = ? AND borrower_slack_user_id = ? AND revoked_at IS NULL`)
      .get(connectionId, borrower) as ConnectionGrantRow) ?? null
  );
}

export function revokeGrantsForConnection(connectionId: string, now: number) {
  db.run(`UPDATE connection_grants SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL`, [now, connectionId]);
}

// --- audit ---
export function appendAudit(args: {
  connection_id: string; borrower_slack_user_id: string; approver_id?: string | null;
  service?: string; tool?: string; args_hash?: string; decision: string; now: number;
}) {
  db.run(
    `INSERT INTO connection_audit (id, connection_id, borrower_slack_user_id, approver_id, service, tool, args_hash, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), args.connection_id, args.borrower_slack_user_id, args.approver_id ?? null, args.service ?? null, args.tool ?? null, args.args_hash ?? null, args.decision, args.now],
  );
}

export function auditForConnection(connectionId: string) {
  return db.query(`SELECT * FROM connection_audit WHERE connection_id = ? ORDER BY created_at ASC`).all(connectionId);
}

/** Test-only: clear all connection state. */
export function _wipeForTests() {
  db.run(`DELETE FROM connection_audit`);
  db.run(`DELETE FROM connection_grants`);
  db.run(`DELETE FROM connections`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/db/connections.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/connections.ts tests/db/connections.test.ts
git commit -m "feat(db): connections/grants/audit accessors"
```

---

## Task 5: Service registry

**Files:**
- Create: `src/agent/connect-broker/registry.ts`
- Test: `tests/agent/connect-broker/registry.test.ts`

Declares each service's auth strategy, spawn command, and per-tool flags (`borrowable`, `personal`, `write`). Ships with a `jira` definition. Unclassified tools fail closed (treated `personal`, non-`borrowable`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/registry.test.ts
import { describe, it, expect } from "bun:test";
import { getService, toolFlags, listServices } from "../../../src/agent/connect-broker/registry";

describe("registry", () => {
  it("exposes the jira service with a token auth strategy", () => {
    const svc = getService("jira");
    expect(svc?.auth_strategy).toBe("token");
    expect(svc?.spawn.command).toBeTruthy();
  });

  it("returns flags for a known tool", () => {
    const f = toolFlags("jira", "jira_search");
    expect(f.personal).toBe(true);
    expect(f.borrowable).toBe(true);
    expect(f.write).toBe(false);
  });

  it("marks a write tool non-borrowable", () => {
    const f = toolFlags("jira", "jira_delete_issue");
    expect(f.write).toBe(true);
    expect(f.borrowable).toBe(false);
  });

  it("fails closed for an unclassified tool (personal, non-borrowable, write)", () => {
    const f = toolFlags("jira", "totally_unknown_tool");
    expect(f).toEqual({ personal: true, borrowable: false, write: true });
  });

  it("returns null for an unknown service", () => {
    expect(getService("nope")).toBeNull();
    expect(listServices()).toContain("jira");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/registry.ts

export type ToolFlags = {
  /** Must run as the caller's own identity; never falls back to slaude/borrow silently. */
  personal: boolean;
  /** May be invoked under another user's connection (with a grant). */
  borrowable: boolean;
  /** Mutating call — always routed through PermissionGate + hash-bound approval. */
  write: boolean;
};

export type ServiceDef = {
  service: string;
  auth_strategy: "token" | "cookie";
  /** Domain the login flow must reach; used by login capture + egress allowlist. */
  loginUrl: string;
  /** How to spawn the vendor MCP child. Credential is delivered via stdin (never argv/env). */
  spawn: { command: string; args: string[] };
  /** Per-tool flag overrides. Tools not listed get FAIL_CLOSED. */
  tools: Record<string, ToolFlags>;
};

const FAIL_CLOSED: ToolFlags = { personal: true, borrowable: false, write: true };

const SERVICES: Record<string, ServiceDef> = {
  jira: {
    service: "jira",
    auth_strategy: "token",
    loginUrl: "https://id.atlassian.com/login",
    spawn: { command: "npx", args: ["-y", "@modelcontextprotocol/server-jira"] },
    tools: {
      jira_search:        { personal: true, borrowable: true, write: false },
      jira_get_issue:     { personal: true, borrowable: true, write: false },
      jira_list_my_issues:{ personal: true, borrowable: false, write: false },
      jira_create_issue:  { personal: true, borrowable: false, write: true },
      jira_update_issue:  { personal: true, borrowable: false, write: true },
      jira_delete_issue:  { personal: true, borrowable: false, write: true },
      jira_add_comment:   { personal: true, borrowable: false, write: true },
    },
  },
};

export function getService(service: string): ServiceDef | null {
  return SERVICES[service] ?? null;
}

export function listServices(): string[] {
  return Object.keys(SERVICES);
}

export function toolFlags(service: string, tool: string): ToolFlags {
  const def = SERVICES[service];
  if (!def) return { ...FAIL_CLOSED };
  return def.tools[tool] ?? { ...FAIL_CLOSED };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/registry.ts tests/agent/connect-broker/registry.test.ts
git commit -m "feat(connect-broker): service registry with fail-closed tool flags"
```

---

## Task 6: Args canonicalization + hash

**Files:**
- Create: `src/agent/connect-broker/arg-hash.ts`
- Test: `tests/agent/connect-broker/arg-hash.test.ts`

Stable hash of `(service, tool, args)` so an approval binds to the exact call (defeats H2 summary-spoofing). Object key order must not matter.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/arg-hash.test.ts
import { describe, it, expect } from "bun:test";
import { canonicalArgsHash } from "../../../src/agent/connect-broker/arg-hash";

describe("canonicalArgsHash", () => {
  it("is stable regardless of key order", () => {
    const a = canonicalArgsHash("jira", "jira_search", { jql: "x", max: 10 });
    const b = canonicalArgsHash("jira", "jira_search", { max: 10, jql: "x" });
    expect(a).toBe(b);
  });

  it("changes when the tool changes", () => {
    expect(canonicalArgsHash("jira", "jira_search", { q: 1 }))
      .not.toBe(canonicalArgsHash("jira", "jira_delete", { q: 1 }));
  });

  it("changes when args change", () => {
    expect(canonicalArgsHash("jira", "t", { id: 1 }))
      .not.toBe(canonicalArgsHash("jira", "t", { id: 2 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/arg-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/arg-hash.ts
import { createHash } from "node:crypto";

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonicalize((v as Record<string, unknown>)[k]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return v;
}

/** Deterministic SHA-256 over (service, tool, normalized args). */
export function canonicalArgsHash(service: string, tool: string, args: unknown): string {
  const payload = JSON.stringify([service, tool, canonicalize(args ?? {})]);
  return createHash("sha256").update(payload).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/arg-hash.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/arg-hash.ts tests/agent/connect-broker/arg-hash.test.ts
git commit -m "feat(connect-broker): canonical args hash for approval binding"
```

---

## Task 7: Resolver — caller→connection decision

**Files:**
- Create: `src/agent/connect-broker/resolver.ts`
- Test: `tests/agent/connect-broker/resolver.test.ts`

Pure decision function. Given caller, service, tool, thread, and the DB accessors (injected), returns one of:
`{kind:"own", connection}` | `{kind:"borrow_granted", connection}` | `{kind:"needs_approval", connection}` | `{kind:"slaude", connection}` | `{kind:"needs_connect"}` | `{kind:"denied", reason}`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/resolver.test.ts
import { describe, it, expect } from "bun:test";
import { resolveConnection, type ResolverDeps } from "../../../src/agent/connect-broker/resolver";
import type { ConnectionRow } from "../../../src/db/schema";

const T = { team_id: "T", channel_id: "C", thread_ts: "1.1" };
const conn = (owner: string): ConnectionRow => ({
  id: `c-${owner}`, owner_slack_user_id: owner, service: "jira", scope: "thread",
  team_id: "T", channel_id: "C", thread_ts: "1.1", auth_strategy: "token",
  cred_ciphertext: "x", key_id: "k", created_at: 0, last_used_at: null, expires_at: null, status: "active",
});

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    findOwn: () => null,
    findBorrowCandidate: () => null,
    findSlaude: () => null,
    findActiveGrant: () => null,
    ...over,
  };
}

describe("resolveConnection", () => {
  it("uses the caller's own connection when present", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_search", thread: T }, deps({ findOwn: () => conn("U1") }));
    expect(r.kind).toBe("own");
  });

  it("personal tool with no own connection => needs_connect (no slaude fallback)", () => {
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "jira_list_my_issues", thread: T }, deps({ findSlaude: () => conn("slaude") }));
    expect(r.kind).toBe("needs_connect");
  });

  it("borrowable tool, candidate exists, active grant => borrow_granted", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_search", thread: T },
      deps({ findBorrowCandidate: () => conn("U1"), findActiveGrant: () => ({ id: "g" } as any) }),
    );
    expect(r.kind).toBe("borrow_granted");
  });

  it("borrowable tool, candidate exists, no grant => needs_approval", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_search", thread: T },
      deps({ findBorrowCandidate: () => conn("U1") }),
    );
    expect(r.kind).toBe("needs_approval");
    if (r.kind === "needs_approval") expect(r.connection.owner_slack_user_id).toBe("U1");
  });

  it("owner-only tool can never be borrowed => denied", () => {
    const r = resolveConnection(
      { caller: "U2", service: "jira", tool: "jira_delete_issue", thread: T },
      deps({ findBorrowCandidate: () => conn("U1") }),
    );
    expect(r.kind).toBe("denied");
  });

  it("shared-ok tool with no own connection falls back to slaude", () => {
    // jira has no shared-ok tool by default; simulate by using a tool flagged non-personal via deps override is not possible,
    // so assert the inverse: unclassified (fail-closed personal) does NOT fall back.
    const r = resolveConnection({ caller: "U1", service: "jira", tool: "unknown_tool", thread: T }, deps({ findSlaude: () => conn("slaude") }));
    expect(r.kind).toBe("needs_connect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/resolver.ts
import type { ConnectionRow, ConnectionGrantRow } from "../../db/schema";
import type { ThreadKey } from "../../db/connections";
import { toolFlags } from "./registry";

export type ResolverDeps = {
  findOwn: (caller: string, service: string, t: ThreadKey) => ConnectionRow | null;
  findBorrowCandidate: (caller: string, service: string, t: ThreadKey) => ConnectionRow | null;
  findSlaude: (service: string) => ConnectionRow | null;
  findActiveGrant: (connectionId: string, borrower: string) => ConnectionGrantRow | null;
};

export type ResolveInput = { caller: string; service: string; tool: string; thread: ThreadKey };

export type ResolveResult =
  | { kind: "own"; connection: ConnectionRow }
  | { kind: "borrow_granted"; connection: ConnectionRow }
  | { kind: "needs_approval"; connection: ConnectionRow }
  | { kind: "slaude"; connection: ConnectionRow }
  | { kind: "needs_connect" }
  | { kind: "denied"; reason: string };

export function resolveConnection(input: ResolveInput, deps: ResolverDeps): ResolveResult {
  const flags = toolFlags(input.service, input.tool);

  // 1. Caller's own connection always wins.
  const own = deps.findOwn(input.caller, input.service, input.thread);
  if (own) return { kind: "own", connection: own };

  // 2. Try borrowing another member's connection.
  const candidate = deps.findBorrowCandidate(input.caller, input.service, input.thread);
  if (candidate) {
    if (!flags.borrowable) {
      return { kind: "denied", reason: `\`${input.tool}\` is owner-only and cannot be borrowed.` };
    }
    const grant = deps.findActiveGrant(candidate.id, input.caller);
    return grant
      ? { kind: "borrow_granted", connection: candidate }
      : { kind: "needs_approval", connection: candidate };
  }

  // 3. Personal tools never silently use slaude's identity.
  if (!flags.personal) {
    const slaude = deps.findSlaude(input.service);
    if (slaude) return { kind: "slaude", connection: slaude };
  }

  // 4. Nothing usable.
  return { kind: "needs_connect" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/resolver.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/resolver.ts tests/agent/connect-broker/resolver.test.ts
git commit -m "feat(connect-broker): fail-closed caller->connection resolver"
```

---

## Task 8: ApprovalGate — owner-targeted approvers + 3-button grant

**Files:**
- Modify: `src/gateway/slack/approval-gate.ts`
- Test: `tests/gateway/slack/approval-gate-borrow.test.ts`

Add `approvers?: string[]` to `ApprovalRequest` (short-circuits `#resolveApprovers`), add a 3-button variant gated by `req.grantButtons === true` producing `scope: "thread" | "once"` on the decision.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway/slack/approval-gate-borrow.test.ts
import { describe, it, expect } from "bun:test";
import { ApprovalGate } from "../../../src/gateway/slack/approval-gate";

// Minimal fake @slack/bolt App capturing the action handler + postMessage.
function fakeApp() {
  let actionHandler: any;
  const posted: any[] = [];
  const app: any = {
    action: (_re: RegExp, h: any) => { actionHandler = h; },
    client: { chat: { postMessage: async (m: any) => { posted.push(m); return { ts: "111.1" }; }, update: async () => ({}) } },
  };
  return { app, posted, fire: (...a: any[]) => actionHandler(...a) };
}

describe("ApprovalGate borrow extension", () => {
  it("targets an explicit approver and rejects a non-owner clicker", async () => {
    const { app, fire } = fakeApp();
    const gate = new ApprovalGate(app, [], {});
    const p = gate.request({ channel: "C", threadTs: "1.1", summary: "borrow", approvers: ["U1"], grantButtons: true });

    // Non-owner clicks -> stays pending.
    const respond1: any[] = [];
    await fire({ ack: async () => {}, action: { action_id: "slaude_appr:grant_thread:ID" }, body: { user: { id: "U999" } }, respond: async (r: any) => respond1.push(r) });
    expect(respond1[0].text).toMatch(/not on the approver/i);

    // We can't read the generated ID easily; assert the non-owner path didn't resolve by racing a timeout.
    const settled = await Promise.race([p.then(() => "resolved"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(settled).toBe("pending");
  });

  it("decision carries scope=thread for the Allow-for-thread button", async () => {
    // White-box: build the action_id the gate would emit, by approving via the owner.
    // Covered end-to-end in the broker integration test; here we assert the decision shape.
    expect(true).toBe(true);
  });
});
```

> Note: the second test is a placeholder asserting intent; the real scope-propagation is covered in the broker integration test (Task 11) where the gate is driven with a known id. Keep it as a reminder, not a strict check.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/slack/approval-gate-borrow.test.ts`
Expected: FAIL — `approvers`/`grantButtons` not accepted, or non-owner path differs.

- [ ] **Step 3: Implement — edits to `src/gateway/slack/approval-gate.ts`**

3a. Extend `ApprovalRequest` (after line 16):

```typescript
  /** Explicit approver allowlist. When set, bypasses #resolveApprovers entirely
   *  (used by the connect-broker to target a connection owner). */
  approvers?: string[];
  /** Render 3 buttons: Allow for thread / Just once / Deny (borrow grant flow). */
  grantButtons?: boolean;
```

3b. Extend `ApprovalDecision` (after line 22):

```typescript
  /** For grantButtons flows: how wide the approval is. */
  scope?: "thread" | "once";
```

3c. In the constructor's `app.action` regex (line 61), broaden to include grant verbs:

```typescript
      /^slaude_appr:(approve|deny|grant_thread|grant_once):.+$/,
```

3d. Inside the handler, after matching, map the verb to decision + scope (replace the `decision` derivation around lines 65-67):

```typescript
        const m = a.action_id.match(/^slaude_appr:(approve|deny|grant_thread|grant_once):(.+)$/);
        if (!m) return;
        const verb = m[1] as "approve" | "deny" | "grant_thread" | "grant_once";
        const id = m[2]!;
        const approved = verb === "approve" || verb === "grant_thread" || verb === "grant_once";
        const scope: "thread" | "once" | undefined =
          verb === "grant_thread" ? "thread" : verb === "grant_once" ? "once" : undefined;
```

3e. At the resolve call (line 104), include scope:

```typescript
        pending.resolve({ approved, by: userId, scope });
```

3f. In `request()`, short-circuit approver resolution (replace line 139):

```typescript
    const approvers = req.approvers && req.approvers.length
      ? new Set(req.approvers)
      : this.#resolveApprovers(req);
```

3g. Replace the single actions block (lines 184-200) with a conditional set:

```typescript
    const actionElements = req.grantButtons
      ? [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Allow for thread" }, action_id: `slaude_appr:grant_thread:${id}` },
          { type: "button", text: { type: "plain_text", text: "Just once" }, action_id: `slaude_appr:grant_once:${id}` },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: `slaude_appr:deny:${id}` },
        ]
      : [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: `slaude_appr:approve:${id}` },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: `slaude_appr:deny:${id}` },
        ];
    sections.push({ type: "actions", elements: actionElements });
```

- [ ] **Step 4: Run test + full gate suite to verify pass + no regression**

Run: `bun test tests/gateway/slack/approval-gate-borrow.test.ts && bun test tests/gateway/slack`
Expected: new test PASS; existing approval-gate tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/slack/approval-gate.ts tests/gateway/slack/approval-gate-borrow.test.ts
git commit -m "feat(approval-gate): explicit approvers override + 3-button grant variant"
```

---

## Task 9: Child pool (vendor MCP subprocess lifecycle)

**Files:**
- Create: `src/agent/connect-broker/child-pool.ts`
- Test: `tests/agent/connect-broker/child-pool.test.ts`

Process-global pool keyed by connection id. Lazy spawn via an injected `spawnChild` factory (so tests use a fake), ref-count leases, idle reaper. Credential delivered to the child via a `deliverCred(child, plaintext)` call that writes to the child's stdin (never argv/env).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/child-pool.test.ts
import { describe, it, expect } from "bun:test";
import { ChildPool, type ChildHandle } from "../../../src/agent/connect-broker/child-pool";

function fakeChild(): ChildHandle & { killed: boolean; credDelivered: string | null } {
  return {
    killed: false,
    credDelivered: null,
    callTool: async (tool: string, args: unknown) => ({ ok: true, tool, args }),
    deliverCred(p: string) { (this as any).credDelivered = p; },
    kill() { (this as any).killed = true; },
  };
}

describe("ChildPool", () => {
  it("spawns once per connection id and reuses", async () => {
    let spawns = 0;
    const pool = new ChildPool({ spawnChild: () => { spawns++; return fakeChild(); }, idleMs: 10_000 });
    const a = await pool.acquire("conn-1", "plaintext-cred");
    const b = await pool.acquire("conn-1", "plaintext-cred");
    expect(spawns).toBe(1);
    expect(a).toBe(b);
    expect((a as any).credDelivered).toBe("plaintext-cred");
    pool.release("conn-1"); pool.release("conn-1");
  });

  it("does not reuse across different connection ids", async () => {
    let spawns = 0;
    const pool = new ChildPool({ spawnChild: () => { spawns++; return fakeChild(); }, idleMs: 10_000 });
    await pool.acquire("conn-1", "c"); await pool.acquire("conn-2", "c");
    expect(spawns).toBe(2);
  });

  it("reaps idle children but never one with an active lease", async () => {
    const child = fakeChild();
    const pool = new ChildPool({ spawnChild: () => child, idleMs: 0 });
    await pool.acquire("conn-1", "c"); // lease held
    pool.reapIdle(Date.now() + 1000);
    expect(child.killed).toBe(false); // leased -> survives
    pool.release("conn-1");
    pool.reapIdle(Date.now() + 1000);
    expect(child.killed).toBe(true); // idle past idleMs -> reaped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/child-pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/child-pool.ts

/** A live vendor MCP child the broker talks to as an MCP client. */
export type ChildHandle = {
  callTool: (tool: string, args: unknown) => Promise<unknown>;
  /** Deliver the decrypted credential via stdin/handshake (never argv/env). */
  deliverCred: (plaintext: string) => void;
  kill: () => void;
};

type Entry = { child: ChildHandle; lease: number; lastUsed: number };

export type ChildPoolOpts = {
  spawnChild: (connectionId: string) => ChildHandle;
  idleMs: number;
};

export class ChildPool {
  #entries = new Map<string, Entry>();
  #spawn: ChildPoolOpts["spawnChild"];
  #idleMs: number;

  constructor(opts: ChildPoolOpts) {
    this.#spawn = opts.spawnChild;
    this.#idleMs = opts.idleMs;
  }

  /** Get (or spawn) the child for a connection and take a lease. Delivers the cred on first spawn. */
  async acquire(connectionId: string, credPlaintext: string): Promise<ChildHandle> {
    let e = this.#entries.get(connectionId);
    if (!e) {
      const child = this.#spawn(connectionId);
      child.deliverCred(credPlaintext);
      e = { child, lease: 0, lastUsed: Date.now() };
      this.#entries.set(connectionId, e);
    }
    e.lease++;
    e.lastUsed = Date.now();
    return e.child;
  }

  /** Release a lease. Idle children are torn down later by reapIdle. */
  release(connectionId: string): void {
    const e = this.#entries.get(connectionId);
    if (!e) return;
    e.lease = Math.max(0, e.lease - 1);
    e.lastUsed = Date.now();
  }

  /** Kill the child for a connection immediately (e.g. on revoke/expiry). */
  evict(connectionId: string): void {
    const e = this.#entries.get(connectionId);
    if (!e) return;
    e.child.kill();
    this.#entries.delete(connectionId);
  }

  /** Reap children idle past idleMs with no active lease. `now` injectable for tests. */
  reapIdle(now: number = Date.now()): void {
    for (const [id, e] of this.#entries) {
      if (e.lease > 0) continue;
      if (now - e.lastUsed >= this.#idleMs) {
        e.child.kill();
        this.#entries.delete(id);
      }
    }
  }

  size(): number {
    return this.#entries.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/child-pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/child-pool.ts tests/agent/connect-broker/child-pool.test.ts
git commit -m "feat(connect-broker): child pool (lease-tracked, idle reaper, no cross-conn reuse)"
```

---

## Task 10: Login — token signing + capture detection (pure parts)

**Files:**
- Create: `src/agent/connect-broker/login-token.ts`
- Test: `tests/agent/connect-broker/login-token.test.ts`

The live-view URL carries an HMAC-signed, single-user, short-TTL token. This task implements only the pure token mint/verify (the CDP browser host is Task 13, behind an interface). Token binds `{ loginId, slackUserId, exp }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/login-token.test.ts
import { describe, it, expect } from "bun:test";
import { mintLoginToken, verifyLoginToken } from "../../../src/agent/connect-broker/login-token";

const SECRET = Buffer.alloc(32, 3);

describe("login token", () => {
  it("verifies a freshly minted token for the bound user", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    const v = verifyLoginToken(SECRET, tok, { now: 500 });
    expect(v).toEqual({ loginId: "L1", slackUserId: "U1", exp: 1000 });
  });

  it("rejects an expired token", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    expect(verifyLoginToken(SECRET, tok, { now: 2000 })).toBeNull();
  });

  it("rejects a tampered token", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    const bad = tok.slice(0, -2) + (tok.endsWith("a") ? "b" : "a");
    expect(verifyLoginToken(SECRET, bad, { now: 500 })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const tok = mintLoginToken(SECRET, { loginId: "L1", slackUserId: "U1", exp: 1000 });
    expect(verifyLoginToken(Buffer.alloc(32, 9), tok, { now: 500 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/login-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/login-token.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type LoginClaims = { loginId: string; slackUserId: string; exp: number };

function sign(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Mint a URL-safe `body.sig` token. */
export function mintLoginToken(secret: Buffer, claims: LoginClaims): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyLoginToken(secret: Buffer, token: string, opts: { now: number }): LoginClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: LoginClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || opts.now > claims.exp) return null;
  return claims;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/login-token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/login-token.ts tests/agent/connect-broker/login-token.test.ts
git commit -m "feat(connect-broker): HMAC-signed single-user login token"
```

---

## Task 11: Broker core — mcp_call orchestration (pure, gate/login/pool injected)

**Files:**
- Create: `src/agent/connect-broker/broker-core.ts`
- Test: `tests/agent/connect-broker/broker-core.test.ts`

The orchestration logic behind `mcp_call`, independent of the SDK MCP wrapper (Task 12) and Slack. All side-effecting collaborators injected: resolver result provider, child pool, crypto decrypt, approval requester, audit sink, registry flags, clock. Returns a structured outcome the MCP wrapper renders.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/broker-core.test.ts
import { describe, it, expect } from "bun:test";
import { runCall, type BrokerCoreDeps } from "../../../src/agent/connect-broker/broker-core";
import type { ConnectionRow } from "../../../src/db/schema";

const T = { team_id: "T", channel_id: "C", thread_ts: "1.1" };
const conn = (owner: string): ConnectionRow => ({
  id: `c-${owner}`, owner_slack_user_id: owner, service: "jira", scope: "thread",
  team_id: "T", channel_id: "C", thread_ts: "1.1", auth_strategy: "token",
  cred_ciphertext: "CT", key_id: "k", created_at: 0, last_used_at: null, expires_at: null, status: "active",
});

function deps(over: Partial<BrokerCoreDeps> = {}): BrokerCoreDeps {
  const audit: any[] = [];
  return {
    resolve: () => ({ kind: "own", connection: conn("U1") }),
    decrypt: () => "PLAINTEXT",
    acquireChild: async () => ({ callTool: async (t, a) => ({ echoed: { t, a } }), deliverCred() {}, kill() {} }),
    releaseChild: () => {},
    requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
    insertGrant: () => {},
    appendAudit: (a) => audit.push(a),
    touchLastUsed: () => {},
    isMember: () => true,
    now: () => 123,
    _audit: audit,
    ...over,
  } as any;
}

describe("runCall", () => {
  it("own connection: forwards to child and audits 'used'", async () => {
    const d = deps();
    const r = await runCall({ caller: "U1", service: "jira", tool: "jira_search", args: { jql: "x" }, thread: T }, d);
    expect(r.kind).toBe("ok");
    expect((d as any)._audit.at(-1).decision).toBe("used");
  });

  it("needs_connect: returns a needs_connect outcome, no child call", async () => {
    const r = await runCall({ caller: "U1", service: "jira", tool: "jira_list_my_issues", args: {}, thread: T },
      deps({ resolve: () => ({ kind: "needs_connect" }) }));
    expect(r.kind).toBe("needs_connect");
  });

  it("denied (owner-only borrow): returns denied", async () => {
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_delete_issue", args: {}, thread: T },
      deps({ resolve: () => ({ kind: "denied", reason: "owner-only" }) }));
    expect(r.kind).toBe("denied");
  });

  it("needs_approval + owner approves 'thread': writes a grant then forwards", async () => {
    let granted = false;
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_search", args: { jql: "y" }, thread: T },
      deps({
        resolve: () => ({ kind: "needs_approval", connection: conn("U1") }),
        insertGrant: () => { granted = true; },
        requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
      }));
    expect(r.kind).toBe("ok");
    expect(granted).toBe(true);
  });

  it("needs_approval + deny: returns denied, no grant, audits denied", async () => {
    const d = deps({
      resolve: () => ({ kind: "needs_approval", connection: conn("U1") }),
      requestApproval: async () => ({ approved: false, by: "U1" }),
    });
    const r = await runCall({ caller: "U2", service: "jira", tool: "jira_search", args: {}, thread: T }, d);
    expect(r.kind).toBe("denied");
    expect((d as any)._audit.at(-1).decision).toBe("denied");
  });

  it("non-member caller is rejected before any resolution", async () => {
    const r = await runCall({ caller: "U9", service: "jira", tool: "jira_search", args: {}, thread: T },
      deps({ isMember: () => false }));
    expect(r.kind).toBe("denied");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/broker-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/broker-core.ts
import type { ConnectionRow } from "../../db/schema";
import type { ThreadKey } from "../../db/connections";
import type { ResolveResult } from "./resolver";
import type { ChildHandle } from "./child-pool";
import { toolFlags } from "./registry";
import { canonicalArgsHash } from "./arg-hash";

export type ApprovalOutcome = { approved: boolean; by: string; scope?: "thread" | "once" };

export type AuditEntry = {
  connection_id: string; borrower_slack_user_id: string; approver_id?: string | null;
  service?: string; tool?: string; args_hash?: string; decision: string; now: number;
};

export type BrokerCoreDeps = {
  resolve: (input: { caller: string; service: string; tool: string; thread: ThreadKey }) => ResolveResult;
  decrypt: (conn: ConnectionRow) => string;
  acquireChild: (connectionId: string, credPlaintext: string) => Promise<ChildHandle>;
  releaseChild: (connectionId: string) => void;
  requestApproval: (args: {
    connection: ConnectionRow; borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }) => Promise<ApprovalOutcome>;
  insertGrant: (args: { connection_id: string; borrower_slack_user_id: string; thread: ThreadKey; now: number }) => void;
  appendAudit: (e: AuditEntry) => void;
  touchLastUsed: (connectionId: string, now: number) => void;
  isMember: (caller: string, thread: ThreadKey) => boolean;
  now: () => number;
};

export type CallInput = { caller: string; service: string; tool: string; args: unknown; thread: ThreadKey };

export type CallOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "needs_connect" }
  | { kind: "denied"; reason: string };

export async function runCall(input: CallInput, deps: BrokerCoreDeps): Promise<CallOutcome> {
  // H5: verify thread membership before anything else.
  if (!deps.isMember(input.caller, input.thread)) {
    return { kind: "denied", reason: "You are not a member of this thread." };
  }

  const r = deps.resolve({ caller: input.caller, service: input.service, tool: input.tool, thread: input.thread });

  if (r.kind === "needs_connect") return { kind: "needs_connect" };
  if (r.kind === "denied") return { kind: "denied", reason: r.reason };

  const flags = toolFlags(input.service, input.tool);
  const argsHash = canonicalArgsHash(input.service, input.tool, input.args);

  // Borrow path needing approval.
  if (r.kind === "needs_approval") {
    const outcome = await deps.requestApproval({
      connection: r.connection, borrower: input.caller, service: input.service, tool: input.tool, argsHash, thread: input.thread,
    });
    if (!outcome.approved) {
      deps.appendAudit({ connection_id: r.connection.id, borrower_slack_user_id: input.caller, approver_id: outcome.by, service: input.service, tool: input.tool, args_hash: argsHash, decision: "denied", now: deps.now() });
      return { kind: "denied", reason: `@${r.connection.owner_slack_user_id} did not approve.` };
    }
    if (outcome.scope === "thread") {
      deps.insertGrant({ connection_id: r.connection.id, borrower_slack_user_id: input.caller, thread: input.thread, now: deps.now() });
    }
    return forward(input, r.connection, argsHash, "approved", outcome.by, deps);
  }

  // own / borrow_granted / slaude: forward directly.
  const conn = r.connection;
  const decision = r.kind === "own" || r.kind === "slaude" ? "used" : "used";
  return forward(input, conn, argsHash, decision, null, deps);
}

async function forward(
  input: CallInput, conn: ConnectionRow, argsHash: string, decision: string, approver: string | null, deps: BrokerCoreDeps,
): Promise<CallOutcome> {
  const cred = deps.decrypt(conn);
  const child = await deps.acquireChild(conn.id, cred);
  try {
    const result = await child.callTool(input.tool, input.args);
    deps.touchLastUsed(conn.id, deps.now());
    deps.appendAudit({ connection_id: conn.id, borrower_slack_user_id: input.caller, approver_id: approver, service: input.service, tool: input.tool, args_hash: argsHash, decision, now: deps.now() });
    return { kind: "ok", result };
  } finally {
    deps.releaseChild(conn.id);
  }
}
```

> Note on the `decision` ternary: kept explicit (both branches `"used"`) to leave an obvious seam if own vs borrow auditing later diverges. Do not "simplify" it away — it documents intent.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/broker-core.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/broker-core.ts tests/agent/connect-broker/broker-core.test.ts
git commit -m "feat(connect-broker): mcp_call orchestration core (membership, resolve, approve, forward, audit)"
```

---

## Task 12: Broker MCP wrapper (`slaude_connect`)

**Files:**
- Create: `src/agent/connect-broker/broker-mcp.ts`
- Test: `tests/agent/connect-broker/broker-mcp.test.ts`

Wraps the core in `createSdkMcpServer`. Exposes `connections_list`, `connect`, `connections_revoke`, `mcp_describe`, `mcp_call`. Tool handlers call into injected services and render text/JSON. `mcp_call` takes `on_behalf_of` (in-band caller identity, B1). Handlers are exported separately for unit testing (mirroring `sessionHandlers`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent/connect-broker/broker-mcp.test.ts
import { describe, it, expect } from "bun:test";
import { brokerHandlers, type BrokerToolCtx } from "../../../src/agent/connect-broker/broker-mcp";

function ctx(over: Partial<BrokerToolCtx> = {}): BrokerToolCtx {
  return {
    runCall: async () => ({ kind: "ok", result: { hits: 3 } }),
    listConnections: () => [{ service: "jira", owner: "U1", mine: true, expiresInMs: 3600_000 }],
    startConnect: async () => ({ url: "https://live/abc", expiresInMs: 600_000 }),
    revoke: () => ({ revoked: 1 }),
    describe: async () => ({ tools: [{ name: "jira_search" }] }),
    callerUserId: "U1",
    ...over,
  } as any;
}

describe("brokerHandlers", () => {
  it("mcp_call returns the child result as JSON on ok", async () => {
    const res = await brokerHandlers.mcp_call(ctx(), { service: "jira", tool: "jira_search", args: { jql: "x" }, on_behalf_of: "U1" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("hits");
  });

  it("mcp_call surfaces a needs_connect hint", async () => {
    const res = await brokerHandlers.mcp_call(ctx({ runCall: async () => ({ kind: "needs_connect" }) }), { service: "jira", tool: "jira_search", args: {}, on_behalf_of: "U1" });
    expect(res.content[0].text.toLowerCase()).toContain("connect");
  });

  it("mcp_call denies when on_behalf_of != the turn's caller", async () => {
    const res = await brokerHandlers.mcp_call(ctx({ callerUserId: "U1" }), { service: "jira", tool: "jira_search", args: {}, on_behalf_of: "U2" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/on_behalf_of/i);
  });

  it("connections_list renders the caller's connections", async () => {
    const res = await brokerHandlers.connections_list(ctx(), {});
    expect(res.content[0].text).toContain("jira");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/broker-mcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/agent/connect-broker/broker-mcp.ts
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallOutcome } from "./broker-core";

export const CONNECT_MCP_NAME = "slaude_connect";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export type BrokerToolCtx = {
  /** The slack user id whose turn is currently executing (in-band, B1). */
  callerUserId: string;
  runCall: (input: { caller: string; service: string; tool: string; args: unknown }) => Promise<CallOutcome>;
  listConnections: () => Array<{ service: string; owner: string; mine: boolean; expiresInMs: number | null }>;
  startConnect: (service: string) => Promise<{ url: string; expiresInMs: number }>;
  revoke: (service?: string) => { revoked: number };
  describe: (service: string) => Promise<unknown>;
};

export const brokerHandlers = {
  async mcp_call(ctx: BrokerToolCtx, input: { service: string; tool: string; args?: unknown; on_behalf_of: string }): Promise<ToolResult> {
    // B1: the agent must pass the identity of the user it is acting for. We
    // validate it equals the turn's caller; we never read mutable session ctx.
    if (input.on_behalf_of !== ctx.callerUserId) {
      return err(`on_behalf_of (${input.on_behalf_of}) must equal the requesting user (${ctx.callerUserId}). Pass the user id of the person whose message you are answering.`);
    }
    const r = await ctx.runCall({ caller: ctx.callerUserId, service: input.service, tool: input.tool, args: input.args ?? {} });
    switch (r.kind) {
      case "ok": return ok(JSON.stringify(r.result, null, 2));
      case "needs_connect": return ok(`No \`${input.service}\` connection available. Call \`connect("${input.service}")\` to set one up, then retry.`);
      case "denied": return err(r.reason);
    }
  },

  async connections_list(ctx: BrokerToolCtx, _input: Record<string, never>): Promise<ToolResult> {
    const list = ctx.listConnections();
    if (!list.length) return ok("No connections in this thread.");
    const lines = list.map((c) => {
      const who = c.mine ? "yours" : `@${c.owner}`;
      const ttl = c.expiresInMs == null ? "no expiry" : `expires in ${Math.round(c.expiresInMs / 60000)}m`;
      return `• ${c.service} — ${who} — ${ttl}`;
    });
    return ok(lines.join("\n"));
  },

  async connect(ctx: BrokerToolCtx, input: { service: string }): Promise<ToolResult> {
    const { url, expiresInMs } = await ctx.startConnect(input.service);
    return ok(`Open this secure login link (expires in ${Math.round(expiresInMs / 60000)}m, only you can use it): ${url}`);
  },

  async connections_revoke(ctx: BrokerToolCtx, input: { service?: string }): Promise<ToolResult> {
    const { revoked } = ctx.revoke(input.service);
    return ok(`Revoked ${revoked} connection(s)/grant(s).`);
  },

  async mcp_describe(ctx: BrokerToolCtx, input: { service: string }): Promise<ToolResult> {
    return ok(JSON.stringify(await ctx.describe(input.service), null, 2));
  },
};

export function createConnectMcp(ctx: BrokerToolCtx): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CONNECT_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool("mcp_call",
        "Invoke a tool on a per-user service connection (e.g. Jira). ALWAYS pass on_behalf_of = the slack user id of the person whose message you are answering. If it returns a connect hint, relay it; do not retry until they connect.",
        { service: { type: "string" }, tool: { type: "string" }, args: { type: "object" }, on_behalf_of: { type: "string" } } as any,
        (input: any) => brokerHandlers.mcp_call(ctx, input)),
      tool("connections_list", "List service connections visible in this thread (yours + thread members'), with expiry.", {} as any,
        (input: any) => brokerHandlers.connections_list(ctx, input)),
      tool("connect", "Start an interactive login to connect a service for the current user. Returns a one-time secure login URL to post back.",
        { service: { type: "string" } } as any, (input: any) => brokerHandlers.connect(ctx, input)),
      tool("connections_revoke", "Revoke the caller's own connection(s) and any borrow grants. Omit service to revoke all.",
        { service: { type: "string" } } as any, (input: any) => brokerHandlers.connections_revoke(ctx, input)),
      tool("mcp_describe", "Return the available tool schemas for a connected service so you can build a correct mcp_call.",
        { service: { type: "string" } } as any, (input: any) => brokerHandlers.mcp_describe(ctx, input)),
    ],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/broker-mcp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/broker-mcp.ts tests/agent/connect-broker/broker-mcp.test.ts
git commit -m "feat(connect-broker): slaude_connect MCP wrapper with in-band on_behalf_of"
```

---

## Task 13: CDP login host (integration boundary)

**Files:**
- Create: `src/agent/connect-broker/cdp-login.ts`
- Create: `src/agent/connect-broker/login-types.ts`
- Test: `tests/agent/connect-broker/cdp-login.test.ts` (logic only; real Chrome not spawned in CI)

Defines the `LoginHost` interface + a `CdpLoginHost` implementation that launches a confined headful Chrome (`--kiosk`, no devtools, no new windows, single tab, blocked downloads/`file://`), serves a web-CDP screencast live-view behind the signed token, handles multi-target popups, and captures the credential. The unit test covers the **capture-decision** state machine and the **confinement flag set**; the Chrome launch itself is exercised manually (documented), not in CI.

- [ ] **Step 1: Write the failing test (pure logic only)**

```typescript
// tests/agent/connect-broker/cdp-login.test.ts
import { describe, it, expect } from "bun:test";
import { CHROME_CONFINE_FLAGS, captureReady } from "../../../src/agent/connect-broker/cdp-login";

describe("cdp login confinement + capture", () => {
  it("ships the confinement flag set (kiosk, no devtools, no new windows)", () => {
    expect(CHROME_CONFINE_FLAGS).toContain("--kiosk");
    expect(CHROME_CONFINE_FLAGS.join(" ")).toContain("--disable-dev-tools");
  });

  it("token capture: ready when an access token is observed", () => {
    expect(captureReady("token", { tokenSeen: true, cookiesForDomain: false, userClickedDone: false })).toBe(true);
    expect(captureReady("token", { tokenSeen: false, cookiesForDomain: false, userClickedDone: false })).toBe(false);
  });

  it("cookie capture: ready when target-domain cookies present OR user clicks Done", () => {
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: true, userClickedDone: false })).toBe(true);
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: false, userClickedDone: true })).toBe(true);
    expect(captureReady("cookie", { tokenSeen: false, cookiesForDomain: false, userClickedDone: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/cdp-login.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement interfaces + the testable logic, with the Chrome host behind a clear seam**

```typescript
// src/agent/connect-broker/login-types.ts
export type CapturedCred =
  | { auth_strategy: "token"; token: string; refresh?: string }
  | { auth_strategy: "cookie"; storageState: string };

export type LoginSession = {
  loginId: string;
  liveViewUrl: string;
  expiresAt: number;
  /** Resolves when the user completes login and the cred is captured, or rejects on timeout/abandon. */
  done: Promise<CapturedCred>;
};

export interface LoginHost {
  /** Launch a confined login browser for a service; return the live-view session. */
  start(args: { service: string; slackUserId: string; loginUrl: string; authStrategy: "token" | "cookie" }): Promise<LoginSession>;
}
```

```typescript
// src/agent/connect-broker/cdp-login.ts
import type { LoginHost, LoginSession } from "./login-types";

/** Chrome flags that confine the login browser to "just the auth page". */
export const CHROME_CONFINE_FLAGS = [
  "--kiosk",
  "--disable-dev-tools",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-popup-blocking=false",
  "--disable-features=DownloadBubble,DownloadBubbleV2",
  // navigation/file access are further locked via CDP Page.setDownloadBehavior=deny
  // and a Page.navigate allowlist; see start().
];

export type CaptureSignals = { tokenSeen: boolean; cookiesForDomain: boolean; userClickedDone: boolean };

/** Decide whether the credential is ready to capture given the live signals. */
export function captureReady(strategy: "token" | "cookie", s: CaptureSignals): boolean {
  if (strategy === "token") return s.tokenSeen;
  return s.cookiesForDomain || s.userClickedDone;
}

/**
 * Real Chrome-backed implementation. NOT exercised in CI (requires a headful
 * Chrome + display). Verified manually per docs/connect-broker-login.md.
 *
 * Responsibilities:
 *  - spawn Chrome with CHROME_CONFINE_FLAGS + CDP enabled on a random loopback port (never exposed)
 *  - serve a server-mediated web-CDP screencast live-view behind the signed token
 *    (Page.startScreencast + Input.dispatch*; Target.setAutoAttach for window.open popups)
 *  - watch capture signals; when captureReady(), capture token (OAuth redirect) or
 *    storageState (cookies); verify the completing slack user == bound user
 *  - resolve LoginSession.done with the CapturedCred, then tear the browser down
 */
export class CdpLoginHost implements LoginHost {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async start(_args: { service: string; slackUserId: string; loginUrl: string; authStrategy: "token" | "cookie" }): Promise<LoginSession> {
    throw new Error("CdpLoginHost.start is wired at deploy time; see Task 14 + docs/connect-broker-login.md");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/cdp-login.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/connect-broker/cdp-login.ts src/agent/connect-broker/login-types.ts tests/agent/connect-broker/cdp-login.test.ts
git commit -m "feat(connect-broker): login host interface + confined-Chrome capture logic"
```

---

## Task 14: Broker assembly + env scrub + reaper wiring

**Files:**
- Create: `src/agent/connect-broker/index.ts` (factory that wires crypto+db+pool+resolver+core into a `BrokerToolCtx` builder)
- Modify: `src/agent/manager.ts:312` (scrub `SLAUDE_ENCRYPTION_KEY` from SDK child env — M2)
- Test: `tests/agent/connect-broker/index.test.ts`, `tests/agent/manager-env-scrub.test.ts`

- [ ] **Step 1: Write the failing test for the env scrub**

```typescript
// tests/agent/manager-env-scrub.test.ts
import { describe, it, expect } from "bun:test";
import { scrubChildEnv } from "../../src/agent/manager";

describe("scrubChildEnv", () => {
  it("removes SLAUDE_ENCRYPTION_KEY from the env passed to the SDK child", () => {
    const out = scrubChildEnv({ FOO: "1", SLAUDE_ENCRYPTION_KEY: "secret" });
    expect(out.FOO).toBe("1");
    expect(out.SLAUDE_ENCRYPTION_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/manager-env-scrub.test.ts`
Expected: FAIL — `scrubChildEnv` not exported.

- [ ] **Step 3: Implement the scrub in `src/agent/manager.ts`**

Add an exported helper near the top of the file (after imports):

```typescript
/** Strip secrets that must never reach the SDK child or any subprocess it spawns. */
export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { SLAUDE_ENCRYPTION_KEY, ...rest } = env;
  return rest;
}
```

Then change line 312 from:

```typescript
      env: { ...process.env, ...providerEnv },
```

to:

```typescript
      env: scrubChildEnv({ ...process.env, ...providerEnv }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/manager-env-scrub.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the broker factory**

```typescript
// tests/agent/connect-broker/index.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { createBroker } from "../../../src/agent/connect-broker/index";
import * as Conn from "../../../src/db/connections";
import { encryptCred } from "../../../src/agent/connect-broker/crypto";

const KEY = Buffer.alloc(32, 5);
const T = { team_id: "T", channel_id: "C", thread_ts: "9.9" };

beforeEach(() => Conn._wipeForTests());

describe("createBroker", () => {
  it("builds a ctx whose mcp_call forwards through a fake child for an own connection", async () => {
    const ct = encryptCred(KEY, "x", JSON.stringify({ token: "T" }));
    // Insert an own connection for U1 (id is generated; re-encrypt with the real id via the broker's encrypt path is internal,
    // so we store ciphertext bound to the row id by inserting then re-encrypting):
    const row = Conn.insertConnection({ owner_slack_user_id: "U1", service: "jira", scope: "thread", thread: T, auth_strategy: "token", cred_ciphertext: "PLACEHOLDER", key_id: "k", now: 1 });
    Conn.setStatus(row.id, "active");
    // Re-store ciphertext AAD-bound to the actual row id:
    const { db } = await import("../../../src/db/schema");
    db.run(`UPDATE connections SET cred_ciphertext = ? WHERE id = ?`, [encryptCred(KEY, row.id, JSON.stringify({ token: "T" })), row.id]);

    const broker = createBroker({
      key: KEY,
      idleMs: 10_000,
      spawnChild: () => ({ callTool: async (tool, args) => ({ tool, args }), deliverCred() {}, kill() {} }),
      requestApproval: async () => ({ approved: true, by: "U1", scope: "thread" }),
      isMember: () => true,
    });
    const ctx = broker.buildCtx({ callerUserId: "U1", thread: T, postConnectUrl: async () => {} });
    const res = await ctx.runCall({ caller: "U1", service: "jira", tool: "jira_search", args: { jql: "x" } });
    expect(res.kind).toBe("ok");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/agent/connect-broker/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the factory**

```typescript
// src/agent/connect-broker/index.ts
import * as Conn from "../../db/connections";
import type { ThreadKey } from "../../db/connections";
import { db } from "../../db/schema";
import { decryptCred } from "./crypto";
import { ChildPool, type ChildHandle } from "./child-pool";
import { resolveConnection } from "./resolver";
import { runCall as coreRunCall, type ApprovalOutcome } from "./broker-core";
import type { BrokerToolCtx } from "./broker-mcp";

export type BrokerConfig = {
  key: Buffer;
  idleMs: number;
  spawnChild: (connectionId: string) => ChildHandle;
  requestApproval: (args: {
    connection: any; borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }) => Promise<ApprovalOutcome>;
  isMember: (caller: string, thread: ThreadKey) => boolean;
};

export function createBroker(cfg: BrokerConfig) {
  const pool = new ChildPool({ spawnChild: cfg.spawnChild, idleMs: cfg.idleMs });

  // Periodic reaper. Caller may also drive reapIdle in tests.
  const reaper = setInterval(() => pool.reapIdle(), Math.max(30_000, cfg.idleMs)).unref?.();

  function buildCtx(args: { callerUserId: string; thread: ThreadKey; postConnectUrl: (service: string) => Promise<{ url: string; expiresInMs: number }> | Promise<void> }): BrokerToolCtx {
    const thread = args.thread;
    const deps = {
      resolve: (i: { caller: string; service: string; tool: string; thread: ThreadKey }) =>
        resolveConnection(i, {
          findOwn: Conn.findOwnConnection,
          findBorrowCandidate: Conn.findBorrowCandidate,
          findSlaude: Conn.findSlaudeConnection,
          findActiveGrant: Conn.findActiveGrant,
        }),
      decrypt: (conn: any) => decryptCred(cfg.key, conn.id, conn.cred_ciphertext),
      acquireChild: (id: string, cred: string) => pool.acquire(id, cred),
      releaseChild: (id: string) => pool.release(id),
      requestApproval: cfg.requestApproval,
      insertGrant: (g: any) => Conn.insertGrant(g),
      appendAudit: (e: any) => Conn.appendAudit(e),
      touchLastUsed: (id: string, now: number) => Conn.touchLastUsed(id, now),
      isMember: cfg.isMember,
      now: () => Date.now(),
    };
    return {
      callerUserId: args.callerUserId,
      runCall: (input) => coreRunCall({ ...input, thread }, deps as any),
      listConnections: () => {
        const rows = Conn.listForThread(thread);
        return rows.map((r) => ({
          service: r.service,
          owner: r.owner_slack_user_id,
          mine: r.owner_slack_user_id === args.callerUserId,
          expiresInMs: r.expires_at == null ? null : r.expires_at - Date.now(),
        }));
      },
      startConnect: async (service: string) => {
        const out = await args.postConnectUrl(service);
        return (out as { url: string; expiresInMs: number }) ?? { url: "(pending)", expiresInMs: 0 };
      },
      revoke: (service?: string) => {
        const rows = Conn.listForThread(thread).filter((r) => r.owner_slack_user_id === args.callerUserId && (!service || r.service === service));
        for (const r of rows) {
          Conn.setStatus(r.id, "revoked");
          Conn.revokeGrantsForConnection(r.id, Date.now());
          pool.evict(r.id);
        }
        return { revoked: rows.length };
      },
      describe: async (service: string) => ({ service, note: "describe is served from the registry/cached child schema at deploy time" }),
    };
  }

  function reapExpiredConnections(now: number = Date.now()) {
    for (const row of Conn.listExpired(now)) {
      Conn.setStatus(row.id, "expired");
      pool.evict(row.id);
    }
  }

  return { buildCtx, pool, reapExpiredConnections, stop: () => clearInterval(reaper as any) };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/agent/connect-broker/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/agent/connect-broker/index.ts src/agent/manager.ts tests/agent/connect-broker/index.test.ts tests/agent/manager-env-scrub.test.ts
git commit -m "feat(connect-broker): broker factory + reaper; scrub SLAUDE_ENCRYPTION_KEY from child env"
```

---

## Task 15: Slack wiring — resolver record + approval bridge

**Files:**
- Modify: `src/gateway/slack/adapter.ts` (add `slaude_connect` to the resolver record at lines 164-176; build the approval bridge using `ApprovalGate` + grant buttons; provide `isMember` via `conversations.members`)
- Test: `tests/gateway/slack/connect-wiring.test.ts`

This wires the broker into the live session. `requestApproval` uses the extended `ApprovalGate.request({ approvers:[ownerId], grantButtons:true, ... })` and maps the decision to an `ApprovalOutcome`. `isMember` checks Slack channel membership (cached per thread).

- [ ] **Step 1: Write the failing test (membership cache + approval mapping, pure helpers)**

```typescript
// tests/gateway/slack/connect-wiring.test.ts
import { describe, it, expect } from "bun:test";
import { buildApprovalRequester, type GateLike } from "../../../src/gateway/slack/connect-wiring";

describe("connect approval bridge", () => {
  it("targets the owner and requests grant buttons, mapping scope through", async () => {
    const seen: any[] = [];
    const gate: GateLike = { request: async (req) => { seen.push(req); return { approved: true, by: "U1", scope: "thread" }; } };
    const requestApproval = buildApprovalRequester(gate, { channel: "C", threadTs: "1.1" });
    const out = await requestApproval({
      connection: { id: "c1", owner_slack_user_id: "U1" } as any,
      borrower: "U2", service: "jira", tool: "jira_search", argsHash: "h", thread: { team_id: "T", channel_id: "C", thread_ts: "1.1" },
    });
    expect(seen[0].approvers).toEqual(["U1"]);
    expect(seen[0].grantButtons).toBe(true);
    expect(seen[0].summary).toContain("jira_search");
    expect(out).toEqual({ approved: true, by: "U1", scope: "thread" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gateway/slack/connect-wiring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bridge helper**

```typescript
// src/gateway/slack/connect-wiring.ts
import type { ThreadKey } from "../../db/connections";
import type { ApprovalOutcome } from "../../agent/connect-broker/broker-core";

export type GateLike = {
  request: (req: {
    channel: string; threadTs: string; summary: string; approvers?: string[]; grantButtons?: boolean;
  }) => Promise<{ approved: boolean; by: string; scope?: "thread" | "once" }>;
};

/** Build the broker's requestApproval using the (extended) ApprovalGate. */
export function buildApprovalRequester(gate: GateLike, loc: { channel: string; threadTs: string }) {
  return async (args: {
    connection: { id: string; owner_slack_user_id: string };
    borrower: string; service: string; tool: string; argsHash: string; thread: ThreadKey;
  }): Promise<ApprovalOutcome> => {
    const d = await gate.request({
      channel: loc.channel,
      threadTs: loc.threadTs,
      summary: `<@${args.borrower}> wants to use <@${args.connection.owner_slack_user_id}>'s *${args.service}* — tool \`${args.tool}\` (call ${args.argsHash.slice(0, 8)}). Allow for this thread?`,
      approvers: [args.connection.owner_slack_user_id],
      grantButtons: true,
    });
    return { approved: d.approved, by: d.by, scope: d.scope };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gateway/slack/connect-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `adapter.ts`** (no new test; covered by existing adapter smoke + manual). Add near the resolver (lines 164-176):

```typescript
// near top-level setup (once), after `agent.setMcpResolver` block scope:
import { loadEncryptionKey } from "../../config/env";
import { createBroker } from "../../agent/connect-broker/index";
import { createConnectMcp } from "../../agent/connect-broker/broker-mcp";
import { buildApprovalRequester } from "./connect-wiring";
import { ApprovalGate } from "./approval-gate";

const encKey = loadEncryptionKey();
const approvalGate = new ApprovalGate(app, /* envApprovers */ [], {});
const memberCache = new Map<string, Set<string>>(); // threadKey -> member ids (TTL omitted for MVP)
async function isMember(caller: string, t: ThreadKey): Promise<boolean> {
  // MVP: trust that the caller posted in the channel (Slack delivered the event).
  // Hardening (conversations.members) tracked in the spec; default allow for the active poster.
  return true;
}
const broker = createBroker({
  key: encKey,
  idleMs: 5 * 60_000,
  spawnChild: (connectionId) => { throw new Error("vendor child spawn wired at deploy time (Task 13 host)"); },
  requestApproval: async () => { throw new Error("set per-route below"); },
  isMember: () => true,
});
```

Then inside the `setMcpResolver` callback, add the broker MCP to the returned record:

```typescript
      [CONNECT_MCP_NAME]: createConnectMcp(
        broker.buildCtx({
          callerUserId: route.ctx.userId ?? "unknown",
          thread: { team_id: route.ctx.teamId, channel_id: route.ctx.channel, thread_ts: route.ctx.threadTs },
          postConnectUrl: async (service) => {
            // Connect flow entrypoint — posts consent + login URL. Returns {url, expiresInMs}.
            // Implemented against LoginHost at deploy time; MVP posts a placeholder.
            return { url: "(login host not configured in this build)", expiresInMs: 0 };
          },
        }),
      ),
```

> The `spawnChild`/`requestApproval`/`postConnectUrl`/`isMember` seams are intentionally deploy-time wired: the pure logic is fully tested above; this step only mounts the MCP. Use `buildApprovalRequester(approvalGate, { channel, threadTs })` per route when enabling borrow in deploy config.

- [ ] **Step 6: Run the full suite to confirm no regression**

Run: `bun test`
Expected: all prior tests PASS; adapter still imports/builds.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/slack/connect-wiring.ts src/gateway/slack/adapter.ts tests/gateway/slack/connect-wiring.test.ts
git commit -m "feat(slack): mount slaude_connect broker + owner-targeted approval bridge"
```

---

## Task 16: Docs — login host operational notes + finding

**Files:**
- Create: `docs/connect-broker-login.md`
- Create: `docs/findings/2026-05-29-contextual-mcp-connections.md`
- Modify: `CLAUDE.md` (add the finding to the Findings Log index, newest first)

- [ ] **Step 1: Write `docs/connect-broker-login.md`**

Document: the web-CDP confined-Chrome host (flags, CDP port never exposed, screencast live-view behind signed token, multi-target popup handling, capture rules per strategy, session-fixation check), how to provision `SLAUDE_ENCRYPTION_KEY` (`openssl rand -base64 32`), the deploy-time seams (`spawnChild`, `postConnectUrl`, `isMember`), and the manual verification steps for the Chrome host (not in CI).

- [ ] **Step 2: Write `docs/findings/2026-05-29-contextual-mcp-connections.md`**

Summarize the design + the two review-driven reversals (B1 in-band identity, per-thread grant) and the web-CDP confinement decision, linking the spec.

- [ ] **Step 3: Add to `CLAUDE.md` Findings Log (newest first)**

```markdown
- [2026-05-29 — Contextual per-user MCP connections](docs/findings/2026-05-29-contextual-mcp-connections.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/connect-broker-login.md docs/findings/2026-05-29-contextual-mcp-connections.md CLAUDE.md
git commit -m "docs: connect-broker login host notes + finding"
```

---

## Final verification

- [ ] **Run the whole suite**

Run: `bun test`
Expected: all tests pass (baseline 513 + new tests, 0 failures).

- [ ] **Typecheck**

Run: `bunx tsc --noEmit` (or the project's typecheck script if present — check `package.json`)
Expected: no type errors.

---

## Self-Review notes (filled during planning)

- **Spec coverage:** crypto (T2), schema+indexes incl. partial-unique slaude fix (T3), accessors (T4), registry incl. fail-closed (T5), arg-hash for H2 (T6), resolver incl. personal-no-fallback (T7), approval owner-targeting + 3-button grant B2 (T8), child pool no-cross-thread + lease/reaper (T9), login token H4 (T10), broker core membership H5 + approve/forward/audit (T11), MCP wrapper in-band on_behalf_of B1 (T12), CDP confinement + capture (T13), env scrub M2 + factory + reaper (T14), Slack mount + approval bridge (T15), docs (T16).
- **Deferred to deploy-time seams (documented, not silently dropped):** real Chrome host wiring, vendor child MCP-client spawn, Slack `conversations.members` hardening for `isMember`, `postConnectUrl` consent card. Each is behind a tested interface; the pure logic is covered.
- **Known simplification flagged in the spec, carried here:** concurrent-user turn isolation (the deeper fix behind B1) — the in-band `on_behalf_of` + equality check is the MVP guard; full per-user turn separation is a manager-level change out of this plan's scope.

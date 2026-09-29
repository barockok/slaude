/**
 * Gateway-owned MCP credentials, for both kinds of owner: the agent's own shared
 * identity per (tenant, persona), and a person per account.
 *
 * This is the only module that encrypts or decrypts these rows. Every payload
 * is AES-256-GCM under SLAUDE_MASTER_KEY (src/db/crypto.ts); expires_at is the
 * only plaintext field. Nothing here ever logs a payload, a token, or a
 * decrypted entry — failures name the owner kind, the row id and the server
 * key, and nothing else.
 *
 * Owner exclusivity is enforced by the schema's CHECK constraints rather than
 * here, so no caller can write a row with no owner or two.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";
import type { StoredEntry } from "../agent/mcp-oauth/store";
import type { CredentialOwner } from "../agent/credential-owner";

type Row = { id: string; server_key: string; payload: string };

/** WHERE clause + params selecting exactly one owner's rows. */
function ownerWhere(owner: CredentialOwner): { sql: string; params: unknown[] } {
  return owner.kind === "account"
    ? { sql: "account_id = ?", params: [owner.accountId] }
    : { sql: "agent_tenant = ? AND agent_persona = ?", params: [owner.tenant, owner.persona] };
}

/** A decrypted payload is trusted only if it has the shape the agent reads. */
export function isEntry(v: unknown): v is StoredEntry {
  const e = v as StoredEntry;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.serverName === "string" &&
    typeof e.serverUrl === "string" &&
    typeof e.accessToken === "string" &&
    e.accessToken.length > 0 &&
    typeof e.expiresAt === "number" &&
    Number.isFinite(e.expiresAt)
  );
}

/** Create or replace one owner's credential for one server. */
export async function putCredential(owner: CredentialOwner, serverKey: string, entry: StoredEntry): Promise<void> {
  const now = Date.now();
  const payload = encrypt(JSON.stringify(entry));
  // One statement per owner kind: each ON CONFLICT target must name the unique
  // constraint that applies to that kind of row.
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

/**
 * Write only if this entry expires no earlier than what is stored. Used by node
 * write-back and the boot import, where an older token must never replace a
 * newer one — for instance a rotation made on another node since this one
 * seeded.
 *
 * The comparison lives in the upsert's own WHERE, so the database performs the
 * read-compare-write atomically. Two nodes finishing turns for the same owner
 * cannot interleave, and nothing needs a distributed lock to guarantee it.
 * Returns whether a row was written.
 */
export async function putCredentialIfNewer(owner: CredentialOwner, serverKey: string, entry: StoredEntry): Promise<boolean> {
  const now = Date.now();
  const payload = encrypt(JSON.stringify(entry));
  const guard = "WHERE mcp_credentials.expires_at <= excluded.expires_at";
  const r =
    owner.kind === "account"
      ? await db.run(
          `INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, server_key)
           DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at
           ${guard}`,
          [randomUUID(), owner.accountId, serverKey, payload, entry.expiresAt, now],
        )
      : await db.run(
          `INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent_tenant, agent_persona, server_key)
           DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, updated_at = excluded.updated_at
           ${guard}`,
          [randomUUID(), owner.tenant, owner.persona, serverKey, payload, entry.expiresAt, now],
        );
  return (r.changes ?? 0) > 0;
}

/**
 * Write only if this owner holds nothing for this server yet. For one-time
 * migration: once the store has a row it is authoritative, and an old file with
 * a later nominal expiry must never replace a grant refreshed since. Idempotent
 * and safe for concurrent callers. Returns whether a row was written.
 */
export async function putCredentialIfAbsent(owner: CredentialOwner, serverKey: string, entry: StoredEntry): Promise<boolean> {
  const now = Date.now();
  const payload = encrypt(JSON.stringify(entry));
  const r =
    owner.kind === "account"
      ? await db.run(
          `INSERT INTO mcp_credentials (id, account_id, server_key, payload, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, server_key) DO NOTHING`,
          [randomUUID(), owner.accountId, serverKey, payload, entry.expiresAt, now],
        )
      : await db.run(
          `INSERT INTO mcp_credentials (id, agent_tenant, agent_persona, server_key, payload, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (agent_tenant, agent_persona, server_key) DO NOTHING`,
          [randomUUID(), owner.tenant, owner.persona, serverKey, payload, entry.expiresAt, now],
        );
  return (r.changes ?? 0) > 0;
}

/**
 * Every credential one owner holds, keyed by server key. A row that fails to
 * decrypt or does not have the expected shape is omitted and reported without
 * its contents: returning a half-decoded entry would hand the agent a token
 * nobody can vouch for.
 */
export async function credentialsFor(owner: CredentialOwner): Promise<Record<string, StoredEntry>> {
  const w = ownerWhere(owner);
  const rows = await db.query<Row>(
    `SELECT id, server_key, payload FROM mcp_credentials WHERE ${w.sql}`,
    w.params,
  );
  const out: Record<string, StoredEntry> = {};
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypt(r.payload));
    } catch {
      console.error(`[mcp-credentials] could not decrypt owner=${owner.kind} row=${r.id} server=${r.server_key}`);
      continue;
    }
    if (!isEntry(parsed)) {
      console.error(`[mcp-credentials] malformed entry owner=${owner.kind} row=${r.id} server=${r.server_key}`);
      continue;
    }
    out[r.server_key] = parsed;
  }
  return out;
}

/** The stored expiry for one owner's server, without decrypting anything. */
export async function storedExpiry(owner: CredentialOwner, serverKey: string): Promise<number | null> {
  const w = ownerWhere(owner);
  const row = await db.one<{ expires_at: number }>(
    `SELECT expires_at FROM mcp_credentials WHERE ${w.sql} AND server_key = ?`,
    [...w.params, serverKey],
  );
  return row ? Number(row.expires_at) : null;
}

/** Remove one owner's credential for one server. True if a row was removed. */
export async function deleteCredential(owner: CredentialOwner, serverKey: string): Promise<boolean> {
  const w = ownerWhere(owner);
  const r = await db.run(
    `DELETE FROM mcp_credentials WHERE ${w.sql} AND server_key = ?`,
    [...w.params, serverKey],
  );
  return (r.changes ?? 0) > 0;
}

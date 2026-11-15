/**
 * The credential bookkeeping pointer (slice F, rc.22): `mcp_credentials.user_id`
 * names the user record a person's credential row belongs to.
 *
 * It is bookkeeping and nothing else. No decision reads it: credentials keep
 * resolving `slack_identities -> account -> mcp_credentials`, and a guard test
 * (tests/slices/credential-pointer-guard.test.ts) fails when any other source
 * file touches the column. This is the only module that names it, so a later
 * slice that wants a read path has to start here, on purpose.
 *
 * Every function here is best effort where it runs beside a credential write:
 * a failure is swallowed and counted by the caller's log line, never thrown,
 * because the credential (and the login or link that triggered it) matters more
 * than the pointer. The reconciler repairs what a failure missed.
 *
 * The Postgres CHECK `user_id IS NULL OR account_id IS NOT NULL` cannot exist on
 * SQLite, so `account_id IS NOT NULL` is part of every write below.
 */
import * as Domain from "./domain";
import { db, type DbClient } from "./schema";

/** Set one row's pointer. Refused (false) for an agent-owned row or a missing row. */
export async function setCredentialPointer(rowId: string, userId: string, c: DbClient = db): Promise<boolean> {
  const r = await c.run("UPDATE mcp_credentials SET user_id = ? WHERE id = ? AND account_id IS NOT NULL", [userId, rowId]);
  return (r.changes ?? 0) > 0;
}

/** The live user an account maps to (account -> oidc binding -> alias-resolved user), or null. */
export async function userForAccountId(accountId: string, c: DbClient = db): Promise<string | null> {
  const a = await c.one<{ issuer: string; subject: string }>("SELECT issuer, subject FROM accounts WHERE id = ?", [accountId]);
  if (!a) return null;
  const b = await Domain.findBinding({ service: "oidc", kind: "subject", workspace: a.issuer, value: a.subject }, c);
  if (!b) return null;
  return Domain.resolveUserId(b.user_id, c);
}

/**
 * Set the pointer on every credential row of one account, when its user is
 * known. Never throws; returns the rows changed (0 when the user is unknown or
 * on any failure). A row already pointing at that user is not touched.
 */
export async function recordPointerForAccount(accountId: string, c: DbClient = db): Promise<number> {
  try {
    const userId = await userForAccountId(accountId, c);
    if (!userId) return 0;
    const r = await c.run("UPDATE mcp_credentials SET user_id = ? WHERE account_id = ? AND (user_id IS NULL OR user_id <> ?)", [userId, accountId, userId]);
    return r.changes ?? 0;
  } catch (e) {
    console.warn(`[mcp-credentials] pointer not recorded, left for the reconciler: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * The same, for the projection that has just created or found the account's
 * user: runs inside the caller's transaction under its own savepoint, so a
 * failure rolls back only this update. `issuer` and `subject` name the account.
 */
export async function recordPointerInTx(a: { issuer: string; subject: string }, userId: string, tx: DbClient): Promise<number> {
  await tx.exec("SAVEPOINT cred_pointer");
  try {
    const r = await tx.run(
      "UPDATE mcp_credentials SET user_id = ? WHERE account_id IN (SELECT id FROM accounts WHERE issuer = ? AND subject = ?) AND (user_id IS NULL OR user_id <> ?)",
      [userId, a.issuer, a.subject, userId],
    );
    await tx.exec("RELEASE SAVEPOINT cred_pointer");
    return r.changes ?? 0;
  } catch (e) {
    await tx.exec("ROLLBACK TO SAVEPOINT cred_pointer");
    await tx.exec("RELEASE SAVEPOINT cred_pointer");
    console.warn(`[mcp-credentials] pointer not recorded, left for the reconciler: ${(e as Error).message}`);
    return 0;
  }
}

export interface PointerMove {
  id: string;
  from: string;
  to: string;
}

/**
 * Merge step: repoint every credential pointer from the loser to the survivor.
 * Must run BEFORE the loser's user row is deleted (the delete fires
 * ON DELETE SET NULL and the pointer would be lost). Returns the rows moved for
 * the ledger. Throws on a database error: the merge engine wraps this in its own
 * guard, so a pointer problem never fails a merge.
 */
export async function repointForMerge(c: DbClient, loserId: string, survivorId: string): Promise<PointerMove[]> {
  const rows = await c.query<{ id: string }>("SELECT id FROM mcp_credentials WHERE user_id = ? AND account_id IS NOT NULL ORDER BY id", [loserId]);
  if (rows.length === 0) return [];
  await c.run("UPDATE mcp_credentials SET user_id = ? WHERE user_id = ? AND account_id IS NOT NULL", [survivorId, loserId]);
  return rows.map((r) => ({ id: r.id, from: loserId, to: survivorId }));
}

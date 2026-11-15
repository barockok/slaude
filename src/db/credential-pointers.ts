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
import { env } from "../config/env";
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
  if (!env.slices.credentialPointers()) return 0;
  await tx.exec("SAVEPOINT cred_pointer");
  try {
    // Never wait long for a lock inside a login or link transaction (Postgres; sqlite has one writer).
    if (tx.dialect === "pg") await tx.exec("SET LOCAL lock_timeout = '250ms'");
    const r = await tx.run(
      "UPDATE mcp_credentials SET user_id = ? WHERE account_id IN (SELECT id FROM accounts WHERE issuer = ? AND subject = ?) AND (user_id IS NULL OR user_id <> ?)",
      [userId, a.issuer, a.subject, userId],
    );
    if (tx.dialect === "pg") await tx.exec("RESET lock_timeout");
    await tx.exec("RELEASE SAVEPOINT cred_pointer");
    return r.changes ?? 0;
  } catch (e) {
    await tx.exec("ROLLBACK TO SAVEPOINT cred_pointer");
    if (tx.dialect === "pg") await tx.exec("RESET lock_timeout").catch(() => {});
    await tx.exec("RELEASE SAVEPOINT cred_pointer");
    console.warn(`[mcp-credentials] pointer not recorded, left for the reconciler: ${(e as Error).message}`);
    return 0;
  }
}

const pendingWrites = new Set<Promise<void>>();

/** Resolve when every scheduled pointer write has finished (tests). */
export async function settlePointerWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
}

/**
 * After a person's credential write has committed: record the pointer in the
 * background. With SLAUDE_CREDENTIAL_POINTERS off (the default) this does
 * nothing at all. Never awaited by the caller (a token refresh during a turn
 * must not wait for three reads and an update, nor for a lock), never throws,
 * and a slow or failed write only leaves the pointer for `reconcile --fill-pointers`.
 */
export function scheduleRecordPointer(accountId: string): void {
  try {
    if (!env.slices.credentialPointers()) return;
    const p: Promise<void> = recordPointerForAccount(accountId)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pendingWrites.delete(p);
      });
    pendingWrites.add(p);
  } catch {
    /* bookkeeping must never fail a credential write */
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

export interface PointerReport {
  /** Person credential rows seen. */
  total: number;
  /** NULL pointer (a row from before the column, or a failed dual write). */
  nullPointer: number;
  /** A pointer that is not the account's current user (after a merge undo, an unlinked or deleted record). Reported, never repaired. */
  drift: number;
  /** Rows whose account maps to no user yet: nothing can be filled. */
  unresolved: number;
  /** NULL pointers filled by this run (0 in a report-only run). */
  filled: number;
  /** Drifted pointers set to the account's user by this run (only with SLAUDE_CREDENTIAL_POINTERS=on, and only with fill). */
  repaired: number;
}

/**
 * The reconciler's view of the pointer: per person credential row, compare the
 * pointer with the user the account maps to (oidc binding, alias resolved).
 * `fill` sets NULL pointers, compare-and-set on the old NULL, so a pointer
 * written meanwhile is never overwritten; a differing pointer is repaired only
 * with SLAUDE_CREDENTIAL_POINTERS=on (compare-and-set on the old value). Read in keyset pages by row id. Reads no credential payload.
 */
export async function pointerReport(c: DbClient, o: { fill: boolean; pageSize: number }): Promise<PointerReport> {
  const out: PointerReport = { total: 0, nullPointer: 0, drift: 0, unresolved: 0, filled: 0, repaired: 0 };
  // Drift is repaired only when the operator has turned the pointer on (SLAUDE_CREDENTIAL_POINTERS=on) and asked to fill.
  const repair = o.fill && env.slices.credentialPointers();
  let after = "";
  for (;;) {
    const rows = await c.query<{ id: string; ptr: string | null; acct_user: string | null }>(
      `SELECT c.id AS id, c.user_id AS ptr, b.user_id AS acct_user
       FROM mcp_credentials c
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN bindings b ON b.service = 'oidc' AND b.kind = 'subject' AND b.workspace = a.issuer AND b.value = a.subject
       WHERE c.account_id IS NOT NULL AND c.id > ?
       ORDER BY c.id LIMIT ?`,
      [after, o.pageSize],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      out.total++;
      // A binding's user_id is a foreign key to a live user, so no alias walk (and no extra read) per row.
      const live = r.acct_user;
      if (r.ptr === null) {
        out.nullPointer++;
        if (!live) out.unresolved++;
        else if (o.fill) {
          const w = await c.run("UPDATE mcp_credentials SET user_id = ? WHERE id = ? AND user_id IS NULL AND account_id IS NOT NULL", [live, r.id]);
          out.filled += w.changes ?? 0;
        }
      } else if (live && live !== r.ptr) {
        out.drift++;
        if (repair) {
          const w = await c.run("UPDATE mcp_credentials SET user_id = ? WHERE id = ? AND user_id = ? AND account_id IS NOT NULL", [live, r.id, r.ptr]);
          out.repaired += w.changes ?? 0;
        }
      }
    }
    after = rows[rows.length - 1]!.id;
    if (rows.length < o.pageSize) break;
  }
  return out;
}

/**
 * Undo support: give the pointers a merge moved back to the loser, from the
 * ledger's `moved.credentials`. Compare-and-set (only a pointer still at the
 * survivor moves), so a pointer changed since is left. Returns rows restored.
 * The caller guards it: a pointer problem never fails an undo.
 */
export async function restorePointersForUndo(c: DbClient, moves: readonly PointerMove[]): Promise<number> {
  let n = 0;
  for (const m of moves) {
    const r = await c.run("UPDATE mcp_credentials SET user_id = ? WHERE id = ? AND user_id = ? AND account_id IS NOT NULL", [m.from, m.id, m.to]);
    n += r.changes ?? 0;
  }
  return n;
}

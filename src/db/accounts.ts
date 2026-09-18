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

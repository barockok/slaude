/**
 * End-user accounts and their Slack bindings (phase 2 identity).
 *
 * The account is keyed on (issuer, subject) rather than email, because email is
 * mutable at the provider and subject is not. Email is carried for display and
 * refreshed on each login.
 */
import { invalidateActors } from "../refs/actor";
import * as Domain from "./domain";
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { emitDomainEvents } from "../audit/domain";
import type { DomainEvent } from "./domain";
import { claimLinkToken } from "./link-token-uses";
import { projectAccountDeletion, projectLink, projectLogin, projectUnlink } from "./account-projection";

/** Audit the events a projection returned, after commit. Never throws. */
async function emitAfterCommit(events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await emitDomainEvents(events, { actorId: "system" });
  } catch (e) {
    console.warn(`[domain] audit of projection events failed: ${(e as Error).message}`);
  }
}

export interface AccountRow {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  /** The last login's token proved the address (email_verified === true and an email claim). Boolean on pg, 0 or 1 on sqlite. */
  email_proven?: boolean | number;
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

/**
 * Create the account or refresh its email. Identity is (issuer, subject).
 * The domain-record projection (user, oidc and email bindings) rides in the
 * same transaction under a savepoint, so it can never fail the login.
 */
export async function upsertAccount(i: { issuer: string; subject: string; email: string; emailProven?: boolean }): Promise<AccountRow> {
  const now = Date.now();
  const proven = i.emailProven === true;
  const provenParam = db.dialect === "pg" ? proven : proven ? 1 : 0;
  const { row, events } = await db.transaction(async (tx) => {
    const before = await tx.one<AccountRow>("SELECT * FROM accounts WHERE issuer = ? AND subject = ?", [i.issuer, i.subject]);
    await tx.run(
      `INSERT INTO accounts (id, issuer, subject, email, email_proven, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer, subject)
       DO UPDATE SET email = excluded.email, email_proven = excluded.email_proven, updated_at = excluded.updated_at`,
      [randomUUID(), i.issuer, i.subject, i.email, provenParam, now, now],
    );
    const after = await tx.one<AccountRow>("SELECT * FROM accounts WHERE issuer = ? AND subject = ?", [i.issuer, i.subject]);
    if (!after) throw new Error("account upsert did not produce a row");
    const events = await projectLogin({ ...i, emailProven: proven, previousEmail: before?.email ?? null }, tx);
    return { row: after, events };
  });
  await emitAfterCommit(events);
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
 * Every distinct account a Slack user id is bound to, across all workspaces.
 * Only for callers that genuinely have no workspace in hand — the on-disk
 * credential import, whose paths predate workspaces. Anyone with a team id must
 * use accountForSlackUser: the same id in two workspaces can be two people.
 */
export async function accountIdsForSlackUserAnyTeam(slackUserId: string): Promise<string[]> {
  const rows = await db.query<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM slack_identities WHERE slack_user_id = ?",
    [slackUserId],
  );
  return rows.map((r) => r.account_id);
}

/**
 * Bind a Slack identity to an account.
 *
 * Rebinding to a DIFFERENT account is refused rather than overwritten: a
 * replay while the link stands can only be a no-op (same account) or a
 * rejection. That does not survive an unlink, so a redemption that names a
 * link token (`token`) also claims the token's jti in the single-use ledger,
 * in the same transaction. A token already used while no link of this account
 * stands is refused with "link-used": the unlink-then-replay case.
 */
export async function linkSlackIdentity(
  i: { teamId: string; slackUserId: string; accountId: string; via: string; token?: { jti: string; expiresAt: number } },
): Promise<
  | { ok: true; created: boolean }
  | { ok: false; reason: "already-linked"; existingAccountId: string }
  | { ok: false; reason: "link-used" }
> {
  // Select-then-insert and the projection share one transaction. A replay
  // (same account) or a refusal (other account) returns before any write.
  const out = await db.transaction(async (tx) => {
    // Claim first: on Postgres a concurrent claim of the same jti waits here for
    // the winner, then reads the winner's committed link below.
    const claimed = i.token
      ? await claimLinkToken({ jti: i.token.jti, teamId: i.teamId, slackUserId: i.slackUserId, expiresAt: i.token.expiresAt }, tx)
      : true;
    const existing = await tx.one<SlackIdentityRow>(
      "SELECT * FROM slack_identities WHERE team_id = ? AND slack_user_id = ?",
      [i.teamId, i.slackUserId],
    );
    if (existing) {
      if (existing.account_id === i.accountId) return { result: { ok: true, created: false } as const, events: [] as DomainEvent[] };
      return {
        result: { ok: false, reason: "already-linked", existingAccountId: existing.account_id } as const,
        events: [] as DomainEvent[],
      };
    }
    if (!claimed) return { result: { ok: false, reason: "link-used" } as const, events: [] as DomainEvent[] };
    await tx.run(
      `INSERT INTO slack_identities (team_id, slack_user_id, account_id, linked_at, linked_via)
       VALUES (?, ?, ?, ?, ?)`,
      [i.teamId, i.slackUserId, i.accountId, Date.now(), i.via],
    );
    const acct = await tx.one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [i.accountId]);
    const events = acct
      ? await projectLink({ issuer: acct.issuer, subject: acct.subject, teamId: i.teamId, slackUserId: i.slackUserId }, tx)
      : [];
    return { result: { ok: true, created: true } as const, events };
  });
  await emitAfterCommit(out.events);
  invalidateActors();
  return out.result;
}

/** Remove a binding, but only when it belongs to the calling account. */
export async function unlinkSlackIdentity(teamId: string, slackUserId: string, accountId: string): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    const r = await tx.run(
      "DELETE FROM slack_identities WHERE team_id = ? AND slack_user_id = ? AND account_id = ?",
      [teamId, slackUserId, accountId],
    );
    if ((r.changes ?? 0) === 0) return false;
    const acct = await tx.one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [accountId]);
    if (acct) await projectUnlink({ issuer: acct.issuer, subject: acct.subject, teamId, slackUserId }, tx);
    return true;
  });
  invalidateActors();
  return done;
}

/**
 * Delete an account (its slack_identities, MCP credentials and OAuth flows
 * go with it by ON DELETE CASCADE) and clean up the bindings it projected.
 */
export async function deleteAccount(accountId: string): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    const acct = await tx.one<AccountRow>("SELECT * FROM accounts WHERE id = ?", [accountId]);
    if (!acct) return false;
    const ids = await tx.query<SlackIdentityRow>("SELECT * FROM slack_identities WHERE account_id = ?", [accountId]);
    await projectAccountDeletion(
      { issuer: acct.issuer, subject: acct.subject, email: acct.email, slack: ids.map((s) => ({ teamId: s.team_id, slackUserId: s.slack_user_id })) },
      tx,
    );
    const r = await tx.run("DELETE FROM accounts WHERE id = ?", [accountId]);
    return (r.changes ?? 0) > 0;
  });
  invalidateActors();
  return done;
}

export async function slackIdentitiesForAccount(accountId: string): Promise<SlackIdentityRow[]> {
  return db.query<SlackIdentityRow>("SELECT * FROM slack_identities WHERE account_id = ?", [accountId]);
}

export async function _wipeForTests(): Promise<void> {
  for (const a of await db.query<{ id: string }>("SELECT id FROM accounts")) await deleteAccount(a.id);
  await db.run("DELETE FROM slack_identities");
  await db.run("DELETE FROM accounts");
  await Domain._wipeForTests();
}

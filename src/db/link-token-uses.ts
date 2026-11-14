/**
 * Single-use ledger of onboarding link tokens (migration 0040).
 *
 * The slack_identities primary key alone does not make a link token single
 * use: unlinking deletes that row, so the same token would relink within its
 * lifetime. Redeeming a token inserts its `jti` here inside the link
 * transaction, insert-or-ignore: the writer that wins the insert owns the
 * redemption. Rows are purged once the token has expired, because from then
 * on the signature check refuses it anyway.
 */
import { db as globalDb, type DbClient } from "./schema";

export interface LinkTokenUse {
  jti: string;
  teamId: string;
  slackUserId: string;
  /** Epoch ms the token expires; the row is dead weight after this. */
  expiresAt: number;
}

/** Claim a token id. True when this call recorded the use, false when it was already used. */
export async function claimLinkToken(use: LinkTokenUse, tx: DbClient = globalDb, now: number = Date.now()): Promise<boolean> {
  const r = await tx.run(
    `INSERT INTO link_token_uses (jti, team_id, slack_user_id, used_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (jti) DO NOTHING`,
    [use.jti, use.teamId, use.slackUserId, now, use.expiresAt],
  );
  return (r.changes ?? 0) > 0;
}

/** Delete rows whose token has expired. Returns how many went. */
export async function purgeExpiredLinkTokens(c: DbClient = globalDb, now: number = Date.now()): Promise<number> {
  const r = await c.run("DELETE FROM link_token_uses WHERE expires_at <= ?", [now]);
  return r.changes ?? 0;
}

export async function countLinkTokenUses(c: DbClient = globalDb): Promise<number> {
  const r = await c.one<{ n: number | string }>("SELECT COUNT(*) AS n FROM link_token_uses");
  return Number(r?.n ?? 0);
}

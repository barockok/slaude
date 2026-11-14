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
 * Single use: the redeem route records the token's `jti` in the
 * link_token_uses ledger inside the link transaction (src/db/link-token-uses.ts),
 * so a replay after an unlink is refused for the rest of the token's life. The
 * slack_identities primary key alone could not do this, because unlinking
 * deletes that row. While a link stands, a replay is still a no-op (same
 * account) or a rejection (another account). See src/db/accounts.ts.
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

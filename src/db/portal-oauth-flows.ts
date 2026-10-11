/**
 * The portal's in-flight OAuth authorizations.
 *
 * One row holds everything the token exchange needs, encrypted, for at most a
 * few minutes. The browser is given only the row's opaque id in a signed
 * cookie, so the client secret dynamic registration issued never leaves the
 * gateway — the reason this table exists rather than the panel's cookie-only
 * approach to its own login flow.
 *
 * This is the only module that encrypts or decrypts these payloads. Nothing
 * here logs one, and a payload that fails to decrypt is reported as absent
 * rather than partially returned.
 */
import { randomUUID } from "node:crypto";
import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";

/** What `finishPortalConnect` needs to complete an exchange. */
export interface PortalFlow {
  clientId: string;
  /** Present only when dynamic registration issued one. */
  clientSecret?: string;
  verifier: string;
  /** Pinned at connect, so a hostile server cannot redirect the exchange later. */
  tokenEndpoint: string;
  serverName: string;
  /**
   * The server config as configured, not just its URL. oauthKey hashes type,
   * url AND headers, so a credential stored under a reconstructed config would
   * be filed under a key no session ever reads.
   */
  cfg: { type: string; url: string; headers?: Record<string, string> };
  state: string;
}

/** An authorization is abandoned long before this; ten minutes is generous. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

function isFlow(v: unknown): v is PortalFlow {
  const f = v as PortalFlow;
  return (
    !!f &&
    typeof f === "object" &&
    typeof f.clientId === "string" &&
    (f.clientSecret === undefined || typeof f.clientSecret === "string") &&
    typeof f.verifier === "string" &&
    typeof f.tokenEndpoint === "string" &&
    typeof f.serverName === "string" &&
    !!f.cfg &&
    typeof f.cfg === "object" &&
    typeof f.cfg.type === "string" &&
    typeof f.cfg.url === "string" &&
    typeof f.state === "string"
  );
}

/** Store one in-flight authorization. Returns the id the cookie will carry. */
export async function createFlow(accountId: string, flow: PortalFlow, ttlMs: number = FLOW_TTL_MS): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.run(
    `INSERT INTO portal_oauth_flows (id, account_id, payload, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, accountId, encrypt(JSON.stringify(flow)), now + ttlMs, now],
  );
  return id;
}

/**
 * Read and delete one flow, in a single statement.
 *
 * Single use is a security property, not an optimisation: it is what makes a
 * replayed callback find nothing. So the delete is the read — `DELETE …
 * RETURNING` on both dialects — and exactly one of several concurrent callers
 * can win it. The account is part of the WHERE rather than checked afterwards,
 * so another account's attempt neither reads the flow nor consumes it.
 *
 * Returns null when the flow is unknown, expired, owned by someone else, or
 * unreadable. An unreadable row is still consumed: it can never be used again.
 */
export async function takeFlow(id: string, accountId: string): Promise<PortalFlow | null> {
  const rows = await db.query<{ payload: string }>(
    `DELETE FROM portal_oauth_flows
     WHERE id = ? AND account_id = ? AND expires_at > ?
     RETURNING payload`,
    [id, accountId, Date.now()],
  );
  if (!rows.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(rows[0]!.payload));
  } catch {
    console.error(`[portal-oauth-flows] could not decrypt flow=${id}`);
    return null;
  }
  if (!isFlow(parsed)) {
    console.error(`[portal-oauth-flows] malformed flow=${id}`);
    return null;
  }
  return parsed;
}

/** Drop rows whose authorization was abandoned. Returns how many. */
export async function sweepExpiredFlows(now: number = Date.now()): Promise<number> {
  const r = await db.run("DELETE FROM portal_oauth_flows WHERE expires_at <= ?", [now]);
  return r.changes ?? 0;
}

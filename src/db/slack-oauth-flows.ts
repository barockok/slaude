/**
 * Parked paste-back `/mcp connect` flows.
 *
 * The pending flow used to live in a per-process Map, which works with one
 * gateway and not with two: the pasted callback arrives on whichever replica
 * took that Slack event, and a replica that did not start the flow knows nothing
 * about it. Phase 4 solved this for the portal; this is the Slack side.
 *
 * This is the only module that encrypts or decrypts these payloads. Nothing here
 * logs one, and a payload that fails to decrypt is reported absent rather than
 * partially returned.
 */
import { db } from "./schema";
import { encrypt, decrypt } from "./crypto";
import type { ExchangeParts } from "../agent/mcp-oauth/client";

export interface SlackOauthFlow {
  /** The OAuth `state` from the authorize step, checked against what is pasted. */
  state: string;
  /** What the exchange needs, as values — the closure cannot cross a replica. */
  parts: ExchangeParts;
  serverName: string;
  /** The server as configured: oauthKey hashes its headers too. */
  cfg: { type: string; url: string; headers?: Record<string, string> };
  sessionId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  scope: "initiator" | "global";
  personaName?: string;
  /** ts of the posted authorize-URL message, redacted in place on settle. */
  authMsgRef?: string;
}

/** Matches the window the authorize link is useful for. */
export const FLOW_TTL_MS = 10 * 60 * 1000;

function isFlow(v: unknown): v is SlackOauthFlow {
  const f = v as SlackOauthFlow;
  return (
    !!f &&
    typeof f === "object" &&
    typeof f.state === "string" &&
    !!f.parts &&
    typeof f.parts === "object" &&
    typeof f.parts.tokenEndpoint === "string" &&
    typeof f.parts.clientId === "string" &&
    typeof f.parts.verifier === "string" &&
    typeof f.serverName === "string" &&
    !!f.cfg &&
    typeof f.cfg.url === "string" &&
    typeof f.sessionId === "string" &&
    typeof f.userId === "string" &&
    (f.scope === "initiator" || f.scope === "global")
  );
}

function decode(key: string, payload: string): SlackOauthFlow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(payload));
  } catch {
    console.error(`[slack-oauth-flows] could not decrypt flow for ${key}`);
    return null;
  }
  if (!isFlow(parsed)) {
    console.error(`[slack-oauth-flows] malformed flow for ${key}`);
    return null;
  }
  return parsed;
}

/** Park a flow. Rerunning connect in the same thread replaces the previous one,
 *  matching what the Map did — the newest authorize link is the live one. */
export async function putFlow(key: string, flow: SlackOauthFlow, ttlMs: number = FLOW_TTL_MS): Promise<void> {
  const now = Date.now();
  await db.run(
    `INSERT INTO slack_oauth_flows (flow_key, payload, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (flow_key)
     DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    [key, encrypt(JSON.stringify(flow)), now + ttlMs, now],
  );
}

/**
 * Read a flow without consuming it.
 *
 * The `state` check has to be able to fail without costing the person their
 * flow: they are told to paste the URL from the same authorize step and try
 * again, and that promise is only true if a mismatch leaves the row alone.
 */
export async function peekFlow(key: string): Promise<SlackOauthFlow | null> {
  const row = await db.one<{ payload: string }>(
    "SELECT payload FROM slack_oauth_flows WHERE flow_key = ? AND expires_at > ?",
    [key, Date.now()],
  );
  return row ? decode(key, row.payload) : null;
}

/**
 * Read and delete a flow, in one statement.
 *
 * The exchange must happen once however many replicas see the paste, so the
 * delete is the read and exactly one caller can win it.
 */
export async function takeFlow(key: string): Promise<SlackOauthFlow | null> {
  const rows = await db.query<{ payload: string }>(
    `DELETE FROM slack_oauth_flows
     WHERE flow_key = ? AND expires_at > ?
     RETURNING payload`,
    [key, Date.now()],
  );
  return rows.length ? decode(key, rows[0]!.payload) : null;
}

/** Drop flows the initiator abandoned. Returns how many. */
export async function sweepExpiredFlows(now: number = Date.now()): Promise<number> {
  const r = await db.run("DELETE FROM slack_oauth_flows WHERE expires_at <= ?", [now]);
  return r.changes ?? 0;
}

/**
 * Slack request signature verification (Events API / interactivity ingress).
 *
 * Slack signs every HTTP request with
 *   X-Slack-Signature: v0=HEX(HMAC_SHA256(signing_secret, "v0:<timestamp>:<raw body>"))
 *   X-Slack-Request-Timestamp: unix seconds
 *
 * The HMAC is computed over the RAW request body exactly as received — any
 * re-serialization breaks the signature. Comparison is constant-time
 * (timingSafeEqual) and requests outside the replay window (default 5 min,
 * both directions) are rejected before the HMAC is computed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIG_VERSION = "v0";
/** Default replay window (seconds). Slack documents 5 minutes. */
export const MAX_SKEW_SEC = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed_timestamp" | "stale" | "bad_version" | "mismatch" };

export function signSlackRequest(signingSecret: string, timestamp: string, rawBody: string): string {
  const hex = createHmac("sha256", signingSecret)
    .update(`${SLACK_SIG_VERSION}:${timestamp}:${rawBody}`)
    .digest("hex");
  return `${SLACK_SIG_VERSION}=${hex}`;
}

export function verifySlackSignature(args: {
  signingSecret: string;
  /** RAW request body, byte-for-byte as received. */
  rawBody: string;
  /** X-Slack-Request-Timestamp header value. */
  timestamp: string | null;
  /** X-Slack-Signature header value. */
  signature: string | null;
  nowMs?: number;
  maxSkewSec?: number;
}): VerifyResult {
  if (!args.timestamp || !args.signature) return { ok: false, reason: "missing" };
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_timestamp" };
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > (args.maxSkewSec ?? MAX_SKEW_SEC)) {
    return { ok: false, reason: "stale" };
  }
  const [version, hash] = args.signature.split("=");
  if (version !== SLACK_SIG_VERSION || !hash) return { ok: false, reason: "bad_version" };
  const expected = signSlackRequest(args.signingSecret, args.timestamp, args.rawBody).slice(
    SLACK_SIG_VERSION.length + 1,
  );
  const a = Buffer.from(hash, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

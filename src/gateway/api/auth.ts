/**
 * /v1 auth (spec §3):
 *
 *   - `Authorization: Bearer <SLAUDE_NODE_TOKEN>` — static shared secret on
 *     EVERY /v1 request, compared timing-safe. Unset token = refuse all.
 *   - `X-Slaude-Job: <jwt>` — short-lived per-job token (HS256, secret
 *     SLAUDE_JOB_SECRET) minted by the gateway enqueue path; required on the
 *     tool plane and session endpoints. Claims: {tenant, persona, session,
 *     team, channel, thread, initiator, scope, exp}. The gateway derives the
 *     Slack client, persona, and KB scope from the token — never from the
 *     request body.
 *
 * The JWT is hand-rolled over node:crypto (HS256 only, ~40 lines) rather than
 * a jose/jsonwebtoken dependency: we are both minter and verifier, so no
 * algorithm negotiation surface exists — the header's `alg` is ignored and
 * HS256 is always enforced.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";

export interface JobClaims {
  tenant: string;
  persona: string;
  session: string;
  team: string;
  channel: string;
  thread: string;
  initiator: string;
  scope: string;
  /** BullMQ job id this token was minted for. Binds token-refresh to its
   *  job; optional for tokens minted outside the queue path (tests, tools). */
  job?: string;
  /** Unix seconds. */
  exp: number;
  iat?: number;
}

/** Default job-token TTL: the max turn duration (spec §2). */
export const JOB_TOKEN_TTL_SEC = 15 * 60;

export const JOB_HEADER = "x-slaude-job";

/** Constant-time string equality. Hashing first equalizes lengths so the
 *  comparison leaks neither content nor length. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

function sign(headerAndPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(headerAndPayload).digest("base64url");
}

/**
 * Mint a per-job token. Called by the gateway enqueue path (turn job payload
 * `jobToken`, spec §2) — P5/P6 wire it in; exported now so the contract is
 * fixed. Throws when SLAUDE_JOB_SECRET is unset (a gateway that cannot mint
 * must not enqueue).
 */
export function mintJobToken(
  claims: Omit<JobClaims, "exp" | "iat"> & { exp?: number },
  opts: { secret?: string; ttlSec?: number; now?: number } = {},
): string {
  const secret = opts.secret ?? env.jobSecret();
  if (!secret) throw new Error("SLAUDE_JOB_SECRET is not set — cannot mint job tokens");
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = claims.exp ?? nowSec + (opts.ttlSec ?? JOB_TOKEN_TTL_SEC);
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const payload = b64uJson({ ...claims, iat: nowSec, exp });
  return `${head}.${payload}.${sign(`${head}.${payload}`, secret)}`;
}

export type JobVerifyResult =
  | { ok: true; claims: JobClaims }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "bad_claims" | "unconfigured" };

/** Verify a job token. HS256 is enforced regardless of the header's `alg`.
 *  `graceSec` (token-refresh only) accepts a token expired by at most that
 *  many seconds — the signature and claim checks still apply in full. */
export function verifyJobToken(
  token: string | null | undefined,
  opts: { secret?: string; now?: number; graceSec?: number } = {},
): JobVerifyResult {
  const secret = opts.secret ?? env.jobSecret();
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, payload, sig] = parts as [string, string, string];
  if (!timingSafeStringEqual(sign(`${head}.${payload}`, secret), sig)) {
    return { ok: false, reason: "bad_signature" };
  }
  let claims: JobClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const grace = Math.max(0, opts.graceSec ?? 0);
  if (typeof claims.exp !== "number" || claims.exp + grace <= nowSec) return { ok: false, reason: "expired" };
  for (const k of ["tenant", "persona", "session", "team", "channel", "thread", "initiator", "scope"] as const) {
    if (typeof claims[k] !== "string") return { ok: false, reason: "bad_claims" };
  }
  return { ok: true, claims };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Enforce the static bearer on a /v1 request. Returns null when authorized,
 * otherwise the error Response to send. An unset SLAUDE_NODE_TOKEN refuses
 * everything (503 — operator misconfiguration, not a client error).
 */
export function requireBearer(req: Request): Response | null {
  const configured = env.nodeToken();
  if (!configured) return json(503, { error: "SLAUDE_NODE_TOKEN is not configured on this gateway" });
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !timingSafeStringEqual(m[1]!, configured)) {
    return json(401, { error: "invalid or missing bearer token" });
  }
  return null;
}

/**
 * Enforce the per-job JWT on tool-plane / session endpoints. Returns the
 * claims, or the error Response to send.
 */
export function requireJobToken(req: Request): { claims: JobClaims } | { response: Response } {
  const r = verifyJobToken(req.headers.get(JOB_HEADER));
  if (r.ok) return { claims: r.claims };
  if (r.reason === "unconfigured") {
    return { response: json(503, { error: "SLAUDE_JOB_SECRET is not configured on this gateway" }) };
  }
  return { response: json(401, { error: `invalid job token: ${r.reason}` }) };
}

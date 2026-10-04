/**
 * /v1 auth (spec §3):
 *
 *   - `Authorization: Bearer <node credential>` on EVERY /v1 request: a signed
 *     node credential (SLAUDE_NODE_KEY, node labels spec §4.1) or the legacy
 *     shared token, compared timing-safe. See authenticateNode.
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
import { m as metric } from "../../metrics";
import { LEGACY_NODE_ID, NodeCredentialVerifier, verifyNodeCredentialSync } from "../auth/node-credential";

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
  /** Whose identity the turn runs as: "agent" or "user:<slackUserId>". Decided
   *  once at dispatch (see credential-owner.ts). Distinct from `initiator`,
   *  which is merely whoever sent the message. Optional in the type so tokens
   *  from an older gateway still decode; the credential endpoint refuses its
   *  absence rather than defaulting. */
  runAs?: string;
  /** Remote execution target for this turn (spec §4.5). Present only when the
   *  thread's remote target belongs to the runAs user. Sensitive: the address. */
  remote?: { addr: string; dir: string };
  /** Hash of (lock owner, remote target). A node reboots a warm session when it changes. */
  sessionConfigFp?: string;
  /** Slack app (api_app_id) the turn's event belongs to. With `team` it names
   *  the registered app the /v1 tool plane posts as (D1.2). Optional: tokens
   *  from an older gateway, and turns with no inbound app, resolve it from the
   *  team when that is unambiguous. */
  app?: string;
  /** The thread's /1on1 lock at dispatch: null = unlocked; openScope null =
   *  locked, a string = open mode with that scope. A node has no database, so
   *  this is how its session-mode block learns the lock. Absent = a gateway
   *  that predates the claim. */
  lock?: { user: string; openScope: string | null } | null;
  /** The node label this turn runs on, signed at dispatch (node labels spec
   *  §4.3). The gate requires it among the calling node's labels. Absent (a
   *  token from before the change) means "default". */
  label?: string;
  /** First issue time (unix seconds), carried across token-refresh so the
   *  token's total life is capped. Absent = this token's own `iat`. */
  iat0?: number;
  /** Unix seconds. */
  exp: number;
  iat?: number;
}

/** The label a job token is bound to; a token minted before labels is "default". */
export function jobLabel(claims: Pick<JobClaims, "label">): string {
  return claims.label || "default";
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
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return { ok: false, reason: "malformed" };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const grace = Math.max(0, opts.graceSec ?? 0);
  if (typeof claims.exp !== "number" || claims.exp + grace <= nowSec) return { ok: false, reason: "expired" };
  for (const k of ["tenant", "persona", "session", "team", "channel", "thread", "initiator", "scope"] as const) {
    if (typeof claims[k] !== "string") return { ok: false, reason: "bad_claims" };
  }
  // A job token has no `typ`; a signed node credential does. Refusing any typ
  // keeps a node credential from passing as a job token even if an operator
  // gave both keys the same value.
  if ((claims as { typ?: unknown }).typ !== undefined) return { ok: false, reason: "bad_claims" };
  // An empty label would read as "default" through jobLabel; refuse it instead.
  if (claims.label !== undefined && (typeof claims.label !== "string" || claims.label === "")) {
    return { ok: false, reason: "bad_claims" };
  }
  return { ok: true, claims };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type NodeIdentity = { id: string; labels: ReadonlySet<string>; legacy: boolean };

export type NodeAuthResult =
  | { ok: true; node: NodeIdentity; expiresAt?: number }
  | { ok: false; response: Response };

const LEGACY_IDENTITY: NodeIdentity = Object.freeze({
  id: LEGACY_NODE_ID,
  labels: new Set(["default"]) as ReadonlySet<string>,
  legacy: true,
});

let defaultVerifier: NodeCredentialVerifier | null = null;
let warnedOldTokenName = false;
let warnedLegacyWithKey = false;
let warnedLegacyIsCredential = false;

/** Test seam: swap the verifier (revocation source, cache). */
export function __setNodeVerifier(v: NodeCredentialVerifier | null): void {
  defaultVerifier = v;
}
/** Test helper: let the one-time warnings fire again. */
export function __resetNodeAuthWarnings(): void {
  warnedOldTokenName = false;
  warnedLegacyWithKey = false;
  warnedLegacyIsCredential = false;
}

/** The legacy value this gateway accepts, or "" when the door is closed. */
function legacyToken(): string {
  if (env.nodeLegacyOff()) return "";
  const keyed = !!(env.nodeKey() || env.nodeKeyPrevious());
  const name = env.nodeLegacyToken().trim() ? "SLAUDE_NODE_LEGACY_TOKEN" : "SLAUDE_NODE_TOKEN";
  // The old gateway reading (SLAUDE_NODE_TOKEN as the value to accept) applies
  // only while no node key is set: once signed credentials exist, that
  // variable may well hold one, and accepting it here would skip expiry,
  // revocation and labels.
  // Trimmed: a whitespace-only value is unset, not a token nobody can send.
  const t = env.nodeLegacyToken().trim() || (keyed ? "" : env.nodeToken().trim());
  if (!t) return "";
  // A node credential is never a legacy value, whatever variable holds it.
  if (looksLikeNodeCredential(t)) {
    if (!warnedLegacyIsCredential) {
      warnedLegacyIsCredential = true;
      console.error(
        `[node-auth] ${name} looks like a node credential (it verifies as one, or its payload carries ` +
          "typ, exp or labels), not a legacy shared token; ignoring it as a legacy value. " +
          "Give the gateway SLAUDE_NODE_LEGACY_TOKEN (a random string) or leave the legacy door closed.",
      );
    }
    return "";
  }
  return t;
}

/**
 * A value is treated as a node credential when it verifies as one under the
 * configured keys, or when its middle dot-separated part decodes to a JSON
 * object carrying `typ`, `exp` or `labels` (a credential minted under a key
 * this gateway does not hold). Any other value, dots included, is an ordinary
 * operator-chosen legacy token.
 */
function looksLikeNodeCredential(t: string): boolean {
  if (verifyNodeCredentialSync(t).ok) return true;
  const parts = t.split(".");
  if (parts.length !== 3) return false;
  try {
    const body = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof body === "object" && body !== null && ("typ" in body || "exp" in body || "labels" in body);
  } catch {
    return false;
  }
}

/**
 * Authenticate a /v1 request (node labels spec §4.2). Runs on EVERY request;
 * there is no session, so a revoked credential stops at the next call.
 *
 *   - a bearer equal to the legacy token → { id: "legacy", labels: {default} }
 *     (SLAUDE_NODE_LEGACY=off closes this door)
 *   - a bearer that verifies as a signed node credential → its claims
 *   - anything else → 401; neither a key nor a legacy token configured → 503
 */
export async function authenticateNode(req: Request): Promise<NodeAuthResult> {
  const legacy = legacyToken();
  const keyed = !!(env.nodeKey() || env.nodeKeyPrevious());
  if (!legacy && !keyed) {
    return {
      ok: false,
      response: json(503, { error: "no node credential is configured on this gateway (SLAUDE_NODE_KEY or SLAUDE_NODE_LEGACY_TOKEN)" }),
    };
  }
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!bearer) return { ok: false, response: json(401, { error: "invalid or missing bearer token", code: NODE_UNAUTHORIZED_CODE }) };

  if (legacy && timingSafeStringEqual(bearer, legacy)) {
    if (!env.nodeLegacyToken().trim() && !warnedOldTokenName) {
      warnedOldTokenName = true;
      console.warn(
        "[node-auth] the gateway reads SLAUDE_NODE_TOKEN as the legacy node token; this is deprecated, set SLAUDE_NODE_LEGACY_TOKEN instead",
      );
    }
    if (keyed) {
      metric.nodeLegacyAuthTotal.inc();
      if (!warnedLegacyWithKey) {
        warnedLegacyWithKey = true;
        console.warn(
          "[node-auth] a node authenticated with the legacy shared token while SLAUDE_NODE_KEY is set; give it a signed credential, then set SLAUDE_NODE_LEGACY=off",
        );
      }
    }
    return { ok: true, node: LEGACY_IDENTITY };
  }

  if (keyed) {
    let r;
    try {
      r = await (defaultVerifier ??= new NodeCredentialVerifier()).verify(bearer);
    } catch (e) {
      // Revocation could not be checked: fail closed.
      console.error("[node-auth] node credential revocation lookup failed:", e instanceof Error ? e.message : e);
      return { ok: false, response: json(503, { error: "node credential revocation store unavailable" }) };
    }
    if (r.ok) {
      return {
        ok: true,
        node: { id: r.claims.id, labels: new Set(r.claims.labels), legacy: false },
        expiresAt: r.claims.exp,
      };
    }
  }
  return { ok: false, response: json(401, { error: "invalid or missing bearer token", code: NODE_UNAUTHORIZED_CODE }) };
}

/** A 401 for the node's own credential (not a job token): the node pauses its
 *  workers until whoami succeeds again (node labels spec §4.6). */
export const NODE_UNAUTHORIZED_CODE = "NODE_UNAUTHORIZED";

/** A token refresh refused because the persona's live label is not the one
 *  signed into the token (409, node labels spec §4.3, §4.8): the node ends the
 *  turn with LABEL_MISMATCH and the gateway re-dispatches it once. */
export const LABEL_MISMATCH_CODE = "LABEL_MISMATCH";

/** The gate's refusal (node labels spec §4.3). Generic on purpose; `code` lets
 *  the node client type it without parsing prose. */
export const GATE_DENIED_CODE = "GATE_DENIED";
export const GATE_DENIED_MESSAGE = "this node may not serve this agent";

/** Require the job's label among the node's labels. Null = allowed. */
export function gateLabel(node: NodeIdentity, claims: JobClaims, route: string): Response | null {
  const label = jobLabel(claims);
  if (node.labels.has(label)) return null;
  console.error(
    `[v1] gate denied: node=${node.id} tenant=${claims.tenant} persona=${claims.persona} label=${label} route=${route}`,
  );
  return json(403, { error: GATE_DENIED_MESSAGE, code: GATE_DENIED_CODE });
}

/**
 * Enforce the per-job JWT on tool-plane / session endpoints. Returns the
 * claims, or the error Response to send.
 */
export function requireJobToken(
  req: Request,
  opts: { graceSec?: number } = {},
): { claims: JobClaims } | { response: Response } {
  const r = verifyJobToken(req.headers.get(JOB_HEADER), opts);
  if (r.ok) return { claims: r.claims };
  if (r.reason === "unconfigured") {
    return { response: json(503, { error: "SLAUDE_JOB_SECRET is not configured on this gateway" }) };
  }
  return { response: json(401, { error: `invalid job token: ${r.reason}` }) };
}

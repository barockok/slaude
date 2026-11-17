/**
 * The upload handle: a signed, short-lived value that carries one direct
 * upload from `upload_begin` to `upload_complete`.
 *
 * It is signed with the job secret (the same HS256 machinery as a job token,
 * src/gateway/api/auth.ts) but its payload carries `typ: "upload"`. The job
 * verifier refuses any token with a `typ`, so a handle can never pass as a job
 * token; this verifier requires `typ === "upload"`, so a job token (which has
 * none) can never pass as a handle.
 *
 * The destination of the file (channel, thread, whether the post goes to the
 * channel root) is signed in at begin from the job claims. At complete it is
 * read back from here, never from the node's request body.
 *
 * Its own expiry is ten minutes. It is deliberately not capped by the job
 * token's expiry: a begin shortly before the token expires still completes
 * with the refreshed token the node holds by then.
 *
 * It carries only what complete reads (destination, file id, name, declared
 * size). Alt text goes to Slack at begin, and label and run-as identity are
 * the caller's own job claims, so none of them is in the handle: a long alt
 * text must not push the handle over the complete schema's size cap.
 *
 * Treat it as a credential for one file: never log it or echo it.
 */
import { env } from "../../config/env";
import { sign, timingSafeStringEqual, type JobClaims } from "../api/auth";

export const UPLOAD_HANDLE_TYP = "upload";
export const UPLOAD_HANDLE_TTL_SEC = 10 * 60;

export interface UploadHandleClaims {
  typ: typeof UPLOAD_HANDLE_TYP;
  tenant: string;
  persona: string;
  session: string;
  team: string;
  channel: string;
  thread: string;
  /** Signed from the begin turn's job claims: "channel" = post at the channel root. */
  post?: "channel";
  app?: string;
  fileId: string;
  filename: string;
  /** Declared size in bytes. */
  size: number;
  iat: number;
  exp: number;
}

export type UploadHandleFields = Omit<UploadHandleClaims, "typ" | "iat" | "exp">;

const b64uJson = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

export function mintUploadHandle(
  fields: UploadHandleFields,
  opts: { secret?: string; now?: number; ttlSec?: number } = {},
): string {
  const secret = opts.secret ?? env.jobSecret();
  if (!secret) throw new Error("SLAUDE_JOB_SECRET is not set: cannot mint an upload handle");
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: UploadHandleClaims = { ...fields, typ: UPLOAD_HANDLE_TYP, iat, exp: iat + (opts.ttlSec ?? UPLOAD_HANDLE_TTL_SEC) };
  const head = b64uJson({ alg: "HS256", typ: "JWT" });
  const payload = b64uJson(claims);
  return `${head}.${payload}.${sign(`${head}.${payload}`, secret)}`;
}

export type UploadHandleResult =
  | { ok: true; claims: UploadHandleClaims }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" | "bad_claims" | "wrong_session" | "unconfigured" };

const STRINGS = ["tenant", "persona", "session", "team", "channel", "thread", "fileId", "filename"] as const;

/**
 * Verify a handle for the caller whose job claims are `caller`. The handle's
 * tenant, persona and session must equal the caller's: a handle minted for one
 * session is useless to any other.
 */
export function verifyUploadHandle(
  handle: string | null | undefined,
  caller: Pick<JobClaims, "tenant" | "persona" | "session">,
  opts: { secret?: string; now?: number } = {},
): UploadHandleResult {
  const secret = opts.secret ?? env.jobSecret();
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!handle) return { ok: false, reason: "missing" };
  const parts = handle.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, payload, sig] = parts as [string, string, string];
  if (!timingSafeStringEqual(sign(`${head}.${payload}`, secret), sig)) return { ok: false, reason: "bad_signature" };
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) return { ok: false, reason: "malformed" };
  if (c.typ !== UPLOAD_HANDLE_TYP) return { ok: false, reason: "bad_claims" };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof c.exp !== "number" || c.exp <= nowSec) return { ok: false, reason: "expired" };
  for (const k of STRINGS) if (typeof c[k] !== "string") return { ok: false, reason: "bad_claims" };
  if (typeof c.size !== "number" || !Number.isSafeInteger(c.size) || c.size < 0) return { ok: false, reason: "bad_claims" };
  if (c.post !== undefined && c.post !== "channel") return { ok: false, reason: "bad_claims" };
  for (const k of ["app"] as const) {
    if (c[k] !== undefined && typeof c[k] !== "string") return { ok: false, reason: "bad_claims" };
  }
  const claims = c as unknown as UploadHandleClaims;
  if (claims.tenant !== caller.tenant || claims.persona !== caller.persona || claims.session !== caller.session) {
    return { ok: false, reason: "wrong_session" };
  }
  return { ok: true, claims };
}

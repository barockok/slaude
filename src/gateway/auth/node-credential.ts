/**
 * Signed node credentials (node labels and routing spec §4.1).
 *
 * A node proves which labels it carries with an HS256 token signed by the
 * gateway's own SLAUDE_NODE_KEY, never the job secret: whoever can mint a job
 * token could otherwise forge a node. HMAC means whoever can verify can mint,
 * so the key lives only in the gateway Secret.
 *
 *   { v: 1, typ: "node", id, labels: [1..8], iat, exp }
 *
 * `typ` keeps the two token kinds apart even if an operator gives both keys the
 * same value: a node credential never verifies as a job token (verifyJobToken
 * refuses any `typ`) and a job token never verifies here (it has no `typ`).
 *
 * Revocation by id: a `node_revocations` row (Postgres only) rejects every
 * credential with that id issued before `revoked_before`. Lookups are cached
 * for 30 s. On sqlite the table does not exist and revocation is skipped, with
 * one warning.
 */
import { decodeJwt, encodeJwt } from "./jwt";
import { env } from "../../config/env";
import { m as metric } from "../../metrics";

export const NODE_CREDENTIAL_VERSION = 1;
export const NODE_CREDENTIAL_TYP = "node";
export const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_LABELS = 8;
/** The id the legacy identity carries; a signed credential may not use it. */
export const LEGACY_NODE_ID = "legacy";
/** The CLI's default lifetime. */
export const DEFAULT_NODE_TTL_SEC = 90 * 86400;
/** The longest lifetime a credential may have (mint and verify): 400 days. */
export const MAX_NODE_TTL_SEC = 400 * 86400;
/** Clock skew tolerated on `iat` (seconds). */
export const MAX_IAT_SKEW_SEC = 300;
/** Job-token claims; a token carrying any of them is not a node credential. */
const JOB_CLAIM_FIELDS = ["tenant", "persona", "session", "scope", "job", "runAs"] as const;
/** Shortest acceptable node key (characters). */
export const MIN_NODE_KEY_LENGTH = 32;

/**
 * Gateway boot check on the node keys: each must be at least 32 characters and
 * must differ from SLAUDE_JOB_SECRET (whoever can mint a job token must not be
 * able to forge a node). Messages name variables, never values.
 */
export function nodeKeyViolations(e: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const job = e.SLAUDE_JOB_SECRET ?? "";
  for (const name of ["SLAUDE_NODE_KEY", "SLAUDE_NODE_KEY_PREVIOUS"] as const) {
    const v = e[name] ?? "";
    if (!v) continue;
    if (v.length < MIN_NODE_KEY_LENGTH) out.push(`${name} is shorter than ${MIN_NODE_KEY_LENGTH} characters`);
    if (job && v === job) out.push(`${name} equals SLAUDE_JOB_SECRET; node credentials need their own key`);
  }
  return out;
}

export interface NodeCredentialClaims {
  v: 1;
  typ: "node";
  id: string;
  labels: string[];
  iat: number;
  exp: number;
}

/** Why a set of labels is not acceptable, or null when it is. */
export function labelsError(labels: unknown): string | null {
  if (!Array.isArray(labels) || labels.length === 0) return "labels must be a non-empty list";
  if (labels.length > MAX_LABELS) return `at most ${MAX_LABELS} labels`;
  for (const l of labels) {
    if (typeof l !== "string" || !LABEL_RE.test(l)) return `malformed label '${String(l)}' (want ${LABEL_RE.source})`;
  }
  if (new Set(labels).size !== labels.length) return "duplicate label";
  return null;
}

/** Why an id is not acceptable, or null when it is. */
export function nodeIdError(id: unknown): string | null {
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) return `malformed id (want ${NODE_ID_RE.source})`;
  if (id === LEGACY_NODE_ID) return `'${LEGACY_NODE_ID}' is reserved for the legacy token`;
  return null;
}

export function mintNodeCredential(
  input: { id: string; labels: string[]; ttlSec?: number },
  opts: { key?: string; now?: number } = {},
): string {
  const key = opts.key ?? env.nodeKey();
  if (!key) throw new Error("SLAUDE_NODE_KEY is not set — cannot mint node credentials");
  const idErr = nodeIdError(input.id);
  if (idErr) throw new Error(idErr);
  const labErr = labelsError(input.labels);
  if (labErr) throw new Error(labErr);
  const ttl = input.ttlSec ?? DEFAULT_NODE_TTL_SEC;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("ttl must be a positive number of seconds");
  if (ttl > MAX_NODE_TTL_SEC) throw new Error(`lifetime is capped at ${MAX_NODE_TTL_SEC / 86400} days`);
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: NodeCredentialClaims = {
    v: NODE_CREDENTIAL_VERSION,
    typ: NODE_CREDENTIAL_TYP,
    id: input.id,
    labels: [...input.labels],
    iat,
    exp: iat + ttl,
  };
  return encodeJwt(claims, key);
}

export type NodeVerifyReason =
  | "missing" | "malformed" | "bad_signature" | "expired" | "bad_claims" | "unconfigured" | "revoked";

export type NodeVerifyResult = { ok: true; claims: NodeCredentialClaims } | { ok: false; reason: NodeVerifyReason };

/** Signature, expiry and claim shape only (no revocation). Tries the current
 *  key, then the previous one. */
export function verifyNodeCredentialSync(
  token: string | null | undefined,
  opts: { keys?: string[]; now?: number } = {},
): NodeVerifyResult {
  const keys = (opts.keys ?? [env.nodeKey(), env.nodeKeyPrevious()]).filter((k): k is string => !!k);
  if (keys.length === 0) return { ok: false, reason: "unconfigured" };
  const now = opts.now ?? Date.now();
  for (const key of keys) {
    const r = decodeJwt<Record<string, unknown>>(token, key, now);
    if (!r.ok) {
      if (r.reason === "bad_signature") continue;
      // missing / malformed / expired do not depend on the key.
      return { ok: false, reason: r.reason === "wrong_type" ? "bad_claims" : r.reason };
    }
    const c = r.payload;
    const nowSec = now / 1000;
    if (
      c.v !== NODE_CREDENTIAL_VERSION ||
      c.typ !== NODE_CREDENTIAL_TYP ||
      nodeIdError(c.id) !== null ||
      labelsError(c.labels) !== null ||
      typeof c.iat !== "number" ||
      typeof c.exp !== "number" ||
      // Issued in the future (beyond clock skew), or longer-lived than any mint.
      c.iat > nowSec + MAX_IAT_SKEW_SEC ||
      c.exp - c.iat > MAX_NODE_TTL_SEC ||
      // A token carrying job claims is never a node credential.
      JOB_CLAIM_FIELDS.some((k) => k in c)
    ) {
      return { ok: false, reason: "bad_claims" };
    }
    return { ok: true, claims: c as unknown as NodeCredentialClaims };
  }
  return { ok: false, reason: "bad_signature" };
}

// --- revocation ------------------------------------------------------------

/** Returns the revoked_before instant (unix seconds) for an id, or null. Throws
 *  when the store cannot be read. `undefined` from the source means "no
 *  revocation store on this deployment". */
export type RevocationSource = (id: string) => Promise<number | null | undefined>;

export const REVOCATION_CACHE_MS = 30_000;
/** During a revocation-store outage, a cached answer is served for at most
 *  this long after it expires; then requests fail with 503. */
export const MAX_STALE_REVOCATION_MS = 5 * 60_000;

let warnedNoRevocation = false;

/** The default source: the Postgres `node_revocations` table; undefined on
 *  sqlite (no table). */
export const dbRevocationSource: RevocationSource = async (id) => {
  const { dbDialect, getDb } = await import("../../db/client");
  if (dbDialect() !== "pg") return undefined;
  return revocationSourceFor(await getDb())(id);
};

/** A revocation source over an explicit Postgres client. */
export function revocationSourceFor(dbc: {
  one<T>(sql: string, params?: unknown[]): Promise<T | null>;
}): (id: string) => Promise<number | null> {
  return async (id) => {
    const row = await dbc.one<{ before: number | string }>(
      "SELECT extract(epoch FROM revoked_before) AS before FROM node_revocations WHERE id = ?",
      [id],
    );
    return row ? Number(row.before) : null;
  };
}

export class NodeCredentialVerifier {
  #source: RevocationSource;
  #cacheMs: number;
  #cache = new Map<string, { at: number; before: number | null | undefined }>();

  constructor(opts: { revocations?: RevocationSource; cacheMs?: number } = {}) {
    this.#source = opts.revocations ?? dbRevocationSource;
    this.#cacheMs = opts.cacheMs ?? REVOCATION_CACHE_MS;
  }

  async #revokedBefore(id: string, now: number): Promise<number | null | undefined> {
    const hit = this.#cache.get(id);
    if (hit && now - hit.at < this.#cacheMs) return hit.before;
    try {
      const before = await this.#source(id);
      if (this.#cache.size > 1024) this.#cache.clear();
      this.#cache.set(id, { at: now, before });
      return before;
    } catch (e) {
      // A stale answer beats none, for a bounded time past the cache's expiry;
      // beyond that, or with no answer at all, fail closed.
      if (hit && now - hit.at < this.#cacheMs + MAX_STALE_REVOCATION_MS) return hit.before;
      throw e;
    }
  }

  async verify(token: string | null | undefined, opts: { keys?: string[]; now?: number } = {}): Promise<NodeVerifyResult> {
    const now = opts.now ?? Date.now();
    const r = verifyNodeCredentialSync(token, { ...opts, now });
    if (!r.ok) return r;
    const before = await this.#revokedBefore(r.claims.id, now);
    if (before === undefined) {
      if (!warnedNoRevocation) {
        warnedNoRevocation = true;
        console.warn("[node-auth] node credential revocation needs Postgres; this deployment cannot revoke a credential by id");
      }
    } else if (before !== null && r.claims.iat < before) {
      return { ok: false, reason: "revoked" };
    }
    noteCredentialSeen(r.claims, now);
    return r;
  }

  clearCache(): void {
    this.#cache.clear();
  }
}

/** Write (or move forward) the revocation row for an id: every credential with
 *  that id issued before now is rejected. */
export async function revokeNodeCredential(
  id: string,
  dbc: { run(sql: string, params?: unknown[]): Promise<unknown> },
): Promise<void> {
  await dbc.run(
    "INSERT INTO node_revocations (id, revoked_before) VALUES (?, now()) " +
      "ON CONFLICT (id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before",
    [id],
  );
}

// --- lifecycle gauge -------------------------------------------------------

/** Bound on the expiry gauge's series: ids beyond this are not exported. */
export const MAX_GAUGED_CREDENTIALS = 64;
const gauged = new Set<string>();

function noteCredentialSeen(c: NodeCredentialClaims, nowMs: number): void {
  if (!gauged.has(c.id)) {
    if (gauged.size >= MAX_GAUGED_CREDENTIALS) return;
    gauged.add(c.id);
  }
  metric.nodeCredentialExpirySeconds.set(Math.max(0, c.exp - Math.floor(nowMs / 1000)), { id: c.id });
}

/** Test helper. */
export function __resetNodeCredentialState(): void {
  warnedNoRevocation = false;
  gauged.clear();
}

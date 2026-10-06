/**
 * POST /v1/jobs/:id/ack | /v1/jobs/:id/fail — node job telemetry (spec §3).
 * Accept + log + metric only; BullMQ owns job state. The caller is an
 * authenticated node (the router checks); the logged body is truncated and
 * stripped of control characters so a node cannot forge or flood log lines.
 *
 * POST /v1/jobs/:id/token-refresh — the job token is minted at ENQUEUE time
 * but its deadline (max turn duration) only matters from CLAIM time, so a job
 * that waited in the queue can start its turn with a mostly-spent token. The
 * node exchanges the original token for a fresh one with identical claims and
 * a full TTL. Guardrails: node identity + the label gate (router) + the
 * original token's signature; expiry is forgiven only within REFRESH_GRACE_SEC;
 * the token's `job` claim must equal the path's job id; and the token's total
 * life, measured from its first issue (`iat0`), is capped by
 * SLAUDE_JOB_TOKEN_MAX_AGE (node labels spec §4.4), so a stolen token cannot be
 * kept alive forever.
 *
 * POST /v1/jobs/:id/token-reissue — a job that waited longer than the TTL plus
 * the grace cannot be refreshed and would be unrunnable. The node presents the
 * job's own token (signature checked, expiry ignored, label-gated by the
 * router); the gateway re-mints from the job's data only when the job is still
 * in the queue, its stored token is the one presented, and its total age is
 * under SLAUDE_JOB_MAX_AGE.
 *
 * A held copy: when a moved job is merged into another pending job, its
 * messages wait in a held copy under a NEW id that carries the original token
 * (whose `job` claim names the original id). Both routes accept that token for
 * the copy's id when the job-moved marker chain leads from the claim's id to
 * the path's id, and re-mint it naming the copy.
 */
import {
  JOB_HEADER,
  JOB_TOKEN_TTL_SEC,
  jobLabel,
  LABEL_MISMATCH_CODE,
  mintJobToken,
  timingSafeStringEqual,
  verifyJobToken,
  type JobClaims,
} from "./auth";
import { runsOnFor } from "../../persona/registry";
import { env } from "../../config/env";
import { m as metric } from "../../metrics";
import { json, readJson } from "./http";
import { TURNS_QUEUE } from "../../queue/keys";

/** How long past exp a token may still be exchanged. */
export const REFRESH_GRACE_SEC = 60 * 60;

/** The first issue time of a token: its `iat0`, else its own `iat`, else the
 *  issue time its `exp` implies. */
export function firstIssued(claims: JobClaims): number {
  if (typeof claims.iat0 === "number") return claims.iat0;
  if (typeof claims.iat === "number") return claims.iat;
  return claims.exp - JOB_TOKEN_TTL_SEC;
}

/** Copy a token's claims for re-minting: drop the time fields. */
function reclaims(c: JobClaims): Omit<JobClaims, "exp" | "iat"> {
  const { exp: _exp, iat: _iat, ...rest } = c;
  return rest;
}

/** A typed 409 when the persona no longer runs on the token's signed label
 *  (node labels spec §4.3, §4.8), else null. Refresh and reissue both re-mint
 *  the token's own label claim, so both refuse it. */
function labelMismatch(claims: JobClaims, what: "refresh" | "reissue"): Response | null {
  const live = runsOnFor(claims.persona);
  if (live === jobLabel(claims)) return null;
  console.warn(`[v1-jobs] token ${what} refused: persona=${claims.persona} label=${jobLabel(claims)} now runs on ${live}`);
  return json(409, { error: "the agent's node label changed", code: LABEL_MISMATCH_CODE });
}

/** Where job `id` was moved to (the job-moved marker), or null. */
export type JobMovedTo = (id: string) => Promise<{ queue: string; jobId: string } | null>;

/** Marker hops followed from a claim's id; a copy can itself be moved again. */
const MAX_MOVE_HOPS = 8;

/**
 * True when the token's `job` claim is `jobId`, or the job-moved marker chain
 * leads from it to `jobId` AND that job carries the presented token itself (a
 * held copy of a moved job). A marker also points a job MERGED into another
 * pending job at that job; the merged job's token is not the target's stored
 * token, so it never refreshes or reissues as the target.
 */
async function tokenIsForJob(
  claims: JobClaims,
  jobId: string,
  presented: string,
  movedTo: JobMovedTo | undefined,
  lookup: JobLookup | undefined,
): Promise<boolean> {
  if (claims.job === jobId) return true;
  if (!movedTo || !lookup || typeof claims.job !== "string") return false;
  let id: string | null = claims.job;
  for (let hop = 0; hop < MAX_MOVE_HOPS && id; hop++) {
    const ref: { queue: string; jobId: string } | null = await movedTo(id).catch(() => null);
    id = ref?.jobId ?? null;
    if (ref && id === jobId) {
      if (!isTurnQueueName(ref.queue)) return false;
      const job = await lookup(ref.queue, jobId).catch(() => null);
      const stored = job?.data.jobToken;
      return typeof stored === "string" && timingSafeStringEqual(stored, presented);
    }
  }
  return false;
}

/** Verifies the original token itself (the router also does, for the gate). */
export async function handleTokenRefresh(
  req: Request,
  jobId: string,
  nowMs: number = Date.now(),
  movedTo?: JobMovedTo,
  lookup?: JobLookup,
): Promise<Response> {
  const r = verifyJobToken(req.headers.get(JOB_HEADER), { graceSec: REFRESH_GRACE_SEC, now: nowMs });
  if (!r.ok) {
    if (r.reason === "unconfigured") {
      return json(503, { error: "SLAUDE_JOB_SECRET is not configured on this gateway" });
    }
    return json(401, { error: `token refresh refused: ${r.reason}` });
  }
  const claims = r.claims;
  if (!(await tokenIsForJob(claims, jobId, req.headers.get(JOB_HEADER) ?? "", movedTo, lookup))) {
    return json(403, { error: "token was not minted for this job" });
  }
  // The live label is re-checked here (node labels spec §4.3, §4.8): after a
  // relabel the token's signed label is no longer where the persona runs. The
  // node ends the turn with LABEL_MISMATCH and the gateway re-dispatches it
  // once to the persona's current label.
  const mismatch = labelMismatch(claims, "refresh");
  if (mismatch) return mismatch;
  const iat0 = firstIssued(claims);
  const nowSec = Math.floor(nowMs / 1000);
  const lifeEnd = iat0 + env.jobTokenMaxAgeSec();
  if (nowSec >= lifeEnd) {
    return json(401, { error: "token refresh refused: the job token is past its maximum age" });
  }
  metric.v1JobEventsTotal.inc({ event: "token_refresh" });
  // The fresh token never outlives the cap either.
  const exp = Math.min(nowSec + JOB_TOKEN_TTL_SEC, lifeEnd);
  return json(200, { jobToken: mintJobToken({ ...reclaims(claims), job: jobId, iat0, exp }, { now: nowMs }) });
}

/** What token-reissue needs from the queue. */
export interface QueuedJob {
  /** The job's payload as stored. */
  data: { jobToken?: unknown; enqueuedAt?: unknown };
  /** BullMQ creation time (ms). */
  timestamp: number;
  /** BullMQ state; completed/failed jobs are not reissued. */
  state: string;
}
export type JobLookup = (queue: string, jobId: string) => Promise<QueuedJob | null>;

/** Only turn queues: `turns` and `turns.<suffix>`, where the suffix is
 *  dot-separated parts of letters, digits and `-` (a node id built from a
 *  hostname, or `label.<label>`). No `:` (BullMQ's key separator) and no
 *  control characters. */
const TURN_QUEUE_SUFFIX_RE = /^(\.[A-Za-z0-9-]+)+$/;
export function isTurnQueueName(q: string): boolean {
  if (q.length > 200) return false;
  if (q === TURNS_QUEUE) return true;
  return q.startsWith(TURNS_QUEUE) && TURN_QUEUE_SUFFIX_RE.test(q.slice(TURNS_QUEUE.length));
}

export async function handleTokenReissue(
  req: Request,
  jobId: string,
  claims: JobClaims,
  lookup: JobLookup | undefined,
  nowMs: number = Date.now(),
  movedTo?: JobMovedTo,
): Promise<Response> {
  if (!(await tokenIsForJob(claims, jobId, req.headers.get(JOB_HEADER) ?? "", movedTo, lookup))) return json(403, { error: "token was not minted for this job" });
  // As at refresh: never re-mint a label the persona no longer runs on.
  const mismatch = labelMismatch(claims, "reissue");
  if (mismatch) return mismatch;
  const body = await readJson(req);
  if (body === null) return json(400, { error: "malformed JSON body" });
  const queue = (body as { queue?: unknown }).queue ?? TURNS_QUEUE;
  if (typeof queue !== "string" || !isTurnQueueName(queue)) return json(400, { error: "queue must be a turn queue" });
  if (!lookup) return json(404, { error: "unknown job" });
  const job = await lookup(queue, jobId);
  if (!job || job.state === "completed" || job.state === "failed") return json(404, { error: "unknown job" });
  const stored = job.data.jobToken;
  const presented = req.headers.get(JOB_HEADER) ?? "";
  if (typeof stored !== "string" || !timingSafeStringEqual(stored, presented)) {
    return json(403, { error: "token is not this job's token" });
  }
  const nowSec = Math.floor(nowMs / 1000);
  // Reissue is only for a token that refresh can no longer exchange.
  if (claims.exp + REFRESH_GRACE_SEC > nowSec) {
    return json(409, { error: "token is still refreshable: use token-refresh" });
  }
  // The job's age runs from its ORIGINAL enqueue, never from a reissue.
  // The earliest finite birth time on record; with none, the age is unknown
  // and the job is treated as too old rather than minted a NaN expiry.
  const births = [job.data.enqueuedAt, job.timestamp].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  if (births.length === 0) return json(410, { error: "job is past its maximum age" });
  const bornMs = Math.min(...births);
  const capSec = Math.floor((bornMs + env.jobMaxAgeSec() * 1000) / 1000);
  if (nowSec >= capSec) {
    return json(410, { error: "job is past its maximum age" });
  }
  // The run starts now, so the token-life clock restarts, but it may never
  // reach past the job's own cap: iat0 + SLAUDE_JOB_TOKEN_MAX_AGE <= cap, and
  // refresh caps every later token's exp at that sum.
  const iat0 = Math.min(nowSec, capSec - env.jobTokenMaxAgeSec());
  const exp = Math.min(nowSec + JOB_TOKEN_TTL_SEC, capSec);
  metric.v1JobEventsTotal.inc({ event: "token_reissue" });
  return json(200, { jobToken: mintJobToken({ ...reclaims(claims), job: jobId, iat0, exp }, { now: nowMs }) });
}

/** Longest logged body; the rest is dropped. */
export const JOB_EVENT_LOG_MAX = 512;

const LOG_UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/** One log-safe line: control characters (newlines included) removed, capped. */
export function logSafe(s: string, max: number = JOB_EVENT_LOG_MAX): string {
  const clean = s.replace(LOG_UNSAFE, "");
  return clean.length > max ? `${clean.slice(0, max)}…(truncated)` : clean;
}

export async function handleJobEvent(req: Request, jobId: string, event: "ack" | "fail", nodeId?: string): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return json(400, { error: "malformed JSON body" });
  const detail = body && typeof body === "object" && Object.keys(body as object).length
    ? ` ${logSafe(JSON.stringify(body))}`
    : "";
  const who = nodeId ? ` node=${logSafe(nodeId, 64)}` : "";
  const job = logSafe(jobId, 128);
  if (event === "fail") console.warn(`[v1-jobs] fail job=${job}${who}${detail}`);
  else console.log(`[v1-jobs] ack job=${job}${who}${detail}`);
  metric.v1JobEventsTotal.inc({ event });
  return json(200, { ok: true });
}

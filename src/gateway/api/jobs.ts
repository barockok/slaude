/**
 * POST /v1/jobs/:id/ack | /v1/jobs/:id/fail — node job telemetry (spec §3).
 * Accept + log + metric only; BullMQ owns job state.
 *
 * POST /v1/jobs/:id/token-refresh — the job token is minted at ENQUEUE time
 * but its deadline (max turn duration) only matters from CLAIM time, so a job
 * that waited in the queue can start its turn with a mostly-spent token. The
 * node exchanges the original token for a fresh one with identical claims and
 * a full TTL. Guardrails: static bearer + the original token's signature must
 * verify; expiry is forgiven only within REFRESH_GRACE_SEC (≤1h — a stale
 * token cannot be laundered forever); the token's `job` claim must equal the
 * path's job id (a token can only refresh ITS OWN job).
 */
import { JOB_HEADER, mintJobToken, verifyJobToken, type JobClaims } from "./auth";
import { m as metric } from "../../metrics";
import { json, readJson } from "./http";

/** How long past exp a token may still be exchanged. */
export const REFRESH_GRACE_SEC = 60 * 60;

export async function handleTokenRefresh(req: Request, jobId: string): Promise<Response> {
  const r = verifyJobToken(req.headers.get(JOB_HEADER), { graceSec: REFRESH_GRACE_SEC });
  if (!r.ok) {
    if (r.reason === "unconfigured") {
      return json(503, { error: "SLAUDE_JOB_SECRET is not configured on this gateway" });
    }
    return json(401, { error: `token refresh refused: ${r.reason}` });
  }
  if (r.claims.job !== jobId) {
    return json(403, { error: "token was not minted for this job" });
  }
  const { exp: _exp, iat: _iat, ...claims } = r.claims as JobClaims;
  metric.v1JobEventsTotal.inc({ event: "token_refresh" });
  return json(200, { jobToken: mintJobToken(claims) });
}

export async function handleJobEvent(req: Request, jobId: string, event: "ack" | "fail"): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return json(400, { error: "malformed JSON body" });
  const detail = body && typeof body === "object" && Object.keys(body as object).length
    ? ` ${JSON.stringify(body)}`
    : "";
  if (event === "fail") console.warn(`[v1-jobs] fail job=${jobId}${detail}`);
  else console.log(`[v1-jobs] ack job=${jobId}${detail}`);
  metric.v1JobEventsTotal.inc({ event });
  return json(200, { ok: true });
}

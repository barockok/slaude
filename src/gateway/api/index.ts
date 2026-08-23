/**
 * Gateway REST /v1 (node-facing, spec §3).
 *
 * Router: a hand-rolled matcher over Bun's native Request/Response (spec §10
 * allows `hono` unless a zero-dependency Bun.serve router suffices — it does:
 * the route table is 6 fixed patterns with at most two dynamic segments, the
 * only middleware is auth, and the health server this mounts onto is already
 * plain Bun.serve; a router dependency would buy nothing).
 *
 * Auth (spec §3): every /v1 request needs the static bearer; tool-plane and
 * session endpoints additionally need the per-job JWT (X-Slaude-Job).
 *
 *   GET   /v1/sessions/:id            session row          (bearer + job token)
 *   PATCH /v1/sessions/:id            update started/model/mode  (same)
 *   GET   /v1/tenants/:id/runtime     runtime bundle, ETag/304   (bearer + job token;
 *                                     the bundle carries DECRYPTED provider creds, so a
 *                                     leaked static bearer alone must not fetch it — the
 *                                     token's tenant claim must match :id)
 *   GET   /v1/pending/:id             30s long-poll, 204 timeout (bearer)
 *   POST  /v1/jobs/:id/ack|fail       telemetry only             (bearer)
 *   POST  /v1/tools/:server/:tool     contract-validated tool call (bearer + job token)
 */
import { requireBearer, requireJobToken } from "./auth";
import { handleSession } from "./sessions";
import { handleTenantRuntime } from "./tenants";
import { handlePending, type PendingOptions } from "./pending";
import { handleJobEvent, handleTokenRefresh } from "./jobs";
import { executeToolCall } from "./tools";
import type { ToolPlaneDeps } from "./tools/deps";
import { defaultPendingSource, type PendingSource } from "./pending-source";
import { json, methodNotAllowed, notFound, readJson } from "./http";

export interface V1Api {
  /** Handle a request; null when the path is not under /v1 (caller falls through). */
  fetch(req: Request): Promise<Response | null>;
  /** The pending-gate source behind /v1/pending (test + resolver seam). */
  pendingSource: PendingSource;
}

export interface V1Options {
  tools: ToolPlaneDeps;
  pendingSource?: PendingSource;
  pending?: PendingOptions;
}

export function createV1Api(opts: V1Options): V1Api {
  const pendingSource = opts.pendingSource ?? defaultPendingSource();

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")) return null;

    const authErr = requireBearer(req);
    if (authErr) return authErr;

    const seg = url.pathname.split("/").filter(Boolean); // ["v1", ...]

    try {
      // /v1/sessions/:id
      if (seg.length === 3 && seg[1] === "sessions") {
        if (req.method !== "GET" && req.method !== "PATCH") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        return await handleSession(req, seg[2]!, job.claims);
      }

      // /v1/tenants/:id/runtime
      if (seg.length === 4 && seg[1] === "tenants" && seg[3] === "runtime") {
        if (req.method !== "GET") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        if (job.claims.tenant !== seg[2]!) {
          return json(403, { error: "job token is not scoped to this tenant" });
        }
        return await handleTenantRuntime(req, seg[2]!);
      }

      // /v1/pending/:id
      if (seg.length === 3 && seg[1] === "pending") {
        if (req.method !== "GET") return methodNotAllowed();
        return await handlePending(seg[2]!, pendingSource, opts.pending);
      }

      // /v1/jobs/:id/ack | /v1/jobs/:id/fail
      if (seg.length === 4 && seg[1] === "jobs" && (seg[3] === "ack" || seg[3] === "fail")) {
        if (req.method !== "POST") return methodNotAllowed();
        return await handleJobEvent(req, seg[2]!, seg[3] as "ack" | "fail");
      }

      // /v1/jobs/:id/token-refresh — auth is the ORIGINAL job token (expiry
      // forgiven within grace), checked inside the handler, not requireJobToken.
      if (seg.length === 4 && seg[1] === "jobs" && seg[3] === "token-refresh") {
        if (req.method !== "POST") return methodNotAllowed();
        return await handleTokenRefresh(req, seg[2]!);
      }

      // /v1/tools/:server/:tool
      if (seg.length === 4 && seg[1] === "tools") {
        if (req.method !== "POST") return methodNotAllowed();
        const job = requireJobToken(req);
        if ("response" in job) return job.response;
        const body = await readJson(req);
        if (body === null) return json(400, { error: "malformed JSON body" });
        return await executeToolCall(seg[2]!, seg[3]!, body, job.claims, opts.tools);
      }

      return notFound();
    } catch (e) {
      // Log the real error server-side; never reflect internals (messages can
      // carry paths, SQL, or provider detail) to the caller.
      console.error(`[v1] ${req.method} ${url.pathname} failed:`, e);
      return json(500, { error: "internal" });
    }
  }

  return { fetch, pendingSource };
}

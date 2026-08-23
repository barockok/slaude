import { db } from "./db/schema";
import { metrics } from "./metrics";

export type HealthDeps = {
  /** Number of currently live SDK sessions. */
  liveSessions: () => number;
};

/**
 * Route handler for the observability endpoints, shared between the
 * standalone health server (socket mode) and the HTTP Slack transport
 * (http mode serves /healthz, /readyz, /metrics and /slack/* on one port).
 *
 *   GET /healthz  → 200 always, JSON {status:"ok", uptime, sessions}
 *   GET /readyz   → 200 if DB reachable, else 503
 *   GET /metrics  → Prometheus text
 *
 * Returns null for any other path so the caller can keep routing.
 */
export function healthRoutes(deps: HealthDeps, startedAt = Date.now()) {
  return async (url: URL): Promise<Response | null> => {
    if (url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        uptime_ms: Date.now() - startedAt,
        sessions_live: deps.liveSessions(),
      });
    }
    if (url.pathname === "/metrics") {
      return new Response(metrics.render(), {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname === "/readyz") {
      try {
        await db.query("SELECT 1");
        return Response.json({ status: "ready" });
      } catch (e: any) {
        return Response.json(
          { status: "unready", error: e?.message ?? String(e) },
          { status: 503 },
        );
      }
    }
    return null;
  };
}

/**
 * Tiny HTTP server for liveness/readiness checks. Bun's native `serve()`.
 * Port: SLAUDE_HEALTH_PORT (default 8080). Set to 0 to disable.
 */
export function startHealthServer(deps: HealthDeps) {
  const portRaw = process.env.SLAUDE_HEALTH_PORT ?? "8080";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    console.log("[slaude] health server disabled");
    return null;
  }

  const routes = healthRoutes(deps);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const r = await routes(new URL(req.url));
      return r ?? new Response("not found", { status: 404 });
    },
  });

  console.log(`[slaude] health server on :${server.port}`);
  return server;
}

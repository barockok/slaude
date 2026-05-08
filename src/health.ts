import { db } from "./db/schema";

export type HealthDeps = {
  /** Number of currently live SDK sessions. */
  liveSessions: () => number;
};

/**
 * Tiny HTTP server for liveness/readiness checks. Bun's native `serve()`.
 *
 *   GET /healthz  → 200 always, JSON {status:"ok", uptime, sessions}
 *   GET /readyz   → 200 if DB reachable, else 503
 *
 * Port: SLAUDE_HEALTH_PORT (default 8080). Set to 0 to disable.
 */
export function startHealthServer(deps: HealthDeps) {
  const portRaw = process.env.SLAUDE_HEALTH_PORT ?? "8080";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    console.log("[slaude] health server disabled");
    return null;
  }

  const startedAt = Date.now();

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          uptime_ms: Date.now() - startedAt,
          sessions_live: deps.liveSessions(),
        });
      }
      if (url.pathname === "/readyz") {
        try {
          db.query("SELECT 1").get();
          return Response.json({ status: "ready" });
        } catch (e: any) {
          return Response.json(
            { status: "unready", error: e?.message ?? String(e) },
            { status: 503 },
          );
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[slaude] health server on :${server.port}`);
  return server;
}

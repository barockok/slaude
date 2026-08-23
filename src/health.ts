import { db } from "./db/schema";
import { metrics } from "./metrics";

export type HealthDeps = {
  /** Number of currently live SDK sessions. */
  liveSessions: () => number;
  /** Optional node-facing REST /v1 handler (GatewayHandle.fetchV1). Mounted
   *  only when provided — src/server.ts passes it for mono/gateway roles and
   *  omits it for nodes. Returns null for paths it doesn't own. */
  v1?: (req: Request) => Promise<Response | null>;
};

/**
 * Tiny HTTP server for liveness/readiness checks. Bun's native `serve()`.
 *
 *   GET /healthz  → 200 always, JSON {status:"ok", uptime, sessions}
 *   GET /readyz   → 200 if DB reachable, else 503
 *   /v1/*         → gateway REST for nodes, when `deps.v1` is provided
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
    async fetch(req) {
      const url = new URL(req.url);
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
      if (deps.v1 && (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))) {
        const res = await deps.v1(req);
        if (res) return res;
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[slaude] health server on :${server.port}`);
  return server;
}

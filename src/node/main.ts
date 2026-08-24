/**
 * Node entry (spec §6, §7): `bun run worker` (script name "worker" — "node"
 * would shadow the runtime's name in every shell and script that greps for
 * it). Boots the worker off env:
 *
 *   SLAUDE_GATEWAY_URL       gateway base URL for /v1 (default localhost:8080)
 *   SLAUDE_NODE_TOKEN        static bearer for /v1
 *   SLAUDE_REDIS_URL         queues / registry / locks / pub/sub
 *   SLAUDE_NODE_CONCURRENCY  BullMQ concurrency (default 8)
 *   SLAUDE_NODE_PORT         /healthz + /metrics (default 8081)
 *   SLAUDE_NODE_DRAIN_SEC    SIGTERM grace (default 120)
 *
 * The node has no Slack client, no Postgres, no brain (spec §1) — sessions,
 * tools and credentials all come from the gateway over /v1. SOUL.md, skills
 * and personas are read from the shared $SLAUDE_HOME volume.
 */
import { ensureHome } from "../config/home";
import { env } from "../config/env";
import { loadSoulData, setSoulData } from "../soul/extract";
import { loadPersonaRegistry, setPersonaRegistry } from "../persona/registry";
import { startNodeWorker } from "./worker";

async function main() {
  ensureHome();
  if (env.role() !== "node") {
    console.warn(`[node] SLAUDE_ROLE=${env.role()} — starting a node worker anyway (src/node/main.ts is the node entry)`);
  }
  if (!env.nodeToken()) {
    throw new Error("SLAUDE_NODE_TOKEN is not set — the node cannot authenticate to the gateway /v1");
  }

  // Soul + personas come from the shared RWX volume, same loaders as the
  // gateway. Best-effort: the extractor falls back to regex parsing.
  try {
    setSoulData(await loadSoulData());
  } catch (e) {
    console.warn("[node] soul prewarm failed (continuing with regex fallback):", e);
  }
  setPersonaRegistry(loadPersonaRegistry());

  const handle = await startNodeWorker({});

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[node] ${signal} — draining`);
    void handle
      .stop()
      .catch((e) => console.error("[node] drain failed:", e))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[node] fatal", err);
  process.exit(1);
});

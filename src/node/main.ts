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
 *   SLAUDE_NODE_BOOT_CHECK   warn (default) | refuse: what to do when a
 *                            gateway-only variable is in this environment
 *   SLAUDE_NODE_ALLOW_GATEWAY_SECRETS  1 = refuse only warns (temporary escape)
 *
 * The node has no Slack client, no Postgres, no brain (spec §1) — sessions,
 * tools and credentials all come from the gateway over /v1. The persona soul
 * (text and structured) comes from the runtime bundle at session boot, so a
 * persona's directory need not exist on the shared $SLAUDE_HOME volume; skills
 * and transcripts still live there.
 */
import { ensureHome } from "../config/home";
import { env } from "../config/env";
import { startNodeWorker } from "./worker";
import { enforceNodeBootCheck } from "./boot-check";

async function main() {
  // Before anything else: a node must not hold the gateway's secrets (the
  // master key, the job secret, database URLs, Slack secrets). Warns by
  // default; SLAUDE_NODE_BOOT_CHECK=refuse stops the boot. Names only.
  if (!enforceNodeBootCheck(process.env)) process.exit(1);
  ensureHome();
  if (env.role() !== "node") {
    console.warn(`[node] SLAUDE_ROLE=${env.role()} — starting a node worker anyway (src/node/main.ts is the node entry)`);
  }
  if (!env.nodeToken()) {
    throw new Error("SLAUDE_NODE_TOKEN is not set — the node cannot authenticate to the gateway /v1");
  }

  // No soul or persona registry is loaded here: the worker installs a persona
  // soul resolver that takes both from the runtime bundle per session, and the
  // AgentManager skips the registry whenever that resolver is installed.

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

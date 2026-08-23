import { ensureHome } from "./config/home";
import { seedBundledSkills } from "./skills/seed";
import { AgentManager } from "./agent/manager";
import { createSlackApp } from "./gateway/slack/adapter";
import { createGateway } from "./gateway/core/gateway";
import { createHttpSlackTransport } from "./gateway/slack/http-transport";
import { startHealthServer } from "./health";
import { loadSoulData, setSoulData } from "./soul/extract";
import { assertOAuthKeyCanary } from "./agent/mcp-oauth/store";
import { sharedLoopback } from "./agent/mcp-oauth/shared-loopback";
import { verifyState } from "./agent/mcp-oauth/state";
import { env } from "./config/env";
import { loadPersonaRegistry, setPersonaRegistry } from "./persona/registry";
import { getDb } from "./db/client";
import * as SoulOverrides from "./db/soul-overrides";

async function main() {
  ensureHome();
  seedBundledSkills();

  // Open the DB first: on Postgres this applies pending migrations, and a
  // bad SLAUDE_PG_URL fails the boot here instead of on the first message.
  // Priming the soul-overrides cache keeps the synchronous gate path
  // (soulData) correct from the first inbound event.
  const db = await getDb();
  console.log(`[db] ${db.dialect} (${db.driver}) ready`);
  await SoulOverrides.refresh();

  // Warm the structured-soul cache before sessions start. Best-effort: the
  // extractor falls back to regex parsing internally on any failure, so
  // boot never blocks on LLM availability.
  try {
    setSoulData(await loadSoulData());
  } catch (e) {
    console.warn("[slaude] soul prewarm failed (continuing with regex fallback):", e);
  }

  // Load persona registry. Absent ~/.slaude/personas/ = single-bot mode (no-op).
  const registry = loadPersonaRegistry();
  setPersonaRegistry(registry);
  if (registry.isMultiPersonaMode()) {
    console.log(`[persona] multi-persona mode: ${registry.list().map((p) => p.name).join(", ")}`);
  }

  const mcpOAuthHealthy = assertOAuthKeyCanary();
  if (!mcpOAuthHealthy) {
    console.error("[mcp-oauth] CANARY FAILED — oauthKey no longer matches the CLI store format. /mcp connect is DISABLED. Update src/agent/mcp-oauth/store.ts against the current cli.js.");
  }

  // Always-on shared OAuth loopback: one fixed port serving every session's /mcp
  // connect callback, demuxed by signed state. Opt-in; ephemeral per-flow loopback
  // remains the default.
  let loopback: { stop(): Promise<void> } | undefined;
  if (env.oauthSharedLoopback()) {
    const lb = sharedLoopback({
      host: env.oauthLoopbackHost(),
      port: env.oauthSharedLoopbackPort(),
      publicUrl: env.oauthPublicUrl() || undefined,
      verify: (s) => verifyState(s, env.oauthStateSecret()) !== null,
    });
    await lb.start();
    loopback = lb;
    console.log(`[mcp-oauth] shared loopback listening on ${env.oauthLoopbackHost()}:${lb.port}${lb.callbackPath}`);
  }

  const agent = new AgentManager();

  // Slack ingress: Socket Mode (default) or the Events API HTTP receiver
  // (SLAUDE_SLACK_MODE=http, spec §5). In http mode the transport's single
  // port also serves /healthz /readyz /metrics (and /v1, below), so the
  // standalone health server is not started; apps are resolved per-request
  // from the Postgres slack_apps registry.
  //
  // The node-facing REST /v1 (spec §7) is mounted on whichever server runs —
  // the standalone health server (socket mode) or the transport's port (http
  // mode) — for gateway/mono roles. Node processes call /v1, they never
  // serve it. `slack` is assigned before any request is served, so the v1
  // closure's late binding is safe.
  const slackMode = env.slack.mode();
  const role = env.role();
  let slack: import("./gateway/core/gateway").GatewayHandle;
  let health: ReturnType<typeof startHealthServer> = null;
  if (slackMode === "http") {
    if (db.dialect !== "pg") {
      throw new Error(
        "SLAUDE_SLACK_MODE=http requires SLAUDE_DB=pg — the slack_apps registry lives in Postgres (register apps with: bun run slack-app add)",
      );
    }
    const transport = createHttpSlackTransport({
      health: {
        liveSessions: () => agent.liveCount(),
        v1: role !== "node" ? (req: Request) => slack.fetchV1(req) : undefined,
      },
    });
    slack = createGateway(agent, transport, { mcpConnectEnabled: mcpOAuthHealthy });
  } else {
    slack = createSlackApp(agent, { mcpConnectEnabled: mcpOAuthHealthy });
    health = startHealthServer({
      liveSessions: () => agent.liveCount(),
      v1: role !== "node" ? (req) => slack.fetchV1(req) : undefined,
    });
  }
  if (role !== "node") console.log(`[slaude] /v1 REST mounted (role=${role})`);

  await slack.start();
  console.log(`[slaude] slack ${slackMode} mode started`);

  // Gateway role: contend for the reaper leadership (spec §2) — dead-node
  // cleanup, stalled-job rescue, and queue/registry gauges, every ~30s on
  // exactly one replica. mono runs no node pool, so no reaper.
  let reaperHandle: import("./queue/locks").LeaderHandle | undefined;
  if (role === "gateway") {
    const { startReaperLeader } = await import("./queue/reaper-runner");
    const { getRedis } = await import("./queue/redis");
    reaperHandle = startReaperLeader({ redis: getRedis() });
    console.log("[slaude] reaper leader loop contending");
  }

  const shutdown = async () => {
    console.log("[slaude] shutting down");
    health?.stop();
    await reaperHandle?.stop();
    await loopback?.stop();
    await slack.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[slaude] fatal", err);
  process.exit(1);
});

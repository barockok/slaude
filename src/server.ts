import { ensureHome } from "./config/home";
import { seedBundledSkills } from "./skills/seed";
import { AgentManager } from "./agent/manager";
import { createSlackApp } from "./gateway/slack/adapter";
import { startHealthServer } from "./health";
import { loadSoulData, setSoulData } from "./soul/extract";
import { assertOAuthKeyCanary } from "./agent/mcp-oauth/store";
import { sharedLoopback } from "./agent/mcp-oauth/shared-loopback";
import { verifyState } from "./agent/mcp-oauth/state";
import { env } from "./config/env";

async function main() {
  ensureHome();
  seedBundledSkills();

  // Warm the structured-soul cache before sessions start. Best-effort: the
  // extractor falls back to regex parsing internally on any failure, so
  // boot never blocks on LLM availability.
  try {
    setSoulData(await loadSoulData());
  } catch (e) {
    console.warn("[slaude] soul prewarm failed (continuing with regex fallback):", e);
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
      verify: (s) => verifyState(s, env.oauthStateSecret()) !== null,
    });
    await lb.start();
    loopback = lb;
    console.log(`[mcp-oauth] shared loopback listening on ${env.oauthLoopbackHost()}:${lb.port}${lb.callbackPath}`);
  }

  const agent = new AgentManager();
  const slack = createSlackApp(agent, { mcpConnectEnabled: mcpOAuthHealthy });
  const health = startHealthServer({ liveSessions: () => agent.liveCount() });

  await slack.start();
  console.log("[slaude] slack socket mode started");

  const shutdown = async () => {
    console.log("[slaude] shutting down");
    health?.stop();
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

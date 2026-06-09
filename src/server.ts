import { ensureHome } from "./config/home";
import { AgentManager } from "./agent/manager";
import { createSlackApp } from "./gateway/slack/adapter";
import { startHealthServer } from "./health";
import { loadSoulData, setSoulData } from "./soul/extract";
import { assertOAuthKeyCanary } from "./agent/mcp-oauth/store";

async function main() {
  ensureHome();

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

  const agent = new AgentManager();
  const slack = createSlackApp(agent, { mcpConnectEnabled: mcpOAuthHealthy });
  const health = startHealthServer({ liveSessions: () => agent.liveCount() });

  await slack.start();
  console.log("[slaude] slack socket mode started");

  const shutdown = async () => {
    console.log("[slaude] shutting down");
    health?.stop();
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

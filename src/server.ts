import { ensureHome } from "./config/home";
import { AgentManager } from "./agent/manager";
import { createSlackApp } from "./gateway/slack/adapter";
import { createWhatsAppApp } from "./gateway/whatsapp/adapter";
import { startHealthServer } from "./health";
import { loadSoulData, setSoulData } from "./soul/extract";
import { env } from "./config/env";

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

  const agent = new AgentManager();
  const health = startHealthServer({ liveSessions: () => agent.liveCount() });

  const shutdowns: Array<() => Promise<void>> = [];

  // Slack gateway
  if (env.slack.botToken() && env.slack.appToken()) {
    const slack = createSlackApp(agent);
    await slack.start();
    console.log("[slaude] slack socket mode started");
    shutdowns.push(async () => { await slack.stop(); });
  }

  // WhatsApp gateway
  if (env.whatsapp.enabled()) {
    const whatsapp = createWhatsAppApp(agent);
    await whatsapp.start();
    console.log("[slaude] whatsapp started");
    shutdowns.push(async () => { await whatsapp.stop(); });
  }

  const shutdown = async () => {
    console.log("[slaude] shutting down");
    health?.stop();
    for (const fn of shutdowns) {
      try { await fn(); } catch (e) { console.error("[slaude] shutdown error:", e); }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[slaude] fatal", err);
  process.exit(1);
});

import { ensureHome } from "./config/home";
import { AgentManager } from "./agent/manager";
import { createSlackApp } from "./gateway/slack/adapter";

async function main() {
  ensureHome();

  const agent = new AgentManager();
  const slack = createSlackApp(agent);

  await slack.start();
  console.log("[slaude] slack socket mode started");

  const shutdown = async () => {
    console.log("[slaude] shutting down");
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

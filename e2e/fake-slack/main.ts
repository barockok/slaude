import { startFakeSlack } from "./server";

const port = Number(process.env.PORT ?? 8080);
const delays = (process.env.FAKE_SLACK_RETRY_DELAYS ?? "0,60000,300000").split(",").map(Number);
const running = await startFakeSlack({
  port,
  publicUrl: process.env.FAKE_SLACK_PUBLIC_URL,
  teamId: process.env.FAKE_SLACK_TEAM_ID,
  retryDelaysMs: delays,
});
console.log(`fake-slack listening on ${running.port}`);

const shutdown = () => void running.stop().finally(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

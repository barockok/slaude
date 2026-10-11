import { startFakeSlack } from "./server";

const port = Number(process.env.PORT ?? 8080);
// Slack-faithful retries (0, 1 min, 5 min) mean a down or slow target blocks a control `send` for the
// whole schedule. The cluster sets short delays here; tests pass `retryDelaysMs` per request or to startFakeSlack.
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

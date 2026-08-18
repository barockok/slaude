import { App, LogLevel } from "@slack/bolt";
import { env } from "../../config/env";
import type { Transport } from "../core/transport";

/** Socket Mode transport (default). Requires SLACK_APP_TOKEN. No public URL needed. */
export function createSlackTransport(): Transport {
  const app = new App({
    token: env.slack.botToken(),
    appToken: env.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.INFO,
  });
  return {
    client: app.client as any,
    action: (idOrRegex, h) => app.action(idOrRegex as any, h as any),
    event: (name, h) => app.event(name as any, h as any),
    use: (mw) => app.use(mw as any),
    start: () => app.start().then(() => undefined),
    stop: () => app.stop().then(() => undefined),
  };
}

/** HTTP (webhook) transport. Requires SLACK_SIGNING_SECRET and a public URL
 *  pointing at SLACK_WEBHOOK_PORT. No SLACK_APP_TOKEN needed. */
export function createSlackWebhookTransport(): Transport {
  const port = env.slack.webhookPort();
  const app = new App({
    token: env.slack.botToken(),
    signingSecret: env.slack.signingSecret(),
    logLevel: LogLevel.INFO,
  });
  return {
    client: app.client as any,
    action: (idOrRegex, h) => app.action(idOrRegex as any, h as any),
    event: (name, h) => app.event(name as any, h as any),
    use: (mw) => app.use(mw as any),
    start: () => app.start(port).then(() => {
      console.log(`[slaude] slack webhook transport listening on :${port}`);
    }),
    stop: () => app.stop().then(() => undefined),
  };
}

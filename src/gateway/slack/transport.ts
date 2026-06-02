import { App, LogLevel } from "@slack/bolt";
import { env } from "../../config/env";
import type { Transport } from "../core/transport";

/** Production transport: wraps a bolt Socket Mode App. Bolt's App already
 *  satisfies Transport structurally; we wrap it so start/stop are explicit and
 *  the client is exposed as WebClientLike. */
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

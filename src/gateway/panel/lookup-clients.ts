/**
 * Slack clients for the console's name lookups only (./slack-names), one per
 * bot token, kept apart from the clients that post. They never retry and
 * reject a rate-limited call instead of waiting it out, so a lookup can
 * neither queue behind nor hold up an agent's reply on the posting client.
 */
import type { SlackNameClient } from "./slack-names";
import { env } from "../../config/env";

export type LookupClientFactory = (token: string) => SlackNameClient;

/** A WebClient with no retries that rejects rate-limited calls (the caller backs off). */
export function defaultLookupClient(token: string): SlackNameClient {
  const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");
  const slackApiUrl = env.slack.apiUrl();
  return new WebClient(token, {
    ...(slackApiUrl ? { slackApiUrl } : {}),
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
  }) as unknown as SlackNameClient;
}

/** Lookup clients cached by token: one client per app, built on first use. */
export function createLookupClients(make: LookupClientFactory = defaultLookupClient): { forToken(token: string | null | undefined): SlackNameClient | null } {
  const byToken = new Map<string, SlackNameClient>();
  return {
    forToken(token) {
      if (!token) return null;
      let c = byToken.get(token);
      if (!c) {
        c = make(token);
        byToken.set(token, c);
      }
      return c;
    },
  };
}

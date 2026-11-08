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

/**
 * A bot token of some registered app installed in `teamId`, for lookups any
 * app of that workspace can answer (a person's name, the workspace's own
 * name). Used when no app is named and the team alone is ambiguous, as with
 * one Slack app per persona in one workspace: the pick is the first by app
 * id, so it is stable. Undefined when no app of that team has a token.
 */
export async function teamLookupToken(
  teamId: string,
  apps: (() => Promise<ReadonlyArray<{ apiAppId: string; teamId: string }>>) | undefined,
  tokenFor: (app: { apiAppId: string; teamId: string }) => string | undefined,
): Promise<string | undefined> {
  if (!apps) return undefined;
  let list: ReadonlyArray<{ apiAppId: string; teamId: string }>;
  try {
    list = await apps();
  } catch {
    return undefined;
  }
  for (const a of [...list].filter((x) => x.teamId === teamId).sort((x, y) => x.apiAppId.localeCompare(y.apiAppId))) {
    const token = tokenFor({ apiAppId: a.apiAppId, teamId: a.teamId });
    if (token) return token;
  }
  return undefined;
}

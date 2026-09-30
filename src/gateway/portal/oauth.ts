/**
 * The portal's own MCP OAuth round trip.
 *
 * Both Slack-side connect modes keep the pending flow in one process: paste-back
 * in a Map keyed by channel and thread, loopback in a listener bound inside one
 * pod. With two gateway replicas the callback can land on the one that did not
 * start the flow, and the connect fails. The portal cannot inherit that, because
 * a browser redirect is routed by the ingress to whichever replica it likes.
 *
 * So nothing is held in process. `prepareConnect` gives back the exchange's
 * inputs as plain values; they go into an encrypted single-use row, and the
 * browser is handed only that row's id in a signed cookie. Any replica can
 * finish the flow, and the client secret dynamic registration issued never
 * leaves the gateway.
 */
import { env } from "../../config/env";
import { createFlow, takeFlow, type PortalFlow } from "../../db/portal-oauth-flows";
import { discover } from "../../agent/mcp-oauth/discovery";
import { exchangeAuthCode, prepareConnect, type ExchangeParts, type PreparedConnect } from "../../agent/mcp-oauth/client";
import { persistConnectForOwner } from "../../agent/mcp-oauth/persist";
import type { OAuthServerConfig, OAuthTokens } from "../../agent/mcp-oauth/store";

export interface PortalConnectDeps {
  /** Test seam: stand in for discovery + dynamic registration. */
  prepare?: (args: {
    serverName: string;
    serverConfig: OAuthServerConfig;
    redirectUri: string;
  }) => Promise<PreparedConnect>;
  /** Test seam: stand in for the token endpoint. */
  exchange?: (parts: ExchangeParts, code: string) => Promise<OAuthTokens>;
}

export type FinishFailure = "no-flow" | "state-mismatch" | "exchange-failed";

/** Where the provider sends the browser back. Registered as the client's only
 *  redirect_uri, and re-derived at the callback rather than trusted from it. */
export function portalOauthCallbackUri(): string {
  return `${env.panel.publicUrl()}/portal/oauth/callback`;
}

const defaultPrepare: NonNullable<PortalConnectDeps["prepare"]> = async ({ serverName, serverConfig, redirectUri }) =>
  prepareConnect({ serverName, serverConfig, meta: await discover(serverConfig.url), redirectUri });

/**
 * Begin a connect: register a client, build the authorize URL, and store what
 * the exchange will need. Returns the flow id the caller puts in the cookie.
 */
export async function startPortalConnect(
  accountId: string,
  serverName: string,
  cfg: OAuthServerConfig,
  deps: PortalConnectDeps = {},
): Promise<{ authorizeUrl: string; flowId: string }> {
  const redirectUri = portalOauthCallbackUri();
  const prepared = await (deps.prepare ?? defaultPrepare)({ serverName, serverConfig: cfg, redirectUri });
  const flow: PortalFlow = {
    clientId: prepared.parts.clientId,
    ...(prepared.parts.clientSecret ? { clientSecret: prepared.parts.clientSecret } : {}),
    verifier: prepared.parts.verifier,
    // Pinned here, not rediscovered at the callback: re-running discovery
    // against the MCP server would let a server that has since turned hostile
    // name where the authorization code is sent.
    tokenEndpoint: prepared.parts.tokenEndpoint,
    serverName,
    cfg,
    state: prepared.state,
  };
  return { authorizeUrl: prepared.authorizeUrl, flowId: await createFlow(accountId, flow) };
}

/**
 * Complete a connect.
 *
 * The flow is consumed as it is read, so nothing here is retryable — including
 * the state mismatch, whose authorization is no longer trustworthy. The account
 * is passed to `takeFlow`, so one person's callback can neither read nor consume
 * another's flow.
 *
 * A failed exchange reports only that it failed: a provider's error_description
 * can name a token, and this result reaches a browser.
 */
export async function finishPortalConnect(
  accountId: string,
  flowId: string,
  code: string,
  state: string,
  deps: PortalConnectDeps = {},
): Promise<{ ok: true; serverName: string } | { ok: false; reason: FinishFailure }> {
  const flow = await takeFlow(flowId, accountId);
  if (!flow) return { ok: false, reason: "no-flow" };
  if (state !== flow.state) {
    console.warn(`[portal] oauth callback state mismatch for server=${flow.serverName}`);
    return { ok: false, reason: "state-mismatch" };
  }

  const parts: ExchangeParts = {
    tokenEndpoint: flow.tokenEndpoint,
    redirectUri: portalOauthCallbackUri(),
    clientId: flow.clientId,
    ...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
    verifier: flow.verifier,
    resource: flow.cfg.url,
  };
  let tokens: OAuthTokens;
  try {
    tokens = await (deps.exchange ?? ((p, c) => exchangeAuthCode(p, c)))(parts, code);
  } catch (e) {
    console.error(`[portal] connect exchange failed for server=${flow.serverName}: ${(e as Error).message}`);
    return { ok: false, reason: "exchange-failed" };
  }

  await persistConnectForOwner(
    { kind: "account", accountId },
    flow.serverName,
    flow.cfg,
    tokens,
  );
  return { ok: true, serverName: flow.serverName };
}

import { generatePkce, randomState } from "./pkce";
import { registerClient } from "./register";
import { startLoopback } from "./loopback";
import type { AuthServerMeta } from "./discovery";
import type { OAuthServerConfig, OAuthTokens } from "./store";
import type { FetchLike } from "./types";
import { outboundFetch } from "../../net/outbound-policy";

export interface BeginConnectOpts {
  serverName: string;
  serverConfig: OAuthServerConfig;
  meta: AuthServerMeta;
  loopbackHost?: string;
  loopbackPort?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface ConnectHandle {
  authorizeUrl: string;
  waitForCode(): Promise<string>;
  exchange(code: string): Promise<OAuthTokens>;
}

export interface PrepareConnectOpts {
  serverName: string;
  serverConfig: OAuthServerConfig;
  meta: AuthServerMeta;
  /** The fixed redirect_uri the IdP sends the browser back to. For loopback this
   *  is the ephemeral listener; for paste-back it is the operator's static page
   *  (SLAUDE_OAUTH_REDIRECT_URL). Registered as the client's only redirect_uri. */
  redirectUri: string;
  fetchImpl?: FetchLike;
}

export interface PreparedConnect {
  authorizeUrl: string;
  /** The CSRF `state` embedded in authorizeUrl — the caller validates the value
   *  returned on the callback against this. */
  state: string;
  exchange(code: string): Promise<OAuthTokens>;
  /** Everything `exchange` closes over, as plain values.
   *
   *  A caller that cannot keep the closure alive until the callback arrives —
   *  the portal, where the browser may come back to another replica — stores
   *  these instead and calls `exchangeAuthCode` itself. They include the client
   *  secret dynamic registration issued, so they belong in encrypted storage
   *  and never in anything the browser can read. */
  parts: ExchangeParts;
}

/** The values a token exchange needs, independent of any one process. */
export interface ExchangeParts {
  tokenEndpoint: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  verifier: string;
  /** The MCP server URL, sent as the RFC 8707 `resource`. */
  resource: string;
}

/** Redeem an authorization code. The single implementation behind both connect
 *  paths and the portal's, so a stored flow exchanges exactly as an in-process
 *  one does. Never echoes the provider's body into the message: an
 *  error_description can name a token. */
export async function exchangeAuthCode(
  parts: ExchangeParts,
  code: string,
  fetchImpl: FetchLike = outboundFetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(parts.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: parts.redirectUri,
      client_id: parts.clientId,
      code_verifier: parts.verifier,
      resource: parts.resource,
    }).toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`token exchange failed (status ${res.status})`);
  }
  const j = await res.json();
  if (!j?.access_token) throw new Error("token response missing access_token");
  return {
    clientId: parts.clientId,
    clientSecret: parts.clientSecret,
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    tokenEndpoint: parts.tokenEndpoint,
    expiresIn: j.expires_in,
  };
}

/** Listener-free core of the OAuth flow: validate metadata, register the client
 *  against `redirectUri`, build the authorize URL (PKCE S256 + state + resource),
 *  and return an `exchange(code)` bound to the same verifier/redirectUri. No port,
 *  no listener — works in k8s where arbitrary runtime ports aren't reachable. */
export async function prepareConnect(opts: PrepareConnectOpts): Promise<PreparedConnect> {
  const fetchImpl = opts.fetchImpl ?? outboundFetch;
  if (!opts.meta.authorizationEndpoint || !opts.meta.tokenEndpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  if (!opts.meta.registrationEndpoint) throw new Error("authorization server has no registration_endpoint (dynamic registration required)");

  const state = randomState();
  const pkce = generatePkce();
  const redirectUri = opts.redirectUri;
  const client = await registerClient(opts.meta.registrationEndpoint, redirectUri, fetchImpl);

  const u = new URL(opts.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", pkce.challenge);
  u.searchParams.set("code_challenge_method", pkce.method);
  u.searchParams.set("state", state);
  u.searchParams.set("resource", opts.serverConfig.url);
  const authorizeUrl = u.toString();

  const parts: ExchangeParts = {
    tokenEndpoint: opts.meta.tokenEndpoint,
    redirectUri,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    verifier: pkce.verifier,
    resource: opts.serverConfig.url,
  };

  return { authorizeUrl, state, parts, exchange: (code) => exchangeAuthCode(parts, code, fetchImpl) };
}

/** Loopback variant: bind an ephemeral listener, then register against its
 *  redirect_uri and capture the code via `waitForCode()`. Use only where the
 *  initiator's browser can reach the slaude host's loopback (local / same-host
 *  container). In k8s use the paste-back path (`prepareConnect` + a static
 *  redirect page). Structurally parallels `prepareConnect`, but the loopback must
 *  know the state and port before building the redirect_uri, so it stays separate. */
export async function beginConnect(opts: BeginConnectOpts): Promise<ConnectHandle> {
  const fetchImpl = opts.fetchImpl ?? outboundFetch;
  if (!opts.meta.authorizationEndpoint || !opts.meta.tokenEndpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  if (!opts.meta.registrationEndpoint) throw new Error("authorization server has no registration_endpoint (dynamic registration required)");

  const state = randomState();
  const pkce = generatePkce();
  const loopback = await startLoopback({
    host: opts.loopbackHost ?? "127.0.0.1",
    port: opts.loopbackPort,
    expectedState: state,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
  const redirectUri = `http://localhost:${loopback.port}${loopback.callbackPath}`;
  const client = await registerClient(opts.meta.registrationEndpoint, redirectUri, fetchImpl);

  const u = new URL(opts.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", pkce.challenge);
  u.searchParams.set("code_challenge_method", pkce.method);
  u.searchParams.set("state", state);
  u.searchParams.set("resource", opts.serverConfig.url);
  const authorizeUrl = u.toString();

  const parts: ExchangeParts = {
    tokenEndpoint: opts.meta.tokenEndpoint,
    redirectUri,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    verifier: pkce.verifier,
    resource: opts.serverConfig.url,
  };

  return {
    authorizeUrl,
    waitForCode: loopback.waitForCode,
    exchange: (code) => exchangeAuthCode(parts, code, fetchImpl),
  };
}

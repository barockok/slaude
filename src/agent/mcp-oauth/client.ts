import { generatePkce, randomState } from "./pkce";
import { registerClient } from "./register";
import { startLoopback } from "./loopback";
import type { AuthServerMeta } from "./discovery";
import type { OAuthServerConfig, OAuthTokens } from "./store";
import type { FetchLike } from "./types";

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
}

/** Listener-free core of the OAuth flow: validate metadata, register the client
 *  against `redirectUri`, build the authorize URL (PKCE S256 + state + resource),
 *  and return an `exchange(code)` bound to the same verifier/redirectUri. No port,
 *  no listener — works in k8s where arbitrary runtime ports aren't reachable. */
export async function prepareConnect(opts: PrepareConnectOpts): Promise<PreparedConnect> {
  const fetchImpl = opts.fetchImpl ?? (fetch as any);
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

  async function exchange(code: string): Promise<OAuthTokens> {
    const res = await fetchImpl(opts.meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: pkce.verifier,
        resource: opts.serverConfig.url,
      }).toString(),
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`token exchange failed (status ${res.status}): ${JSON.stringify(body)}`);
    }
    const j = await res.json();
    if (!j?.access_token) throw new Error("token response missing access_token");
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresIn: j.expires_in,
    };
  }

  return { authorizeUrl, state, exchange };
}

/** Loopback variant: bind an ephemeral listener, then register against its
 *  redirect_uri and capture the code via `waitForCode()`. Use only where the
 *  initiator's browser can reach the slaude host's loopback (local / same-host
 *  container). In k8s use the paste-back path (`prepareConnect` + a static
 *  redirect page). Structurally parallels `prepareConnect`, but the loopback must
 *  know the state and port before building the redirect_uri, so it stays separate. */
export async function beginConnect(opts: BeginConnectOpts): Promise<ConnectHandle> {
  const fetchImpl = opts.fetchImpl ?? (fetch as any);
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

  async function exchange(code: string): Promise<OAuthTokens> {
    const res = await fetchImpl(opts.meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: pkce.verifier,
        resource: opts.serverConfig.url,
      }).toString(),
    });
    if (res.status < 200 || res.status >= 300) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`token exchange failed (status ${res.status}): ${JSON.stringify(body)}`);
    }
    const j = await res.json();
    if (!j?.access_token) throw new Error("token response missing access_token");
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresIn: j.expires_in,
    };
  }

  return { authorizeUrl, waitForCode: loopback.waitForCode, exchange };
}

import { generatePkce } from "./pkce";
import { registerClient } from "./register";
import { signState } from "./state";
import { sharedLoopback, type SharedLoopback } from "./shared-loopback";
import { exchangeAuthCode } from "./token-exchange";
import type { AuthServerMeta } from "./discovery";
import type { OAuthServerConfig, OAuthTokens } from "./store";
import type { FetchLike } from "./types";

export interface BeginConnectSharedOpts {
  /** Session this flow belongs to; carried (signed) through `state` and read back
   *  off the callback so the shared listener routes the code to the right flow. */
  sessionId: string;
  /** HMAC secret for signing/verifying the sid in `state` (see state.ts). */
  stateSecret: string;
  serverName: string;
  serverConfig: OAuthServerConfig;
  meta: AuthServerMeta;
  /** Injectable for tests; defaults to the process-wide singleton. */
  loopback?: SharedLoopback;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface SharedConnectHandle {
  authorizeUrl: string;
  /** The signed state embedded in authorizeUrl (decodes to sessionId via state.ts). */
  state: string;
  waitForCode(): Promise<string>;
  exchange(code: string): Promise<OAuthTokens>;
}

/**
 * Shared-loopback variant of `beginConnect`. Instead of binding a fresh listener
 * per flow, it registers this flow with the always-on `SharedLoopback` under a
 * signed `state` carrying the session id, and registers the client against the
 * listener's fixed (state-independent) redirect_uri. Many sessions can be mid-flow
 * at once; each callback is routed back to its flow by `state`.
 */
export async function beginConnectShared(opts: BeginConnectSharedOpts): Promise<SharedConnectHandle> {
  const fetchImpl = opts.fetchImpl ?? (fetch as any);
  if (!opts.meta.authorizationEndpoint || !opts.meta.tokenEndpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  if (!opts.meta.registrationEndpoint) {
    throw new Error("authorization server has no registration_endpoint (dynamic registration required)");
  }

  const lb = opts.loopback ?? sharedLoopback();
  await lb.start(); // idempotent

  const state = signState(opts.sessionId, opts.stateSecret);
  const pkce = generatePkce();
  const flow = lb.register(state, opts.timeoutMs ?? 5 * 60_000);
  const redirectUri = flow.redirectUri;
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

  return {
    authorizeUrl,
    state,
    waitForCode: flow.waitForCode,
    exchange: (code: string) =>
      exchangeAuthCode({
        tokenEndpoint: opts.meta.tokenEndpoint,
        code,
        redirectUri,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: pkce.verifier,
        serverConfig: opts.serverConfig,
        fetchImpl,
      }),
  };
}

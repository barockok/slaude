import type { OAuthServerConfig, OAuthTokens } from "./store";
import type { FetchLike } from "./types";

/** RFC 6749 §4.1.3 authorization-code exchange (PKCE). Shared by the ephemeral and
 *  shared-loopback connect paths so the token-endpoint contract lives in one place. */
export async function exchangeAuthCode(params: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  serverConfig: OAuthServerConfig;
  fetchImpl: FetchLike;
}): Promise<OAuthTokens> {
  const res = await params.fetchImpl(params.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
      resource: params.serverConfig.url,
    }).toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`token exchange failed (status ${res.status}): ${JSON.stringify(body)}`);
  }
  const j = await res.json();
  if (!j?.access_token) throw new Error("token response missing access_token");
  return {
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresIn: j.expires_in,
  };
}

/**
 * RFC 6749 §6 refresh_token grant.
 *
 * Only the gateway runs this: nodes never hold a refresh token or a client
 * secret. The provider's response body is never echoed into an error — an
 * error_description can name a token — so failures are described by HTTP
 * status and the standard OAuth error code alone.
 */
import type { OAuthTokens } from "./store";
import type { FetchLike } from "./types";

/** The provider refused the grant (400/401): the refresh token is spent,
 *  revoked or otherwise unusable. The owner has to reconnect. Distinct from a
 *  transient failure, which may succeed on retry. */
export class RefreshRejected extends Error {
  constructor(public status: number, public oauthError: string | undefined) {
    super(`refresh rejected by the provider (status ${status}${oauthError ? `, ${oauthError}` : ""})`);
    this.name = "RefreshRejected";
  }
}

/** Standard OAuth error codes are short tokens; anything else is not echoed. */
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

export async function refreshGrant(p: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /** RFC 8707 resource indicator, as the connect flow sends. */
  resource: string;
  fetchImpl?: FetchLike;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    client_id: p.clientId,
    resource: p.resource,
  });
  // Public clients (the connect flow's default) authenticate with PKCE and send
  // no secret; a client registered with one sends it, client_secret_post.
  if (p.clientSecret) body.set("client_secret", p.clientSecret);

  const res = await (p.fetchImpl ?? (fetch as unknown as FetchLike))(p.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });

  if (res.status === 400 || res.status === 401) {
    const j = await res.json().catch(() => ({}));
    const code = typeof j?.error === "string" && OAUTH_ERROR.test(j.error) ? j.error : undefined;
    throw new RefreshRejected(res.status, code);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`refresh failed at the provider (status ${res.status})`);
  }
  const j = await res.json().catch(() => null);
  if (!j || typeof j.access_token !== "string" || !j.access_token) {
    throw new Error("refresh response carried no access token");
  }
  return {
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    accessToken: j.access_token,
    // A provider that does not rotate omits it; the current one stays valid.
    refreshToken: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : p.refreshToken,
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : undefined,
  };
}

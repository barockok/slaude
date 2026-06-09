import type { FetchLike } from "./types";

export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

/** Resolve the OAuth authorization-server metadata for an HTTP MCP server.
 *  fetchImpl is injectable for tests; defaults to global fetch. */
export async function discover(serverUrl: string, fetchImpl: FetchLike = fetch as any): Promise<AuthServerMeta> {
  const probe = await fetchImpl(serverUrl);
  const wwwAuth = probe.headers.get("www-authenticate") || "";
  const m = wwwAuth.match(/resource_metadata="([^"]+)"/);
  if (!m) {
    throw new Error(`MCP server did not advertise resource_metadata (status ${probe.status}, WWW-Authenticate="${wwwAuth}")`);
  }
  const prmRes = await fetchImpl(m[1]!);
  if (prmRes.status < 200 || prmRes.status >= 300) throw new Error(`protected-resource metadata fetch failed (status ${prmRes.status})`);
  const prm = await prmRes.json();
  const asUrl: string | undefined = prm?.authorization_servers?.[0];
  if (!asUrl) throw new Error("protected-resource metadata listed no authorization_servers");
  const asMetaUrl = asUrl.replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
  const asRes = await fetchImpl(asMetaUrl);
  if (asRes.status < 200 || asRes.status >= 300) throw new Error(`authorization-server metadata fetch failed (status ${asRes.status})`);
  const as = await asRes.json();
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
  };
}

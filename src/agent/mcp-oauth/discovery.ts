export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

type FetchLike = (url: string, init?: any) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

/** Resolve the OAuth authorization-server metadata for an HTTP MCP server.
 *  fetchImpl is injectable for tests; defaults to global fetch. */
export async function discover(serverUrl: string, fetchImpl: FetchLike = fetch as any): Promise<AuthServerMeta> {
  const probe = await fetchImpl(serverUrl);
  const wwwAuth = probe.headers.get("www-authenticate") || "";
  const m = wwwAuth.match(/resource_metadata="([^"]+)"/);
  if (!m) {
    throw new Error(`MCP server did not advertise resource_metadata (status ${probe.status}, WWW-Authenticate="${wwwAuth}")`);
  }
  const prm = await (await fetchImpl(m[1]!)).json();
  const asUrl: string | undefined = prm?.authorization_servers?.[0];
  if (!asUrl) throw new Error("protected-resource metadata listed no authorization_servers");
  const asMetaUrl = asUrl.replace(/\/$/, "") + "/.well-known/oauth-authorization-server";
  const as = await (await fetchImpl(asMetaUrl)).json();
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error("authorization-server metadata missing authorization_endpoint/token_endpoint");
  }
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
  };
}

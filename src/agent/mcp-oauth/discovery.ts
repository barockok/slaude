import type { FetchLike } from "./types";

export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

/** RFC 9728 well-known protected-resource metadata URLs derived from a server URL.
 *  Path-aware variant first (`/.well-known/oauth-protected-resource/<path>`), then the
 *  root. A trailing slash on the server path yields no extra segment. */
function wellKnownPrmUrls(serverUrl: string): string[] {
  try {
    const u = new URL(serverUrl);
    const path = u.pathname.replace(/\/+$/, "");
    const root = `${u.origin}/.well-known/oauth-protected-resource`;
    return path ? [`${root}${path}`, root] : [root];
  } catch {
    return [];
  }
}

/** Resolve the OAuth authorization-server metadata for an HTTP MCP server.
 *  fetchImpl is injectable for tests; defaults to global fetch. */
export async function discover(serverUrl: string, fetchImpl: FetchLike = fetch as any): Promise<AuthServerMeta> {
  const probe = await fetchImpl(serverUrl);
  const wwwAuth = probe.headers.get("www-authenticate") || "";
  const m = wwwAuth.match(/resource_metadata="([^"]+)"/);

  // Resolve the protected-resource metadata URL. Preferred: the `resource_metadata`
  // hint from a 401 challenge. Fallback (RFC 9728 §3): some servers (e.g. workbench)
  // don't emit the challenge on a bare GET — they 404 — but still serve the metadata
  // at the well-known URL derived from the server URL. Try the path-aware variant
  // first, then the root, before giving up.
  let prmUrl = m?.[1];
  if (!prmUrl) {
    for (const candidate of wellKnownPrmUrls(serverUrl)) {
      const r = await fetchImpl(candidate);
      if (r.status >= 200 && r.status < 300) { prmUrl = candidate; break; }
    }
  }
  if (!prmUrl) {
    throw new Error(`MCP server did not advertise resource_metadata (status ${probe.status}, WWW-Authenticate="${wwwAuth}")`);
  }
  const prmRes = await fetchImpl(prmUrl);
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

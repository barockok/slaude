type FetchLike = (url: string, init?: any) => Promise<{ status: number; headers: { get(n: string): string | null }; json(): Promise<any>; }>;

export interface ClientInfo { clientId: string; clientSecret?: string; }

/** RFC 7591 dynamic client registration for a public (PKCE) client. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch as any,
): Promise<ClientInfo> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "slaude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`client registration failed (status ${res.status}): ${JSON.stringify(body)}`);
  }
  const j = await res.json();
  if (!j?.client_id) throw new Error("registration response missing client_id");
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

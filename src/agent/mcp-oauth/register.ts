import type { FetchLike } from "./types";
import { outboundFetch } from "../../net/outbound-policy";

export interface ClientInfo { clientId: string; clientSecret?: string; }

/** RFC 7591 dynamic client registration for a public (PKCE) client. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = outboundFetch,
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
  // The status only. This message is posted into the Slack thread on a failed
  // connect (gateway.ts), and a provider's error body can name a credential.
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`client registration failed (status ${res.status})`);
  }
  const j = await res.json();
  if (!j?.client_id) throw new Error("registration response missing client_id");
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

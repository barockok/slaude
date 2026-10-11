// Portal API client. Authenticated by the portal's own HttpOnly session cookie;
// identity is never in a header or the URL, and is read back from
// /portal/api/me.
//
// Every mutating call carries the anti-CSRF header the server checks before it
// does any work. A cross-site page cannot set it.

export interface Integration {
  /** What every call refers to the row by. Usually the name; a name plus hash
   *  when two different servers share one. */
  id: string;
  name: string;
  host: string;
  connected: boolean;
  expiresAt: number | null;
  /** The agents (personas) that mount this server. */
  usedBy: string[];
}

export interface Me {
  email: string;
  accountId: string;
  slackIdentities: Array<{ teamId: string; slackUserId: string; linkedAt: number }>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutating = !!init.method && init.method !== "GET";
  const res = await fetch(path, {
    ...init,
    headers: { ...(mutating ? { "x-portal-csrf": "1" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => call<Me>("/portal/api/me"),
  integrations: () => call<{ integrations: Integration[] }>("/portal/api/integrations").then((r) => r.integrations),
  connect: (id: string) =>
    call<{ authorizeUrl: string }>(`/portal/api/integrations/${encodeURIComponent(id)}/connect`, { method: "POST" }),
  disconnect: (id: string) =>
    call<{ ok: boolean; removed: boolean }>(`/portal/api/integrations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Remove one Slack identity from the signed-in account. A DELETE with a JSON
   *  body; the CSRF header is added by `call()` because the method mutates. */
  unlink: (teamId: string, slackUserId: string) =>
    call<{ ok: boolean }>("/portal/api/link", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId, slackUserId }),
    }),
};

/** What the OAuth callback redirected back with, if anything. */
export const CONNECT_RESULTS: Record<string, string> = {
  connected: "Connected.",
  expired: "That took too long, or was started in another browser. Try again.",
  "no-flow": "That connection attempt is no longer valid. Try again.",
  "state-mismatch": "That callback did not match the request. Nothing was changed.",
  "exchange-failed": "The service refused the connection. Try again.",
  failed: "The connection did not complete. Try again.",
};

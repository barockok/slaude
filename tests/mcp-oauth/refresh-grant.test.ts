/**
 * RFC 6749 §6 refresh_token grant, run only by the gateway. The provider's
 * response and error bodies are never echoed: a refresh failure is described
 * by status and OAuth error code alone.
 */
import { describe, expect, test } from "bun:test";
import { refreshGrant, RefreshRejected } from "../../src/agent/mcp-oauth/refresh";

type Seen = { url: string; body: URLSearchParams; headers: Headers };

function provider(respond: (body: URLSearchParams) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    seen.push({ url, body, headers: new Headers(init.headers) });
    return respond(body);
  }) as any;
  return { seen, fetchImpl };
}

const base = {
  tokenEndpoint: "https://idp.example.com/token",
  clientId: "client-1",
  refreshToken: "refresh-old",
  resource: "https://mcp.example.com/mcp",
};

describe("refreshGrant", () => {
  test("posts a refresh_token grant and returns the new tokens", async () => {
    const p = provider(() => Response.json({ access_token: "tok-new", refresh_token: "refresh-new", expires_in: 900 }));
    const t = await refreshGrant({ ...base, fetchImpl: p.fetchImpl });
    expect(p.seen[0]!.url).toBe(base.tokenEndpoint);
    expect(p.seen[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(p.seen[0]!.body.get("refresh_token")).toBe("refresh-old");
    expect(p.seen[0]!.body.get("client_id")).toBe("client-1");
    expect(p.seen[0]!.body.get("resource")).toBe(base.resource);
    expect(t).toMatchObject({ accessToken: "tok-new", refreshToken: "refresh-new", expiresIn: 900 });
  });

  // A provider that does not rotate returns no refresh_token; the old one
  // stays valid and must be kept, or the next refresh has nothing to present.
  test("keeps the current refresh token when the provider does not rotate", async () => {
    const p = provider(() => Response.json({ access_token: "tok-new", expires_in: 900 }));
    const t = await refreshGrant({ ...base, fetchImpl: p.fetchImpl });
    expect(t.refreshToken).toBe("refresh-old");
  });

  test("a public client sends no secret", async () => {
    const p = provider(() => Response.json({ access_token: "t" }));
    await refreshGrant({ ...base, fetchImpl: p.fetchImpl });
    expect(p.seen[0]!.body.has("client_secret")).toBe(false);
  });

  test("a confidential client sends its secret in the body", async () => {
    const p = provider(() => Response.json({ access_token: "t" }));
    await refreshGrant({ ...base, clientSecret: "shh", fetchImpl: p.fetchImpl });
    expect(p.seen[0]!.body.get("client_secret")).toBe("shh");
  });

  test("invalid_grant is a rejection that means reconnect", async () => {
    const p = provider(() => Response.json({ error: "invalid_grant", error_description: "token refresh-old revoked" }, { status: 400 }));
    const err = await refreshGrant({ ...base, fetchImpl: p.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(RefreshRejected);
    expect(err.oauthError).toBe("invalid_grant");
  });

  // The description above names the token. Nothing from the body but the
  // standard error code may reach a message.
  test("an error never carries the provider's body", async () => {
    const p = provider(() => Response.json({ error: "invalid_grant", error_description: "token refresh-old revoked" }, { status: 400 }));
    const err = await refreshGrant({ ...base, fetchImpl: p.fetchImpl }).catch((e) => e);
    expect(String(err.message)).not.toContain("refresh-old");
    expect(String(err.message)).not.toContain("revoked");
  });

  test("a server error is not a rejection: it may succeed on retry", async () => {
    const p = provider(() => new Response("upstream down", { status: 503 }));
    const err = await refreshGrant({ ...base, fetchImpl: p.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RefreshRejected);
    expect(String(err.message)).not.toContain("upstream down");
  });

  test("a success with no access token is an error", async () => {
    const p = provider(() => Response.json({ token_type: "bearer" }));
    await expect(refreshGrant({ ...base, fetchImpl: p.fetchImpl })).rejects.toThrow();
  });

  test("an unexpected error code is still a rejection only for 400 and 401", async () => {
    for (const status of [400, 401]) {
      const p = provider(() => Response.json({ error: "unauthorized_client" }, { status }));
      expect(await refreshGrant({ ...base, fetchImpl: p.fetchImpl }).catch((e) => e)).toBeInstanceOf(RefreshRejected);
    }
  });
});

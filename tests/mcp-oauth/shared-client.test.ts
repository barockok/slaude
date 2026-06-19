import { afterEach, describe, expect, test } from "bun:test";
import { beginConnectShared } from "../../src/agent/mcp-oauth/shared-client";
import { SharedLoopback } from "../../src/agent/mcp-oauth/shared-loopback";
import { verifyState } from "../../src/agent/mcp-oauth/state";
import type { FetchLike } from "../../src/agent/mcp-oauth/types";

const META = {
  authorizationEndpoint: "https://idp.example.com/authorize",
  tokenEndpoint: "https://idp.example.com/token",
  registrationEndpoint: "https://idp.example.com/register",
};
const SECRET = "state-secret";

/** Stub IdP: dynamic-registration returns a client_id; token endpoint returns a grant. */
function stubFetch(): FetchLike {
  return (async (url: string) => {
    const ok = (body: any) => ({ status: 200, headers: { get: () => null }, json: async () => body });
    if (url === META.registrationEndpoint) return ok({ client_id: "client-123" });
    if (url === META.tokenEndpoint) return ok({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as FetchLike;
}

let lb: SharedLoopback | undefined;
afterEach(async () => { await lb?.stop(); lb = undefined; });

async function begin(sid = "sess-1") {
  lb = new SharedLoopback({ port: 0 });
  await lb.start();
  const handle = await beginConnectShared({
    sessionId: sid,
    stateSecret: SECRET,
    serverName: "workbench",
    serverConfig: { type: "http", url: "https://mcp.example.com/sse" },
    meta: META,
    loopback: lb,
    fetchImpl: stubFetch(),
  });
  return handle;
}

function hit(lb: SharedLoopback, code: string, state: string) {
  return fetch(`http://127.0.0.1:${lb.port}${lb.callbackPath}?code=${code}&state=${encodeURIComponent(state)}`);
}

describe("beginConnectShared", () => {
  test("authorizeUrl carries signed state, PKCE S256, and the shared redirect_uri", async () => {
    const h = await begin("sess-1");
    const u = new URL(h.authorizeUrl);
    expect(u.origin + u.pathname).toBe(META.authorizationEndpoint);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(h.state);
    expect(u.searchParams.get("redirect_uri")).toBe(`http://localhost:${lb!.port}/callback`);
    // state decodes back to the session id
    expect(verifyState(h.state, SECRET)?.sid).toBe("sess-1");
  });

  test("the shared loopback routes the callback by state and exchange yields tokens", async () => {
    const h = await begin("sess-1");
    await hit(lb!, "THECODE", h.state);
    const code = await h.waitForCode();
    expect(code).toBe("THECODE");
    const tokens = await h.exchange(code);
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.clientId).toBe("client-123");
  });

  test("concurrent sessions get distinct state and are routed independently", async () => {
    lb = new SharedLoopback({ port: 0 });
    await lb.start();
    const mk = (sid: string) => beginConnectShared({
      sessionId: sid, stateSecret: SECRET, serverName: "wb",
      serverConfig: { type: "http", url: "https://mcp.example.com/sse" },
      meta: META, loopback: lb, fetchImpl: stubFetch(),
    });
    const h1 = await mk("sess-A");
    const h2 = await mk("sess-B");
    expect(h1.state).not.toBe(h2.state);
    await hit(lb, "codeB", h2.state);
    await hit(lb, "codeA", h1.state);
    expect(await h1.waitForCode()).toBe("codeA");
    expect(await h2.waitForCode()).toBe("codeB");
    expect(verifyState(h1.state, SECRET)?.sid).toBe("sess-A");
    expect(verifyState(h2.state, SECRET)?.sid).toBe("sess-B");
  });

  test("exchange surfaces a non-2xx token error", async () => {
    lb = new SharedLoopback({ port: 0 });
    await lb.start();
    const failFetch = (async (url: string) => {
      if (url === META.registrationEndpoint) return { status: 200, headers: { get: () => null }, json: async () => ({ client_id: "c" }) };
      return { status: 400, headers: { get: () => null }, json: async () => ({ error: "invalid_grant" }) };
    }) as unknown as FetchLike;
    const h = await beginConnectShared({
      sessionId: "s", stateSecret: SECRET, serverName: "wb",
      serverConfig: { type: "http", url: "https://mcp.example.com/sse" },
      meta: META, loopback: lb, fetchImpl: failFetch,
    });
    await expect(h.exchange("bad")).rejects.toThrow(/token exchange failed.*invalid_grant/i);
  });

  test("rejects metadata without a registration endpoint", async () => {
    lb = new SharedLoopback({ port: 0 });
    await lb.start();
    await expect(beginConnectShared({
      sessionId: "s", stateSecret: SECRET, serverName: "wb",
      serverConfig: { type: "http", url: "https://mcp.example.com/sse" },
      meta: { authorizationEndpoint: META.authorizationEndpoint, tokenEndpoint: META.tokenEndpoint },
      loopback: lb, fetchImpl: stubFetch(),
    })).rejects.toThrow(/registration/i);
  });
});

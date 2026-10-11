import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as policy from "../../src/net/outbound-policy";
import { OutboundBlockedError } from "../../src/net/outbound-policy";
import { discover } from "../../src/agent/mcp-oauth/discovery";
import { registerClient } from "../../src/agent/mcp-oauth/register";
import { exchangeAuthCode, prepareConnect } from "../../src/agent/mcp-oauth/client";
import { refreshGrant } from "../../src/agent/mcp-oauth/refresh";

/** WS-D D5.3: every OAuth fetch whose URL came from configuration or from a
 *  server's metadata goes through the outbound policy by default. */

const parts = (tokenEndpoint: string) => ({
  tokenEndpoint,
  redirectUri: "https://example.com/cb",
  clientId: "c",
  verifier: "v",
  resource: "https://mcp.example.com/mcp",
});

describe("OAuth flows refuse private targets by default", () => {
  test("discovery: a metadata-address server URL", async () => {
    await expect(discover("https://169.254.169.254/mcp")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  test("discovery: a plain-http server URL", async () => {
    await expect(discover("http://mcp.example.com/mcp")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  test("client registration: a private registration endpoint", async () => {
    await expect(registerClient("https://10.0.0.1/register", "https://example.com/cb")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  test("prepareConnect: a registration endpoint from hostile metadata", async () => {
    await expect(prepareConnect({
      serverName: "s",
      serverConfig: { type: "http", url: "https://mcp.example.com/mcp" },
      meta: { authorizationEndpoint: "https://auth.example.com/a", tokenEndpoint: "https://auth.example.com/t", registrationEndpoint: "https://192.168.0.10/register" },
      redirectUri: "https://example.com/cb",
    })).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  test("code exchange: a loopback token endpoint", async () => {
    await expect(exchangeAuthCode(parts("https://127.0.0.1/token"), "code")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  test("refresh: an IPv4-mapped metadata token endpoint", async () => {
    await expect(refreshGrant({
      tokenEndpoint: "https://[::ffff:169.254.169.254]/token",
      clientId: "c",
      refreshToken: "test-refresh",
      resource: "https://mcp.example.com/mcp",
    })).rejects.toBeInstanceOf(OutboundBlockedError);
  });
});

describe("OAuth flows call the policy module (spy)", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    new policy.SafeResponse(200, headers, Buffer.from(JSON.stringify(body)));

  test("discovery, registration, exchange and refresh all use outboundFetch", async () => {
    const urls: string[] = [];
    const spy = spyOn(policy, "outboundFetch").mockImplementation(async (url: string) => {
      urls.push(url);
      if (url === "https://mcp.example.com/mcp") return new policy.SafeResponse(401, { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' }, Buffer.from(""));
      if (url.endsWith("oauth-protected-resource")) return ok({ authorization_servers: ["https://auth.example.com"] });
      if (url.endsWith("oauth-authorization-server")) return ok({ authorization_endpoint: "https://auth.example.com/a", token_endpoint: "https://auth.example.com/t", registration_endpoint: "https://auth.example.com/r" });
      if (url.endsWith("/r")) return ok({ client_id: "cid" });
      return ok({ access_token: "test-access", refresh_token: "test-refresh" });
    });
    try {
      const meta = await discover("https://mcp.example.com/mcp");
      await registerClient(meta.registrationEndpoint!, "https://example.com/cb");
      await exchangeAuthCode(parts(meta.tokenEndpoint), "code");
      await refreshGrant({ tokenEndpoint: meta.tokenEndpoint, clientId: "cid", refreshToken: "test-refresh", resource: "https://mcp.example.com/mcp" });
    } finally {
      spy.mockRestore();
    }
    expect(urls).toEqual([
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/r",
      "https://auth.example.com/t",
      "https://auth.example.com/t",
    ]);
  });
});

describe("discovery does not follow a redirect", () => {
  let hits: string[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const p = new URL(req.url).pathname;
      hits.push(p);
      if (p === "/mcp") return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${server.port}/internal-admin` } });
      return new Response("nope", { status: 404 });
    },
  });
  const saved = process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK;
  afterEach(() => { hits = []; });
  afterAll(() => {
    server.stop(true);
    if (saved === undefined) delete process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK; else process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = saved;
  });

  test("a 307 from the MCP server is not chased to its target", async () => {
    process.env.SLAUDE_OUTBOUND_DEV_LOOPBACK = "1";
    await expect(discover(`http://127.0.0.1:${server.port}/mcp`)).rejects.toThrow(/did not advertise resource_metadata/);
    expect(hits).not.toContain("/internal-admin");
    expect(hits[0]).toBe("/mcp");
  });
});

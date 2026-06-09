import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { beginConnect, prepareConnect } from "../../../src/agent/mcp-oauth/client";

const META = {
  authorizationEndpoint: "https://as/authorize",
  tokenEndpoint: "https://as/token",
  registrationEndpoint: "https://as/register",
};

describe("prepareConnect (paste-back, no loopback)", () => {
  it("registers against the given redirect_uri and builds an authorize URL bound to it", async () => {
    let regBody: any; let tokenReq: any;
    const fetchImpl = async (url: string, init?: any) => {
      if (url === "https://as/register") { regBody = JSON.parse(init.body); return { status: 201, headers: { get: () => null }, json: async () => ({ client_id: "cid", client_secret: "csec" }) } as any; }
      if (url === "https://as/token") { tokenReq = init; return { status: 200, headers: { get: () => null }, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 99 }) } as any; }
      throw new Error("unexpected " + url);
    };
    const redirectUri = "https://slaude.example/oauth/paste";
    const prepared = await prepareConnect({
      serverName: "workbench",
      serverConfig: { type: "http", url: "https://mcp/", headers: {} },
      meta: META,
      redirectUri,
      fetchImpl: fetchImpl as any,
    });

    expect(regBody.redirect_uris).toEqual([redirectUri]);
    const au = new URL(prepared.authorizeUrl);
    expect(au.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(au.searchParams.get("code_challenge_method")).toBe("S256");
    expect(prepared.state).toBe(au.searchParams.get("state")!);

    const tokens = await prepared.exchange("CODE");
    expect(tokens).toMatchObject({ clientId: "cid", accessToken: "AT", refreshToken: "RT", expiresIn: 99 });
    const body = new URLSearchParams(tokenReq.body);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("code")).toBe("CODE");
    expect(body.get("code_verifier")).toBeTruthy();
  });
});

it("builds an authorize URL with PKCE+state, exchanges the code for tokens", async () => {
  let tokenReq: any;
  const fetchImpl = async (url: string, init?: any) => {
    if (url === "https://as/register") return { status: 201, headers: { get: () => null }, json: async () => ({ client_id: "cid", client_secret: "csec" }) } as any;
    if (url === "https://as/token") { tokenReq = init; return { status: 200, headers: { get: () => null }, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 1234 }) } as any; }
    throw new Error("unexpected " + url);
  };
  const handle = await beginConnect({
    serverName: "workbench",
    serverConfig: { type: "http", url: "https://mcp/", headers: {} },
    meta: META,
    loopbackHost: "127.0.0.1",
    timeoutMs: 2000,
    fetchImpl: fetchImpl as any,
  });

  const au = new URL(handle.authorizeUrl);
  expect(au.origin + au.pathname).toBe("https://as/authorize");
  expect(au.searchParams.get("response_type")).toBe("code");
  expect(au.searchParams.get("client_id")).toBe("cid");
  expect(au.searchParams.get("code_challenge_method")).toBe("S256");
  expect(au.searchParams.get("code_challenge")).toBeTruthy();
  const redirect = au.searchParams.get("redirect_uri")!;
  const state = au.searchParams.get("state")!;

  await fetch(`${redirect}?code=CODE123&state=${state}`);
  const code = await handle.waitForCode();
  expect(code).toBe("CODE123");

  const tokens = await handle.exchange(code);
  expect(tokens).toMatchObject({ clientId: "cid", clientSecret: "csec", accessToken: "AT", refreshToken: "RT", expiresIn: 1234 });
  const body = new URLSearchParams(tokenReq.body);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("CODE123");
  expect(body.get("code_verifier")).toBeTruthy();
  expect(body.get("redirect_uri")).toBe(redirect);

  const verifier = body.get("code_verifier")!;
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  expect(expectedChallenge).toBe(au.searchParams.get("code_challenge")!);
});

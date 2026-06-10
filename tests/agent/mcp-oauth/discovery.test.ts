import { describe, it, expect } from "bun:test";
import { discover } from "../../../src/agent/mcp-oauth/discovery";

function fetchStub(routes: Record<string, { status: number; headers?: Record<string,string>; body?: any }>) {
  return async (url: string) => {
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return {
      status: r.status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.body,
    } as any;
  };
}

const AS_META = {
  "https://as.example.com/.well-known/oauth-authorization-server": { status: 200, body: {
    authorization_endpoint: "https://as.example.com/authorize",
    token_endpoint: "https://as.example.com/token",
    registration_endpoint: "https://as.example.com/register",
  } },
};
const EXPECTED = {
  authorizationEndpoint: "https://as.example.com/authorize",
  tokenEndpoint: "https://as.example.com/token",
  registrationEndpoint: "https://as.example.com/register",
};

describe("discover", () => {
  it("walks 401 → resource metadata → AS metadata", async () => {
    const f = fetchStub({
      "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 200, body: { authorization_servers: ["https://as.example.com"] } },
      ...AS_META,
    });
    expect(await discover("https://mcp.example.com/", f as any)).toEqual(EXPECTED);
  });

  it("falls back to the path-aware well-known PRM when no WWW-Authenticate challenge", async () => {
    // workbench: bare GET on the MCP endpoint 404s with no challenge header, but it
    // serves protected-resource metadata at the RFC 9728 path-aware well-known URL.
    const f = fetchStub({
      "https://workbench.example/mcp": { status: 404, headers: {} },
      "https://workbench.example/.well-known/oauth-protected-resource/mcp": { status: 200, body: { authorization_servers: ["https://as.example.com"] } },
      ...AS_META,
    });
    expect(await discover("https://workbench.example/mcp", f as any)).toEqual(EXPECTED);
  });

  it("falls back to the root well-known PRM when the path-aware variant is absent", async () => {
    const f = fetchStub({
      "https://workbench.example/mcp": { status: 404, headers: {} },
      "https://workbench.example/.well-known/oauth-protected-resource/mcp": { status: 404 },
      "https://workbench.example/.well-known/oauth-protected-resource": { status: 200, body: { authorization_servers: ["https://as.example.com"] } },
      ...AS_META,
    });
    expect(await discover("https://workbench.example/mcp", f as any)).toEqual(EXPECTED);
  });

  it("throws a clear error when neither a challenge nor a well-known PRM exists", async () => {
    const f = fetchStub({
      "https://mcp.example.com/": { status: 404, headers: {} },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 404 },
    });
    await expect(discover("https://mcp.example.com/", f as any)).rejects.toThrow(/resource_metadata/);
  });

  it("throws a clear error when an advertised resource-metadata fetch returns 404", async () => {
    const f = fetchStub({
      "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 404 },
    });
    await expect(discover("https://mcp.example.com/", f as any)).rejects.toThrow(/metadata fetch failed/i);
  });
});

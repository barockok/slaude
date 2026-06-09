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

describe("discover", () => {
  it("walks 401 → resource metadata → AS metadata", async () => {
    const f = fetchStub({
      "https://mcp.example.com/": { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 200, body: { authorization_servers: ["https://as.example.com"] } },
      "https://as.example.com/.well-known/oauth-authorization-server": { status: 200, body: {
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        registration_endpoint: "https://as.example.com/register",
      } },
    });
    const meta = await discover("https://mcp.example.com/", f as any);
    expect(meta).toEqual({
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
      registrationEndpoint: "https://as.example.com/register",
    });
  });

  it("throws a clear error when the server does not advertise resource metadata", async () => {
    const f = fetchStub({ "https://mcp.example.com/": { status: 401, headers: {} } });
    await expect(discover("https://mcp.example.com/", f as any)).rejects.toThrow(/resource_metadata/);
  });
});

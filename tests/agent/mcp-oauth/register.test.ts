import { describe, it, expect } from "bun:test";
import { registerClient } from "../../../src/agent/mcp-oauth/register";

describe("registerClient", () => {
  it("POSTs redirect_uris + public-client metadata, returns client_id/secret", async () => {
    let seen: any;
    const f = async (_url: string, init: any) => { seen = JSON.parse(init.body); return {
      status: 201, headers: { get: () => null }, json: async () => ({ client_id: "abc", client_secret: "shh" }),
    } as any; };
    const out = await registerClient("https://as/register", "http://localhost:5599/callback", f as any);
    expect(out).toEqual({ clientId: "abc", clientSecret: "shh" });
    expect(seen.redirect_uris).toEqual(["http://localhost:5599/callback"]);
    expect(seen.token_endpoint_auth_method).toBe("none");
    expect(seen.grant_types).toContain("authorization_code");
    expect(seen.grant_types).toContain("refresh_token");
  });

  it("throws on non-2xx", async () => {
    const f = async () => ({ status: 400, headers: { get: () => null }, json: async () => ({ error: "invalid" }) } as any);
    await expect(registerClient("https://as/register", "http://localhost:1/callback", f as any)).rejects.toThrow(/registration failed/i);
  });

  it("throws when response has no client_id", async () => {
    const f = async () => ({ status: 201, headers: { get: () => null }, json: async () => ({}) } as any);
    await expect(registerClient("https://as/register", "http://localhost:1/callback", f as any)).rejects.toThrow(/missing client_id/i);
  });
});

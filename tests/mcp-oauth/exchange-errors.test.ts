/**
 * What a failed OAuth step is allowed to say.
 *
 * These messages are not log-only: gateway.ts posts `(e as Error).message` into
 * the Slack thread on a failed connect. A provider's error body can carry an
 * `error_description` naming a token, so the body must never travel with the
 * error — the status is what a person can act on.
 */
import { describe, expect, test } from "bun:test";
import { exchangeAuthCode } from "../../src/agent/mcp-oauth/client";
import { registerClient } from "../../src/agent/mcp-oauth/register";
import { beginConnectShared } from "../../src/agent/mcp-oauth/shared-client";
import type { ExchangeParts } from "../../src/agent/mcp-oauth/client";

// Stands in for what a provider can put in error_description. Deliberately
// not key-shaped: the point is that it must not travel, not what it looks like.
const LEAK = "the-token-this-message-must-never-carry";

const PARTS: ExchangeParts = {
  tokenEndpoint: "https://auth.example.com/token",
  redirectUri: "http://127.0.0.1:9/cb",
  clientId: "client-1",
  clientSecret: "cs-1",
  verifier: "v-1",
  resource: "https://mcp.example.com/mcp",
};

const failing = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("a failed token exchange", () => {
  test("reports the status and never the provider's body", async () => {
    const err = await exchangeAuthCode(PARTS, "code-1", failing(400, { error: "invalid_grant", error_description: LEAK }))
      .then(() => null, (e: Error) => e);

    expect(err).not.toBeNull();
    expect(err!.message).toContain("400");
    expect(err!.message).not.toContain(LEAK);
    expect(err!.message).not.toContain("invalid_grant");
  });
});

describe("a failed client registration", () => {
  test("reports the status and never the provider's body", async () => {
    const err = await registerClient("https://auth.example.com/register", "http://127.0.0.1:9/cb", failing(403, {
      error: "access_denied",
      error_description: LEAK,
    })).then(() => null, (e: Error) => e);

    expect(err).not.toBeNull();
    expect(err!.message).toContain("403");
    expect(err!.message).not.toContain(LEAK);
  });
});

/**
 * The shared-loopback path had its own copy of the exchange, which did echo the
 * body. Both connect paths must redeem a code through one implementation, or a
 * rule enforced on one is silently absent from the other.
 */
describe("the shared-loopback connect path", () => {
  test("redeems a code through the same exchange, and leaks no body either", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/register")) {
        return new Response(JSON.stringify({ client_id: "c-1", client_secret: "cs-1" }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: LEAK }), { status: 400 });
    }) as unknown as typeof fetch;

    const handle = await beginConnectShared({
      sessionId: "s-1",
      stateSecret: "x".repeat(32),
      serverName: "workbench",
      serverConfig: { type: "http", url: "https://mcp.example.com/mcp" },
      meta: {
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: "https://auth.example.com/register",
      } as any,
      loopback: {
        start: async () => {},
        register: () => ({ redirectUri: "http://127.0.0.1:9/cb", waitForCode: async () => "code-1" }),
      } as any,
      fetchImpl,
    });

    const err = await handle.exchange("code-1").then(() => null, (e: Error) => e);

    expect(err).not.toBeNull();
    expect(err!.message).toContain("400");
    expect(err!.message).not.toContain(LEAK);
    expect(err!.message).not.toContain("invalid_grant");
  });
});

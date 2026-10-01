/**
 * The portal's own OAuth round trip.
 *
 * The property that matters is that no part of the flow rests anywhere the
 * browser can read it, and that the callback can be completed exactly once, by
 * the account that started it, with the state it was issued.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import type { ExchangeParts, PreparedConnect } from "../../../src/agent/mcp-oauth/client";
import {
  finishPortalConnect,
  startPortalConnect,
  type PortalConnectDeps,
} from "../../../src/gateway/portal/oauth";
import {
  mintPortalOauthFlow,
  verifyPortalOauthFlow,
} from "../../../src/gateway/portal/session";
import { decodeJwt } from "../../../src/gateway/auth/jwt";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);
const cfg = { type: "http", url: "https://mcp.example.com/mcp" } as const;
const KEY = oauthKey("workbench", cfg);

const PARTS: ExchangeParts = {
  tokenEndpoint: "https://auth.example.com/token",
  redirectUri: "https://slaude.example.com/portal/oauth/callback",
  clientId: "client-1",
  clientSecret: "registered-secret",
  verifier: "pkce-verifier",
  resource: cfg.url,
};

/** A prepare that registers nothing and a exchange that talks to nobody. */
function deps(over: Partial<PortalConnectDeps> = {}): PortalConnectDeps {
  return {
    prepare: async ({ redirectUri }) =>
      ({
        authorizeUrl: `https://auth.example.com/authorize?state=st-1&redirect_uri=${encodeURIComponent(redirectUri)}`,
        state: "st-1",
        parts: { ...PARTS, redirectUri },
        exchange: async () => {
          throw new Error("the portal must not use the in-process closure");
        },
      }) as PreparedConnect,
    exchange: async (parts, code) => {
      if (code !== "good-code") throw new Error("token exchange failed (status 400)");
      return {
        clientId: parts.clientId,
        clientSecret: parts.clientSecret,
        accessToken: "tok-1",
        refreshToken: "r-1",
        tokenEndpoint: parts.tokenEndpoint,
        expiresIn: 3600,
      };
    },
    ...over,
  };
}

let accountId: string;
let otherAccountId: string;

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM portal_oauth_flows");
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  accountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-1", email: "a@example.com" })).id;
  otherAccountId = (await Accounts.upsertAccount({ issuer: ISS, subject: "sub-2", email: "b@example.com" })).id;
});

const start = () => startPortalConnect(accountId, "workbench", cfg, deps());

describe("starting a portal connect", () => {
  test("returns an authorize URL and stores the flow it belongs to", async () => {
    const r = await start();
    expect(r.authorizeUrl).toContain("state=st-1");
    const rows = await db.query<{ account_id: string }>("SELECT account_id FROM portal_oauth_flows");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBe(accountId);
  });

  test("the redirect URI is the portal's own callback on the deployment's public URL", async () => {
    const r = await start();
    expect(r.authorizeUrl).toContain(encodeURIComponent("https://slaude.example.com/portal/oauth/callback"));
  });

  // The whole reason the flow row exists: a cookie payload is readable.
  test("the flow cookie carries the row id and nothing else", async () => {
    const r = await start();
    const token = mintPortalOauthFlow(r.flowId);
    const decoded = decodeJwt<Record<string, unknown>>(token, SECRET, Date.now());
    expect(decoded.ok).toBe(true);
    expect(Object.keys((decoded as any).payload).sort()).toEqual(["exp", "fid", "iat", "typ"]);
    expect(JSON.stringify((decoded as any).payload)).not.toContain("registered-secret");
    expect(JSON.stringify((decoded as any).payload)).not.toContain("pkce-verifier");
    expect(verifyPortalOauthFlow(token)).toEqual({ ok: true, flowId: r.flowId });
  });
});

describe("finishing a portal connect", () => {
  test("writes the credential for that account, token endpoint pinned", async () => {
    const r = await start();
    const done = await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps());

    expect(done).toEqual({ ok: true, serverName: "workbench" });
    const entry = (await Creds.credentialsFor({ kind: "account", accountId }))[KEY]!;
    expect(entry.accessToken).toBe("tok-1");
    expect(entry.tokenEndpoint).toBe("https://auth.example.com/token");
  });

  // oauthKey hashes type, url AND headers. A config rebuilt from the URL alone
  // would file the credential under a key no session ever looks up, and the
  // connect would appear to succeed while nothing worked.
  test("the credential is keyed on the whole configured server, headers included", async () => {
    const withHeaders = { type: "http", url: cfg.url, headers: { "x-api-key": "static-key" } };
    const r = await startPortalConnect(accountId, "workbench", withHeaders, deps());
    expect((await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps())).ok).toBe(true);

    const held = await Creds.credentialsFor({ kind: "account", accountId });
    expect(Object.keys(held)).toEqual([oauthKey("workbench", withHeaders)]);
    expect(Object.keys(held)).not.toContain(KEY);
  });

  test("a mismatched state writes nothing", async () => {
    const r = await start();
    const done = await finishPortalConnect(accountId, r.flowId, "good-code", "forged", deps());

    expect(done).toEqual({ ok: false, reason: "state-mismatch" });
    expect(await Creds.credentialsFor({ kind: "account", accountId })).toEqual({});
  });

  // A mismatched state still consumes the flow: the authorization it was for is
  // no longer trustworthy, so it must not be retryable.
  test("a mismatched state consumes the flow", async () => {
    const r = await start();
    await finishPortalConnect(accountId, r.flowId, "good-code", "forged", deps());
    expect(await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps())).toEqual({
      ok: false,
      reason: "no-flow",
    });
  });

  test("a replayed callback finds no flow and writes nothing", async () => {
    const r = await start();
    expect((await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps())).ok).toBe(true);
    await db.run("DELETE FROM mcp_credentials");

    expect(await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps())).toEqual({
      ok: false,
      reason: "no-flow",
    });
    expect(await Creds.credentialsFor({ kind: "account", accountId })).toEqual({});
  });

  test("one account cannot finish another's flow", async () => {
    const r = await start();
    expect(await finishPortalConnect(otherAccountId, r.flowId, "good-code", "st-1", deps())).toEqual({
      ok: false,
      reason: "no-flow",
    });
    expect(await Creds.credentialsFor({ kind: "account", accountId: otherAccountId })).toEqual({});
    // And it did not consume the real owner's flow.
    expect((await finishPortalConnect(accountId, r.flowId, "good-code", "st-1", deps())).ok).toBe(true);
  });

  test("an unknown flow id is refused", async () => {
    expect(await finishPortalConnect(accountId, "no-such-flow", "good-code", "st-1", deps())).toEqual({
      ok: false,
      reason: "no-flow",
    });
  });

  test("a failed exchange reports failure, with no provider body and no credential", async () => {
    const r = await start();
    const done = await finishPortalConnect(accountId, r.flowId, "bad-code", "st-1", deps());

    expect(done.ok).toBe(false);
    expect(JSON.stringify(done)).not.toContain("status 400");
    expect((done as { reason: string }).reason).toBe("exchange-failed");
    expect(await Creds.credentialsFor({ kind: "account", accountId })).toEqual({});
  });
});

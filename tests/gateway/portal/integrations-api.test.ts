/**
 * The portal's integrations API.
 *
 * Two boundaries are load-bearing here: the owner is always the signed-in
 * account and never anything the request names, and no response carries a token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../src/db/schema";
import * as Accounts from "../../../src/db/accounts";
import * as Creds from "../../../src/db/mcp-credentials";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { oauthKey } from "../../../src/agent/mcp-oauth/store";
import { createPortalApi, type PortalApiDeps } from "../../../src/gateway/portal/api";
import {
  mintPortalOauthFlow,
  mintPortalSession,
  PORTAL_AT_COOKIE,
  PORTAL_OAUTH_COOKIE,
} from "../../../src/gateway/portal/session";
import type { ExchangeParts, PreparedConnect } from "../../../src/agent/mcp-oauth/client";

const ISS = "https://idp.example.com";
const SECRET = "g".repeat(32);
const SERVERS = {
  workbench: { type: "http", url: "https://mcp.example.com/mcp" },
  calendar: { type: "http", url: "https://cal.example.com/mcp" },
} as const;
const KEY = oauthKey("workbench", SERVERS.workbench);

const PARTS: ExchangeParts = {
  tokenEndpoint: "https://auth.example.com/token",
  redirectUri: "https://slaude.example.com/portal/oauth/callback",
  clientId: "client-1",
  clientSecret: "registered-secret",
  verifier: "pkce-verifier",
  resource: SERVERS.workbench.url,
};

const deps = (over: Partial<PortalApiDeps> = {}): PortalApiDeps => ({
  servers: () => ({ ...SERVERS }),
  connect: {
    prepare: async ({ redirectUri }) =>
      ({
        authorizeUrl: "https://auth.example.com/authorize?state=st-1",
        state: "st-1",
        parts: { ...PARTS, redirectUri },
        exchange: async () => {
          throw new Error("unused");
        },
      }) as PreparedConnect,
    exchange: async (parts, code) => {
      if (code !== "good-code") throw new Error("token exchange failed (status 400)");
      return {
        clientId: parts.clientId,
        accessToken: "tok-1",
        refreshToken: "r-1",
        tokenEndpoint: parts.tokenEndpoint,
        expiresIn: 3600,
      };
    },
  },
  ...over,
});

const signedIn = (sub: string) => `${PORTAL_AT_COOKIE}=${mintPortalSession({ sub, email: `${sub}@example.com`, iss: ISS }, "portal_at")}`;

function req(path: string, init: RequestInit & { cookie?: string; csrf?: boolean } = {}): Request {
  const { cookie, csrf = true, ...rest } = init;
  return new Request(`https://slaude.example.com${path}`, {
    ...rest,
    headers: {
      ...(rest.method && rest.method !== "GET" && csrf ? { "x-portal-csrf": "1" } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
}

let aliceId: string;
let bobId: string;

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISS;
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await db.run("DELETE FROM portal_oauth_flows");
  await db.run("DELETE FROM mcp_credentials");
  await Accounts._wipeForTests();
  aliceId = (await Accounts.upsertAccount({ issuer: ISS, subject: "alice", email: "alice@example.com" })).id;
  bobId = (await Accounts.upsertAccount({ issuer: ISS, subject: "bob", email: "bob@example.com" })).id;
});

const entry = (token: string) => ({
  serverName: "workbench",
  serverUrl: SERVERS.workbench.url,
  accessToken: token,
  refreshToken: "r-1",
  expiresAt: Date.now() + 3600_000,
});

describe("GET /portal/api/integrations", () => {
  test("lists every configured server and marks which this account holds", async () => {
    await Creds.putCredential({ kind: "account", accountId: aliceId }, KEY, entry("tok-alice"));

    const res = await createPortalApi(deps()).fetch(req("/portal/api/integrations", { cookie: signedIn("alice") }));
    const body = (await res!.json()) as any;

    expect(body.integrations.map((i: any) => [i.name, i.connected])).toEqual([
      ["calendar", false],
      ["workbench", true],
    ]);
  });

  test("contains no token", async () => {
    await Creds.putCredential({ kind: "account", accountId: aliceId }, KEY, entry("tok-alice"));

    const res = await createPortalApi(deps()).fetch(req("/portal/api/integrations", { cookie: signedIn("alice") }));

    expect(await res!.text()).not.toContain("tok-alice");
  });

  test("another account's credential is not reported as mine", async () => {
    await Creds.putCredential({ kind: "account", accountId: bobId }, KEY, entry("tok-bob"));

    const res = await createPortalApi(deps()).fetch(req("/portal/api/integrations", { cookie: signedIn("alice") }));
    const body = (await res!.json()) as any;

    expect(body.integrations.every((i: any) => !i.connected)).toBe(true);
  });

  test("an anonymous caller is refused", async () => {
    const res = await createPortalApi(deps()).fetch(req("/portal/api/integrations"));
    expect(res!.status).toBe(401);
  });

  test("a deployment with no configured servers reports an empty list, not an error", async () => {
    const res = await createPortalApi(deps({ servers: () => ({}) })).fetch(
      req("/portal/api/integrations", { cookie: signedIn("alice") }),
    );
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).integrations).toEqual([]);
  });
});

describe("POST /portal/api/integrations/:name/connect", () => {
  const connect = (name: string, init: Parameters<typeof req>[1] = {}) =>
    req(`/portal/api/integrations/${name}/connect`, { method: "POST", ...init });

  test("returns an authorize URL and sets the flow cookie", async () => {
    const res = await createPortalApi(deps()).fetch(connect("workbench", { cookie: signedIn("alice") }));

    expect(((await res!.json()) as any).authorizeUrl).toContain("https://auth.example.com/authorize");
    const setCookie = res!.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${PORTAL_OAUTH_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/portal/oauth");
  });

  test("no secret reaches the browser", async () => {
    const res = await createPortalApi(deps()).fetch(connect("workbench", { cookie: signedIn("alice") }));

    const wire = (await res!.text()) + res!.headers.get("set-cookie");
    for (const secret of ["registered-secret", "pkce-verifier"]) {
      expect(wire).not.toContain(secret);
      // …nor base64-encoded inside the cookie's JWT payload.
      expect(wire).not.toContain(Buffer.from(secret).toString("base64url"));
    }
  });

  test("a server this deployment does not configure is refused", async () => {
    const res = await createPortalApi(deps()).fetch(connect("not-configured", { cookie: signedIn("alice") }));
    expect(res!.status).toBe(404);
    expect(await db.query("SELECT id FROM portal_oauth_flows")).toHaveLength(0);
  });

  test("a request without the anti-CSRF header is refused before anything happens", async () => {
    const res = await createPortalApi(deps()).fetch(connect("workbench", { cookie: signedIn("alice"), csrf: false }));
    expect(res!.status).toBe(403);
    expect(await db.query("SELECT id FROM portal_oauth_flows")).toHaveLength(0);
  });

  test("an anonymous caller is refused and starts no flow", async () => {
    const res = await createPortalApi(deps()).fetch(connect("workbench"));
    expect(res!.status).toBe(401);
    expect(await db.query("SELECT id FROM portal_oauth_flows")).toHaveLength(0);
  });
});

describe("GET /portal/oauth/callback", () => {
  async function startedFlow(api = createPortalApi(deps())): Promise<string> {
    const res = await api.fetch(
      req("/portal/api/integrations/workbench/connect", { method: "POST", cookie: signedIn("alice") }),
    );
    return res!.headers.get("set-cookie")!.split(";")[0]!.split("=").slice(1).join("=");
  }

  const callback = (params: string, cookie: string) =>
    req(`/portal/oauth/callback?${params}`, { cookie });

  test("a good callback stores the credential and redirects back into the app", async () => {
    const api = createPortalApi(deps());
    const flowCookie = await startedFlow(api);

    const res = await api.fetch(callback("code=good-code&state=st-1", `${signedIn("alice")}; ${PORTAL_OAUTH_COOKIE}=${flowCookie}`));

    expect(res!.status).toBe(302);
    expect(res!.headers.get("location")).toBe("/portal?connect=connected");
    expect(res!.headers.get("set-cookie")).toContain(`${PORTAL_OAUTH_COOKIE}=;`);
    expect(Object.keys(await Creds.credentialsFor({ kind: "account", accountId: aliceId }))).toEqual([KEY]);
  });

  test("a mismatched state redirects with a result and writes nothing", async () => {
    const api = createPortalApi(deps());
    const flowCookie = await startedFlow(api);

    const res = await api.fetch(callback("code=good-code&state=forged", `${signedIn("alice")}; ${PORTAL_OAUTH_COOKIE}=${flowCookie}`));

    expect(res!.headers.get("location")).toBe("/portal?connect=state-mismatch");
    expect(await Creds.credentialsFor({ kind: "account", accountId: aliceId })).toEqual({});
  });

  test("a replayed callback writes nothing the second time", async () => {
    const api = createPortalApi(deps());
    const flowCookie = await startedFlow(api);
    const jar = `${signedIn("alice")}; ${PORTAL_OAUTH_COOKIE}=${flowCookie}`;

    await api.fetch(callback("code=good-code&state=st-1", jar));
    await db.run("DELETE FROM mcp_credentials");
    const res = await api.fetch(callback("code=good-code&state=st-1", jar));

    expect(res!.headers.get("location")).toBe("/portal?connect=no-flow");
    expect(await Creds.credentialsFor({ kind: "account", accountId: aliceId })).toEqual({});
  });

  test("another account cannot finish this flow", async () => {
    const api = createPortalApi(deps());
    const flowCookie = await startedFlow(api);

    const res = await api.fetch(callback("code=good-code&state=st-1", `${signedIn("bob")}; ${PORTAL_OAUTH_COOKIE}=${flowCookie}`));

    expect(res!.headers.get("location")).toBe("/portal?connect=no-flow");
    expect(await Creds.credentialsFor({ kind: "account", accountId: bobId })).toEqual({});
  });

  test("no flow cookie reports an expired flow rather than an error page", async () => {
    const res = await createPortalApi(deps()).fetch(callback("code=good-code&state=st-1", signedIn("alice")));
    expect(res!.headers.get("location")).toBe("/portal?connect=expired");
  });

  test("a forged flow cookie is refused", async () => {
    const forged = mintPortalOauthFlow("some-flow-id", { secret: "z".repeat(32) });
    const res = await createPortalApi(deps()).fetch(
      callback("code=good-code&state=st-1", `${signedIn("alice")}; ${PORTAL_OAUTH_COOKIE}=${forged}`),
    );
    expect(res!.headers.get("location")).toBe("/portal?connect=expired");
  });

  test("a failed exchange reports failure without the provider's body", async () => {
    const api = createPortalApi(deps());
    const flowCookie = await startedFlow(api);

    const res = await api.fetch(callback("code=bad-code&state=st-1", `${signedIn("alice")}; ${PORTAL_OAUTH_COOKIE}=${flowCookie}`));

    expect(res!.headers.get("location")).toBe("/portal?connect=exchange-failed");
    expect(res!.headers.get("location")).not.toContain("400");
    expect(await Creds.credentialsFor({ kind: "account", accountId: aliceId })).toEqual({});
  });
});

describe("DELETE /portal/api/integrations/:name", () => {
  const disconnect = (name: string, init: Parameters<typeof req>[1] = {}) =>
    req(`/portal/api/integrations/${name}`, { method: "DELETE", ...init });

  test("removes the caller's own credential", async () => {
    await Creds.putCredential({ kind: "account", accountId: aliceId }, KEY, entry("tok-alice"));

    const res = await createPortalApi(deps()).fetch(disconnect("workbench", { cookie: signedIn("alice") }));

    expect(await res!.json()).toEqual({ ok: true, removed: true });
    expect(await Creds.credentialsFor({ kind: "account", accountId: aliceId })).toEqual({});
  });

  test("leaves another account's credential alone", async () => {
    await Creds.putCredential({ kind: "account", accountId: bobId }, KEY, entry("tok-bob"));

    await createPortalApi(deps()).fetch(disconnect("workbench", { cookie: signedIn("alice") }));

    expect(Object.keys(await Creds.credentialsFor({ kind: "account", accountId: bobId }))).toEqual([KEY]);
  });

  test("reports plainly when there was nothing to remove", async () => {
    const res = await createPortalApi(deps()).fetch(disconnect("workbench", { cookie: signedIn("alice") }));
    expect(await res!.json()).toEqual({ ok: true, removed: false });
  });

  test("is refused without the anti-CSRF header", async () => {
    await Creds.putCredential({ kind: "account", accountId: aliceId }, KEY, entry("tok-alice"));

    const res = await createPortalApi(deps()).fetch(disconnect("workbench", { cookie: signedIn("alice"), csrf: false }));

    expect(res!.status).toBe(403);
    expect(Object.keys(await Creds.credentialsFor({ kind: "account", accountId: aliceId }))).toEqual([KEY]);
  });
});

describe("with the portal disabled", () => {
  beforeEach(() => {
    process.env.SLAUDE_PORTAL = "";
  });
  // Restored, or the next test file inherits a disabled portal.
  afterEach(() => {
    process.env.SLAUDE_PORTAL = "1";
  });

  test("every integrations route falls through as if it did not exist", async () => {
    const api = createPortalApi(deps());
    for (const r of [
      req("/portal/api/integrations", { cookie: signedIn("alice") }),
      req("/portal/api/integrations/workbench/connect", { method: "POST", cookie: signedIn("alice") }),
      req("/portal/api/integrations/workbench", { method: "DELETE", cookie: signedIn("alice") }),
      req("/portal/oauth/callback?code=good-code&state=st-1", { cookie: signedIn("alice") }),
    ]) {
      expect(await api.fetch(r)).toBeNull();
    }
  });
});

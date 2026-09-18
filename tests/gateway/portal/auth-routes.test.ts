/**
 * Portal sign-in. Same identity provider as the panel, same signing secret, a
 * second callback — and deliberately NO role check: any identity the provider
 * authenticates is a legitimate portal user. An account on its own grants
 * nothing; it becomes useful only once a Slack identity is bound to it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createPortalAuthRoutes } from "../../../src/gateway/portal/auth-routes";
import { __resetDiscoveryCache } from "../../../src/gateway/panel/auth/oidc";
import {
  PORTAL_AT_COOKIE,
  PORTAL_FLOW_COOKIE,
  parseCookies,
  verifyPortalSession,
} from "../../../src/gateway/portal/session";
import * as Accounts from "../../../src/db/accounts";

const ISSUER = "https://idp.example.com/realms/slaude";
const SECRET = "p".repeat(32);
const DISCO = {
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
};

const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (c: Record<string, unknown>) => `${b({ alg: "RS256" })}.${b(c)}.sig`;

function stubIdp(opts: { email?: string; sub?: string; nonceRef: { value: string } }) {
  return (async (url: string | URL) => {
    const s = String(url);
    if (s.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(DISCO), { status: 200 });
    }
    if (s === DISCO.token_endpoint) {
      return new Response(
        JSON.stringify({
          id_token: idToken({
            iss: ISSUER,
            aud: "slaude-panel",
            sub: opts.sub ?? "sub-1",
            email: opts.email ?? "alice@example.com",
            nonce: opts.nonceRef.value,
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${s}`);
  }) as unknown as typeof fetch;
}

const seg = (p: string) => p.split("?")[0]!.split("/").filter(Boolean);
const call = (routes: ReturnType<typeof createPortalAuthRoutes>, path: string, init?: RequestInit) =>
  routes.handle(new Request(`https://slaude.example.com${path}`, init), seg(path));

/** Drive login → callback, returning the callback response. */
async function completeLogin(
  opts: { email?: string; sub?: string; returnTo?: string; tamperState?: boolean } = {},
) {
  const nonceRef = { value: "" };
  const routes = createPortalAuthRoutes({ fetchImpl: stubIdp({ ...opts, nonceRef }) });
  const loginPath = opts.returnTo
    ? `/portal/auth/login?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/portal/auth/login";
  const start = (await call(routes, loginPath))!;
  const authorize = new URL(start.headers.get("location")!);
  nonceRef.value = authorize.searchParams.get("nonce")!;
  const state = opts.tamperState ? "not-the-state" : authorize.searchParams.get("state")!;
  const flow = parseCookies(start.headers.get("set-cookie"))[PORTAL_FLOW_COOKIE]!;
  const res = (await call(routes, `/portal/auth/callback?code=C&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${PORTAL_FLOW_COOKIE}=${flow}` },
  }))!;
  return { routes, res, start };
}

beforeEach(async () => {
  process.env.SLAUDE_PORTAL = "1";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISSUER;
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "s3cret";
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://slaude.example.com";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  __resetDiscoveryCache();
  await Accounts._wipeForTests();
});

describe("portal auth routes", () => {
  test("login redirects to the provider and sets the flow cookie", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp({ nonceRef: { value: "" } }) });
    const res = (await call(routes, "/portal/auth/login"))!;

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(ISSUER);
    expect(res.headers.get("set-cookie")).toContain(PORTAL_FLOW_COOKIE);
  });

  test("the authorize request uses the portal callback, not the panel's", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp({ nonceRef: { value: "" } }) });
    const res = (await call(routes, "/portal/auth/login"))!;

    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("redirect_uri")).toBe("https://slaude.example.com/portal/auth/callback");
  });

  // The decisive difference from the panel, which 403s an identity in no role
  // list. Onboarding unlocks connected tools; it never gates the agent.
  test("an identity in no operator role list is still granted a portal session", async () => {
    process.env.SLAUDE_PANEL_SUPERADMIN = "";
    process.env.SLAUDE_PANEL_OPERATORS = "";

    const { res } = await completeLogin();

    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().join("; ")).toContain(PORTAL_AT_COOKIE);
  });

  test("a successful login creates the account row", async () => {
    await completeLogin({ email: "alice@example.com", sub: "sub-1" });

    const account = await Accounts.findAccountBySubject(ISSUER, "sub-1");
    expect(account?.email).toBe("alice@example.com");
  });

  test("logging in twice keeps one account and refreshes the email", async () => {
    await completeLogin({ email: "alice@example.com", sub: "sub-1" });
    await completeLogin({ email: "alice.new@example.com", sub: "sub-1" });

    const account = await Accounts.findAccountBySubject(ISSUER, "sub-1");
    expect(account?.email).toBe("alice.new@example.com");
  });

  test("the session cookie carries the portal token type", async () => {
    const { res } = await completeLogin();

    const jar = parseCookies(res.headers.getSetCookie().join("; "));
    const verified = verifyPortalSession(jar[PORTAL_AT_COOKIE], "portal_at");
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims.iss).toBe(ISSUER);
  });

  test("a state mismatch is refused", async () => {
    const { res } = await completeLogin({ tamperState: true });

    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().join("; ")).not.toContain(PORTAL_AT_COOKIE);
  });

  test("returnTo is confined to the portal", async () => {
    const { res } = await completeLogin({ returnTo: "https://evil.example.com/" });

    expect(res.headers.get("location")).toBe("/portal");
  });

  test("returnTo inside the portal is honoured, so a link survives login", async () => {
    const { res } = await completeLogin({ returnTo: "/portal/link?t=abc" });

    expect(res.headers.get("location")).toBe("/portal/link?t=abc");
  });

  test("me reports the signed-in account, not a role", async () => {
    const { routes, res } = await completeLogin();
    const jar = parseCookies(res.headers.getSetCookie().join("; "));

    const me = (await call(routes, "/portal/auth/me", {
      headers: { cookie: `${PORTAL_AT_COOKIE}=${jar[PORTAL_AT_COOKIE]}` },
    }))!;

    expect(me.status).toBe(200);
    const body = (await me.json()) as any;
    expect(body.email).toBe("alice@example.com");
    expect(body.accountId).toBeTruthy();
    expect(body.role).toBeUndefined();
  });

  test("me refuses an anonymous caller", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp({ nonceRef: { value: "" } }) });
    const me = (await call(routes, "/portal/auth/me"))!;
    expect(me.status).toBe(401);
  });

  test("paths outside /portal/auth are not handled here", async () => {
    const routes = createPortalAuthRoutes({ fetchImpl: stubIdp({ nonceRef: { value: "" } }) });
    expect(await call(routes, "/portal/api/me")).toBeNull();
  });
});

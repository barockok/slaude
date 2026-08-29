import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { createAuthRoutes, safeReturnTo } from "../../src/gateway/panel/auth/routes";
import { __resetDiscoveryCache } from "../../src/gateway/panel/auth/oidc";
import { __resetRoleCache } from "../../src/gateway/panel/auth/roles";
import { mintSession, parseCookies } from "../../src/gateway/panel/auth/session";

const ISSUER = "https://idp.example.com/realms/slaude";
const SECRET = "k".repeat(32);
const DISCO = {
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
};

const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (c: Record<string, unknown>) => `${b({ alg: "RS256" })}.${b(c)}.sig`;

/** Stub provider: serves discovery, then a token response built from the nonce
 *  the panel put in the authorize URL. */
function stubIdp(opts: { email?: string; nonceRef: { value: string } }) {
  return (async (url: string | URL) => {
    const s = String(url);
    if (s.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(DISCO), { status: 200 });
    }
    if (s === DISCO.token_endpoint) {
      return new Response(
        JSON.stringify({
          id_token: idToken({
            iss: ISSUER, aud: "slaude-panel", sub: "sub-1",
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

// Corrected: the brief's `p.split("/").filter(Boolean)` splits the query
// string along with the path, so `/panel/auth/callback?code=C&state=X`
// yields `seg[2] === "callback?code=C&state=X"`, which never matches the
// route switch. Production code splits `url.pathname`, which carries no
// query — the test helper must mirror that.
const seg = (p: string) => p.split("?")[0]!.split("/").filter(Boolean);
const call = (routes: ReturnType<typeof createAuthRoutes>, path: string, init?: RequestInit) =>
  routes.handle(new Request(`https://panel.example.com${path}`, init), seg(path));

/** Drive login → callback, returning the callback response. */
async function login(email = "alice@example.com") {
  const nonceRef = { value: "" };
  const routes = createAuthRoutes({ fetchImpl: stubIdp({ email, nonceRef }) });
  const start = (await call(routes, "/panel/auth/login"))!;
  const authorize = new URL(start.headers.get("location")!);
  nonceRef.value = authorize.searchParams.get("nonce")!;
  const state = authorize.searchParams.get("state")!;
  const flow = parseCookies(start.headers.get("set-cookie"))["panel_flow"]!;
  const cb = (await call(routes, `/panel/auth/callback?code=C&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `panel_flow=${flow}` },
  }))!;
  return { routes, cb, state, flow };
}

beforeEach(() => {
  process.env.SLAUDE_PANEL = "1";
  process.env.SLAUDE_PANEL_OIDC_ISSUER = ISSUER;
  process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
  process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "s3cret";
  process.env.SLAUDE_PANEL_PUBLIC_URL = "https://panel.example.com";
  process.env.SLAUDE_PANEL_SECRET = SECRET;
  process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
  process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("SLAUDE_PANEL")) delete process.env[k];
  __resetDiscoveryCache();
  __resetRoleCache();
});

describe("route matching", () => {
  it("ignores paths outside /panel/auth", async () => {
    const routes = createAuthRoutes();
    expect(await call(routes, "/panel/api/sessions")).toBeNull();
  });
});

describe("login", () => {
  it("redirects to the provider and sets a flow cookie", async () => {
    const nonceRef = { value: "" };
    const routes = createAuthRoutes({ fetchImpl: stubIdp({ nonceRef }) });
    const res = (await call(routes, "/panel/auth/login"))!;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(DISCO.authorization_endpoint);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("panel_flow=");
    expect(setCookie).toContain("Path=/panel/auth");
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("callback", () => {
  it("mints both cookies and redirects into the app", async () => {
    const { cb } = await login();
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/panel");
    const cookies = cb.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=");
    expect(cookies).toContain("panel_rt=");
    expect(cookies).toContain("Path=/panel/auth/refresh");
    expect(cookies).toContain("panel_flow=; Max-Age=0");
  });

  it("refuses an unlisted identity with 403 and no session cookies", async () => {
    const { cb } = await login("eve@example.com");
    expect(cb.status).toBe(403);
    expect(cb.headers.getSetCookie().join("\n")).not.toContain("panel_at=");
  });

  it("refuses a state that does not match the flow cookie", async () => {
    const { routes, flow } = await login();
    const res = (await call(routes, "/panel/auth/callback?code=C&state=forged", {
      headers: { cookie: `panel_flow=${flow}` },
    }))!;
    expect(res.status).toBe(400);
  });

  it("refuses a replayed state once the flow cookie is gone", async () => {
    const { routes, state } = await login();
    const res = (await call(routes, `/panel/auth/callback?code=C&state=${encodeURIComponent(state)}`))!;
    expect(res.status).toBe(400);
  });

  it("refuses a callback with no code", async () => {
    const { routes, state, flow } = await login();
    const res = (await call(routes, `/panel/auth/callback?state=${encodeURIComponent(state)}`, {
      headers: { cookie: `panel_flow=${flow}` },
    }))!;
    expect(res.status).toBe(400);
  });
});

describe("returnTo", () => {
  it("keeps a same-origin panel path", () => {
    expect(safeReturnTo("/panel/sessions/S-1")).toBe("/panel/sessions/S-1");
  });
  it("rejects an absolute URL, a protocol-relative URL, and a non-panel path", () => {
    expect(safeReturnTo("https://evil.example.com/x")).toBe("/panel");
    expect(safeReturnTo("//evil.example.com/x")).toBe("/panel");
    expect(safeReturnTo("/v1/sessions")).toBe("/panel");
    expect(safeReturnTo(null)).toBe("/panel");
  });
  it("rejects control characters so a CRLF cannot split the location header", () => {
    expect(safeReturnTo("/panel/x\r\nset-cookie: a=b")).toBe("/panel");
    expect(safeReturnTo("/panel/x\n")).toBe("/panel");
    expect(safeReturnTo("/panel/x\u0000")).toBe("/panel");
  });
});

describe("refresh", () => {
  it("mints a new access token from a valid refresh cookie", async () => {
    const rt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "rt", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${rt}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=");
    // Absolute window: the refresh cookie is not re-issued.
    expect(cookies).not.toContain("panel_rt=");
  });

  it("401s and clears cookies when the identity lost its role", async () => {
    const rt = mintSession({ sub: "sub-1", email: "alice@example.com" }, "rt", { secret: SECRET });
    process.env.SLAUDE_PANEL_OPERATORS = "";
    __resetRoleCache();
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${rt}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join("\n")).toContain("panel_at=; Max-Age=0");
  });

  it("401s on an access token presented as a refresh token", async () => {
    const at = mintSession({ sub: "sub-1", email: "alice@example.com" }, "at", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh", {
      method: "POST",
      headers: { cookie: `panel_rt=${at}`, "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(401);
    // Flat body: this route is unauthenticated and its CSRF header is one a
    // prober can set, so the internal VerifyReason must stay in the log.
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "session ended" });
    expect(body.error).not.toContain("wrong_type");
  });

  it("405s on GET", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/refresh"))!;
    expect(res.status).toBe(405);
  });
});

describe("me", () => {
  it("returns the identity and role", async () => {
    const at = mintSession({ sub: "sub-1", email: "lead@example.com" }, "at", { secret: SECRET });
    const res = (await call(createAuthRoutes(), "/panel/auth/me", { headers: { cookie: `panel_at=${at}` } }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "lead@example.com", role: "superadmin" });
  });

  it("401s without a session", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/me"))!;
    expect(res.status).toBe(401);
  });
});

describe("logout", () => {
  it("clears both cookies", async () => {
    const res = (await call(createAuthRoutes(), "/panel/auth/logout", {
      method: "POST",
      headers: { "x-panel-csrf": "1" },
    }))!;
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("panel_at=; Max-Age=0");
    expect(cookies).toContain("panel_rt=; Max-Age=0");
  });
});

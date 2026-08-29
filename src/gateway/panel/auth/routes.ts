/**
 * Panel auth routes (design §Data flow). The only module that talks to the
 * identity provider.
 *
 *   GET  /panel/auth/login      → 302 to the provider, sets the flow cookie
 *   GET  /panel/auth/callback   → exchanges the code, sets the session cookies
 *   POST /panel/auth/refresh    → new access token from the refresh cookie
 *   POST /panel/auth/logout     → clears both cookies
 *   GET  /panel/auth/me         → { email, role } for the current session
 *
 * The CSRF guard in api.ts runs before these handlers for non-GET methods.
 */
import { audit } from "./audit";
import {
  buildAuthorizeUrl, discover, exchangeCode, identityFromIdToken, newFlowSecrets, oidcConfigFromEnv,
} from "./oidc";
import { resolveRoleForIdentity } from "./roles";
import {
  AT_COOKIE, AT_PATH, AT_TTL_SEC, FLOW_COOKIE, FLOW_PATH, FLOW_TTL_SEC,
  RT_COOKIE, RT_PATH, RT_TTL_SEC,
  clearCookie, mintFlow, mintSession, parseCookies, setCookie, verifyFlow, verifySession,
} from "./session";

export interface AuthRoutesDeps {
  /** Injected in tests to stand in for the identity provider. */
  fetchImpl?: typeof fetch;
}

export interface AuthRoutes {
  /** Handle an auth route; null when `seg` is not one. */
  handle(req: Request, seg: string[]): Promise<Response | null>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A redirect target is accepted only as a same-origin path under /panel. */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return "/panel";
  // Control characters would ride into `new Headers({ location })` — a CRLF in
  // a query parameter must never become a header split.
  if (/[\x00-\x1f]/.test(raw)) return "/panel";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/panel";
  if (raw !== "/panel" && !raw.startsWith("/panel/")) return "/panel";
  return raw;
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function withCookies(res: Response, cookies: string[]): Response {
  const h = new Headers(res.headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(res.body, { status: res.status, headers: h });
}

const clearSession = () => [clearCookie(AT_COOKIE, AT_PATH), clearCookie(RT_COOKIE, RT_PATH)];

export function createAuthRoutes(deps: AuthRoutesDeps = {}): AuthRoutes {
  const fetchImpl = deps.fetchImpl;

  async function handleLogin(req: Request): Promise<Response> {
    const cfg = oidcConfigFromEnv();
    const url = new URL(req.url);
    const secrets = newFlowSecrets();
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
    const d = await discover(cfg.issuer, { fetchImpl });
    const flow = mintFlow({ ...secrets, returnTo });
    return redirect(buildAuthorizeUrl(d, cfg, secrets), [
      setCookie(FLOW_COOKIE, flow, { path: FLOW_PATH, maxAgeSec: FLOW_TTL_SEC }),
    ]);
  }

  async function handleCallback(req: Request): Promise<Response> {
    const cfg = oidcConfigFromEnv();
    const url = new URL(req.url);
    const clearFlow = clearCookie(FLOW_COOKIE, FLOW_PATH);
    const jar = parseCookies(req.headers.get("cookie"));

    const flow = verifyFlow(jar[FLOW_COOKIE]);
    if (!flow.ok) return withCookies(json(400, { error: "login flow expired or invalid — start again" }), [clearFlow]);

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || state !== flow.payload.state) {
      return withCookies(json(400, { error: "state mismatch" }), [clearFlow]);
    }
    if (!code) return withCookies(json(400, { error: "missing authorization code" }), [clearFlow]);

    const d = await discover(cfg.issuer, { fetchImpl });
    let idToken: string;
    try {
      ({ idToken } = await exchangeCode(d, cfg, { code, verifier: flow.payload.verifier }, { fetchImpl }));
    } catch (e) {
      console.error(`[panel] token exchange failed: ${(e as Error).message}`);
      return withCookies(json(502, { error: "identity provider rejected the login" }), [clearFlow]);
    }

    const who = identityFromIdToken(idToken, cfg, { nonce: flow.payload.nonce });
    if (!who.ok) {
      console.error(`[panel] id_token rejected: ${who.reason}`);
      return withCookies(json(400, { error: "invalid id_token" }), [clearFlow]);
    }

    const role = resolveRoleForIdentity(who.identity);
    if (!role) {
      audit({ action: "auth.denied", operator: who.identity, role: null, outcome: "denied" });
      // No session cookie was ever set on this path — nothing to clear. Emitting
      // clear-cookie headers here would itself contain the cookie name and trip
      // "no session cookies" expectations downstream.
      return withCookies(json(403, { error: "authenticated, but not authorized for this panel" }), [clearFlow]);
    }

    audit({ action: "auth.login", operator: who.identity, role });
    const claims = { sub: who.sub, email: who.identity };
    return redirect(safeReturnTo(flow.payload.returnTo), [
      clearFlow,
      setCookie(AT_COOKIE, mintSession(claims, "at"), { path: AT_PATH, maxAgeSec: AT_TTL_SEC }),
      setCookie(RT_COOKIE, mintSession(claims, "rt"), { path: RT_PATH, maxAgeSec: RT_TTL_SEC }),
    ]);
  }

  function handleRefresh(req: Request): Response {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[RT_COOKIE], "rt");
    if (!r.ok) {
      // Same rule as the guard: this route is unauthenticated and its CSRF
      // header is one a prober can set, so the VerifyReason goes to the log,
      // not to the caller — a forged cookie learns nothing about how it failed.
      console.warn(`[panel] refresh rejected: ${r.reason}`);
      return withCookies(json(401, { error: "session ended" }), clearSession());
    }

    // Roles are re-resolved here as well as per-request: a demoted operator
    // must not be able to extend their session.
    const role = resolveRoleForIdentity(r.claims.email);
    if (!role) {
      audit({ action: "auth.refresh", operator: r.claims.email, role: null, outcome: "denied" });
      return withCookies(json(401, { error: "no longer authorized" }), clearSession());
    }

    audit({ action: "auth.refresh", operator: r.claims.email, role });
    // The refresh cookie is deliberately NOT re-issued: 8h is an absolute cap,
    // not a sliding window.
    return withCookies(json(200, { ok: true, email: r.claims.email, role }), [
      setCookie(AT_COOKIE, mintSession({ sub: r.claims.sub, email: r.claims.email }, "at"), {
        path: AT_PATH,
        maxAgeSec: AT_TTL_SEC,
      }),
    ]);
  }

  function handleLogout(req: Request): Response {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[AT_COOKIE], "at");
    if (r.ok) audit({ action: "auth.logout", operator: r.claims.email });
    return withCookies(json(200, { ok: true }), clearSession());
  }

  function handleMe(req: Request): Response {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifySession(jar[AT_COOKIE], "at");
    if (!r.ok) return json(401, { error: "session expired" });
    const role = resolveRoleForIdentity(r.claims.email);
    if (!role) return json(403, { error: "not authorized" });
    return json(200, { email: r.claims.email, role });
  }

  return {
    async handle(req, seg) {
      if (seg[1] !== "auth" || seg.length !== 3) return null;
      switch (seg[2]) {
        case "login":
          return await handleLogin(req);
        case "callback":
          return await handleCallback(req);
        case "refresh":
          return handleRefresh(req);
        case "logout":
          return handleLogout(req);
        case "me":
          return handleMe(req);
        default:
          return null;
      }
    },
  };
}

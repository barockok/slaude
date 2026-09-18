/**
 * Portal auth routes — the end-user counterpart to the panel's, and the only
 * portal module that talks to the identity provider.
 *
 *   GET  /portal/auth/login      → 302 to the provider, sets the flow cookie
 *   GET  /portal/auth/callback   → exchanges the code, upserts the account
 *   POST /portal/auth/refresh    → new access token from the refresh cookie
 *   POST /portal/auth/logout     → clears both cookies
 *   GET  /portal/auth/me         → { email, accountId, slackIdentities }
 *
 * The decisive difference from the panel: there is NO role check. Any identity
 * the provider authenticates gets a portal session and an account row. That is
 * intended — an account grants nothing on its own, and becomes useful only once
 * a Slack identity is bound to it, which needs a link only that Slack user can
 * see. Onboarding unlocks connected tools; it never gates the agent.
 *
 * The OIDC protocol module is relying-party generic, so this reuses it wholesale
 * and only substitutes the redirect URI.
 */
import { upsertAccount, slackIdentitiesForAccount, findAccountBySubject } from "../../db/accounts";
import { discover, buildAuthorizeUrl, exchangeCode, identityFromIdToken, newFlowSecrets } from "../panel/auth/oidc";
import { portalOidcConfig } from "./config";
import {
  PORTAL_AT_COOKIE, PORTAL_AT_PATH, PORTAL_AT_TTL_SEC,
  PORTAL_FLOW_COOKIE, PORTAL_FLOW_PATH, PORTAL_FLOW_TTL_SEC,
  PORTAL_RT_COOKIE, PORTAL_RT_PATH, PORTAL_RT_TTL_SEC,
  clearCookie, mintPortalFlow, mintPortalSession, parseCookies, setCookie,
  verifyPortalFlow, verifyPortalSession,
} from "./session";

export interface PortalAuthRoutesDeps {
  /** Injected in tests to stand in for the identity provider. */
  fetchImpl?: typeof fetch;
}

export interface PortalAuthRoutes {
  /** Handle a portal auth route; null when `seg` is not one. */
  handle(req: Request, seg: string[]): Promise<Response | null>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A redirect target is accepted only as a same-origin path under /portal. */
export function safePortalReturnTo(raw: string | null): string {
  if (!raw) return "/portal";
  // Control characters would ride into `new Headers({ location })` — a CRLF in
  // a query parameter must never become a header split.
  if (/[\x00-\x1f]/.test(raw)) return "/portal";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/portal";
  if (raw !== "/portal" && !raw.startsWith("/portal/")) return "/portal";
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

const clearSession = () => [
  clearCookie(PORTAL_AT_COOKIE, PORTAL_AT_PATH),
  clearCookie(PORTAL_RT_COOKIE, PORTAL_RT_PATH),
];

export function createPortalAuthRoutes(deps: PortalAuthRoutesDeps = {}): PortalAuthRoutes {
  const fetchImpl = deps.fetchImpl;

  async function handleLogin(req: Request): Promise<Response> {
    const cfg = portalOidcConfig();
    const url = new URL(req.url);
    const secrets = newFlowSecrets();
    const returnTo = safePortalReturnTo(url.searchParams.get("returnTo"));
    const d = await discover(cfg.issuer, { fetchImpl });
    const flow = mintPortalFlow({ ...secrets, returnTo });
    return redirect(buildAuthorizeUrl(d, cfg, secrets), [
      setCookie(PORTAL_FLOW_COOKIE, flow, { path: PORTAL_FLOW_PATH, maxAgeSec: PORTAL_FLOW_TTL_SEC }),
    ]);
  }

  async function handleCallback(req: Request): Promise<Response> {
    const cfg = portalOidcConfig();
    const url = new URL(req.url);
    const clearFlow = clearCookie(PORTAL_FLOW_COOKIE, PORTAL_FLOW_PATH);
    const jar = parseCookies(req.headers.get("cookie"));

    const flow = verifyPortalFlow(jar[PORTAL_FLOW_COOKIE]);
    if (!flow.ok) return withCookies(json(400, { error: "login flow expired or invalid — start again" }), [clearFlow]);

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || state !== flow.payload.state) {
      return withCookies(json(400, { error: "state mismatch" }), [clearFlow]);
    }
    if (!code) return withCookies(json(400, { error: "missing authorization code" }), [clearFlow]);

    let idToken: string;
    try {
      const d = await discover(cfg.issuer, { fetchImpl });
      ({ idToken } = await exchangeCode(d, cfg, { code, verifier: flow.payload.verifier }, { fetchImpl }));
    } catch (e) {
      console.error(`[portal] token exchange failed: ${(e as Error).message}`);
      return withCookies(json(502, { error: "identity provider rejected the login" }), [clearFlow]);
    }

    const who = identityFromIdToken(idToken, cfg, { nonce: flow.payload.nonce });
    if (!who.ok) {
      console.error(`[portal] id_token rejected: ${who.reason}`);
      return withCookies(json(400, { error: "invalid id_token" }), [clearFlow]);
    }

    // No role check, on purpose: see the module comment.
    await upsertAccount({ issuer: cfg.issuer, subject: who.sub, email: who.identity });

    const claims = { sub: who.sub, email: who.identity, iss: cfg.issuer };
    return redirect(safePortalReturnTo(flow.payload.returnTo), [
      clearFlow,
      setCookie(PORTAL_AT_COOKIE, mintPortalSession(claims, "portal_at"), {
        path: PORTAL_AT_PATH,
        maxAgeSec: PORTAL_AT_TTL_SEC,
      }),
      setCookie(PORTAL_RT_COOKIE, mintPortalSession(claims, "portal_rt"), {
        path: PORTAL_RT_PATH,
        maxAgeSec: PORTAL_RT_TTL_SEC,
      }),
    ]);
  }

  async function handleRefresh(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifyPortalSession(jar[PORTAL_RT_COOKIE], "portal_rt");
    if (!r.ok) {
      // The reason goes to the log, not the caller: this route is
      // unauthenticated, and echoing it tells a prober how their forgery failed.
      console.warn(`[portal] refresh rejected: ${r.reason}`);
      return withCookies(json(401, { error: "session ended" }), clearSession());
    }
    // Re-resolved per refresh, like the panel re-resolves roles: an account
    // deleted since sign-in must not be able to extend its session.
    const account = await findAccountBySubject(r.claims.iss, r.claims.sub);
    if (!account) return withCookies(json(401, { error: "account no longer exists" }), clearSession());

    // The refresh cookie is deliberately NOT re-issued: 8h is an absolute cap,
    // not a sliding window.
    return withCookies(json(200, { ok: true, email: account.email, accountId: account.id }), [
      setCookie(
        PORTAL_AT_COOKIE,
        mintPortalSession({ sub: r.claims.sub, email: account.email, iss: r.claims.iss }, "portal_at"),
        { path: PORTAL_AT_PATH, maxAgeSec: PORTAL_AT_TTL_SEC },
      ),
    ]);
  }

  function handleLogout(req: Request): Response {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    return withCookies(json(200, { ok: true }), clearSession());
  }

  async function handleMe(req: Request): Promise<Response> {
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const jar = parseCookies(req.headers.get("cookie"));
    const r = verifyPortalSession(jar[PORTAL_AT_COOKIE], "portal_at");
    if (!r.ok) return json(401, { error: "session expired" });
    const account = await findAccountBySubject(r.claims.iss, r.claims.sub);
    if (!account) return json(401, { error: "account no longer exists" });
    return json(200, {
      email: account.email,
      accountId: account.id,
      slackIdentities: (await slackIdentitiesForAccount(account.id)).map((s) => ({
        teamId: s.team_id,
        slackUserId: s.slack_user_id,
        linkedAt: s.linked_at,
      })),
    });
  }

  return {
    async handle(req, seg) {
      if (seg[0] !== "portal" || seg[1] !== "auth" || seg.length !== 3) return null;
      switch (seg[2]) {
        case "login":
          return await handleLogin(req);
        case "callback":
          return await handleCallback(req);
        case "refresh":
          return await handleRefresh(req);
        case "logout":
          return handleLogout(req);
        case "me":
          return await handleMe(req);
        default:
          return null;
      }
    },
  };
}

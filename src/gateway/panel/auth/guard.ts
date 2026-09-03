/**
 * Per-request operator gate (design §Authenticated request).
 *
 * Identity comes from the panel's own access-token cookie; the role is
 * re-resolved from config on every request and is deliberately not a token
 * claim, so a demotion lands at the next request rather than the next refresh.
 *
 * API paths get a 401/403 JSON body; HTML paths get a redirect to login, so a
 * browser landing on an expired session sees the provider rather than a raw
 * error.
 */
import { resolveRoleForIdentity, type PanelRole } from "./roles";
import { AT_COOKIE, parseCookies, verifySession } from "./session";

export type GuardOk = {
  ok: true;
  operatorId: string;
  role: PanelRole;
  /**
   * Wall-clock expiry of the verified access token. Long-lived responses (the
   * SSE tail) end themselves at this instant instead of outliving the token
   * that authorized them.
   */
  expMs: number;
};
export type GuardResult = GuardOk | { ok: false; response: Response };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const returnTo = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: `/panel/auth/login?returnTo=${returnTo}` } });
}

export function guardRequest(req: Request, opts: { html: boolean }): GuardResult {
  const jar = parseCookies(req.headers.get("cookie"));
  const r = verifySession(jar[AT_COOKIE], "at");
  if (!r.ok) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    // The reason is for the operator's logs, not the caller: echoing it tells a
    // prober how their forgery failed. No client reads it.
    console.warn(`[panel] session rejected: ${r.reason}`);
    return { ok: false, response: json(401, { error: "session expired" }) };
  }
  const role = resolveRoleForIdentity(r.claims.email);
  if (!role) {
    return { ok: false, response: json(403, { error: "authenticated, but not authorized for this panel" }) };
  }
  return { ok: true, operatorId: r.claims.email, role, expMs: r.claims.exp * 1000 };
}

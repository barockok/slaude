/**
 * Per-request end-user gate. Unlike the panel guard there is no role check:
 * any authenticated identity is a legitimate portal user. The account is
 * re-resolved from (issuer, subject) on every request rather than carried as a
 * token claim, so a deleted account stops working at the next request.
 */
import { findAccountBySubject, type AccountRow } from "../../db/accounts";
import { PORTAL_AT_COOKIE, parseCookies, verifyPortalSession } from "./session";

export type PortalGuardResult =
  | { ok: true; account: AccountRow; expMs: number }
  | { ok: false; response: Response };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const returnTo = encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: `/portal/auth/login?returnTo=${returnTo}` } });
}

export async function guardPortal(req: Request, opts: { html: boolean }): Promise<PortalGuardResult> {
  const jar = parseCookies(req.headers.get("cookie"));
  const r = verifyPortalSession(jar[PORTAL_AT_COOKIE], "portal_at");
  if (!r.ok) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    // The reason goes to the operator's log, not the caller: telling a prober
    // how their forgery failed is free help.
    console.warn(`[portal] session rejected: ${r.reason}`);
    return { ok: false, response: json(401, { error: "session expired" }) };
  }
  const account = await findAccountBySubject(r.claims.iss, r.claims.sub);
  if (!account) {
    if (opts.html) return { ok: false, response: loginRedirect(req) };
    return { ok: false, response: json(401, { error: "account no longer exists" }) };
  }
  return { ok: true, account, expMs: r.claims.exp * 1000 };
}

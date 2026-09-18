/**
 * Portal HTTP surface: everything under `/portal`. A separate mount from the
 * operator panel with its own guard — an ordinary user never reaches an operator
 * route, and the panel's guard is not relaxed to let them in.
 *
 *   GET    /portal/auth/*      sign-in (./auth-routes)
 *   GET    /portal/api/me      the signed-in account and its Slack identities
 *   GET    /portal/link?t=…    confirmation page for an onboarding link
 *   POST   /portal/api/link    redeem a link: bind a Slack identity
 *   DELETE /portal/api/link    unlink one of your own bindings
 *
 * Redeeming is a POST behind a custom header, never a bare GET. A mutating GET
 * can be triggered cross-site by an image tag, and the consequence here is
 * specific: an attacker holding a link for their OWN Slack id could make a
 * signed-in victim's browser redeem it, binding the attacker's Slack identity to
 * the victim's account — after which the attacker's messages would run on the
 * victim's credentials. GET /portal/link only renders a confirmation page.
 */
import { env } from "../../config/env";
import { linkSlackIdentity, unlinkSlackIdentity, slackIdentitiesForAccount } from "../../db/accounts";
import { createPortalAuthRoutes, type PortalAuthRoutes } from "./auth-routes";
import { guardPortal } from "./guard";
import { verifyLinkToken } from "./link-token";

export interface PortalApiDeps {
  /** Test seam: stand in for the identity provider on the auth routes. */
  authRoutes?: PortalAuthRoutes;
}

export interface PortalApi {
  /** Handle a request; null when the path is not the portal's. */
  fetch(req: Request): Promise<Response | null>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const html = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * Anti-CSRF for state-changing requests. The portal authenticates with a cookie,
 * which the browser attaches to any request to this origin, including one forged
 * by a cross-site page — so the cookie alone cannot prove same-origin intent. A
 * custom header cannot be set by an HTML form or a CORS "simple request", and a
 * cross-origin fetch that sets it is forced into a preflight this surface never
 * answers with allow-origin.
 */
function enforcePortalCsrf(req: Request): Response | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return json(403, { error: "cross-site request refused" });
  }
  if (req.headers.get("x-portal-csrf") !== "1") {
    return json(403, { error: "missing anti-CSRF header (x-portal-csrf)" });
  }
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The confirmation page. The token is embedded as JSON, never concatenated
 *  into markup, and the button posts it with the anti-CSRF header. */
function confirmPage(token: string, team: string, slackUser: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your account</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; color: #1a1a1a; }
  main { max-width: 32rem; margin: 0 auto; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
  dt { color: #555; }
  code { font: 14px ui-monospace, monospace; }
  button { font: inherit; padding: .6rem 1.2rem; cursor: pointer; }
  #result { margin-top: 1rem; }
</style>
<main>
  <h1>Connect your account</h1>
  <p>This links the Slack user below to the account you are signed in as. Any agent you message can then use the integrations you connect here.</p>
  <dl>
    <dt>Workspace</dt><dd><code id="team"></code></dd>
    <dt>Slack user</dt><dd><code id="user"></code></dd>
  </dl>
  <p><button id="go">Connect</button></p>
  <p id="result" role="status"></p>
</main>
<script>
  const token = ${JSON.stringify(token)};
  document.getElementById("team").textContent = ${JSON.stringify(team)};
  document.getElementById("user").textContent = ${JSON.stringify(slackUser)};
  document.getElementById("go").addEventListener("click", async () => {
    const res = await fetch("/portal/api/link", {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-csrf": "1" },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => ({}));
    document.getElementById("result").textContent = res.ok
      ? "Connected. You can close this page."
      : (body.error || "Could not connect.");
    document.getElementById("go").disabled = res.ok;
  });
</script>`;
}

export function createPortalApi(deps: PortalApiDeps = {}): PortalApi {
  const authRoutes = deps.authRoutes ?? createPortalAuthRoutes();

  async function fetch(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== "/portal" && !url.pathname.startsWith("/portal/")) return null;
    // Disabled: fall through exactly as if the portal did not exist.
    if (!env.portal.enabled()) return null;

    const seg = url.pathname.split("/").filter(Boolean); // ["portal", ...]

    const auth = await authRoutes.handle(req, seg);
    if (auth) return auth;

    try {
      // GET /portal/link?t=… — confirmation page only; it binds nothing.
      if (seg.length === 2 && seg[1] === "link") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: true });
        if (!guarded.ok) return guarded.response;
        const token = url.searchParams.get("t");
        const verified = verifyLinkToken(token);
        if (!verified.ok) return html(400, "<!doctype html><title>Link expired</title><p>This link is invalid or has expired. Ask the agent for a new one.</p>");
        return html(200, confirmPage(token!, verified.claims.team, verified.claims.slackUser));
      }

      if (seg.length === 3 && seg[1] === "api" && seg[2] === "me") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;
        const identities = await slackIdentitiesForAccount(guarded.account.id);
        return json(200, {
          email: guarded.account.email,
          accountId: guarded.account.id,
          slackIdentities: identities.map((s) => ({
            teamId: s.team_id,
            slackUserId: s.slack_user_id,
            linkedAt: s.linked_at,
          })),
        });
      }

      if (seg.length === 3 && seg[1] === "api" && seg[2] === "link") {
        const csrf = enforcePortalCsrf(req);
        if (csrf) return csrf;

        if (req.method === "POST") {
          const guarded = await guardPortal(req, { html: false });
          if (!guarded.ok) return guarded.response;
          const body = await readJson(req);
          const verified = verifyLinkToken(typeof body?.token === "string" ? body.token : null);
          if (!verified.ok) return json(400, { error: `onboarding link ${verified.reason}` });

          // The Slack identity comes from the signed token, never from the
          // request body: that is what the holder cannot forge.
          const linked = await linkSlackIdentity({
            teamId: verified.claims.team,
            slackUserId: verified.claims.slackUser,
            accountId: guarded.account.id,
            via: "signed-link",
          });
          if (!linked.ok) {
            return json(409, { error: "that Slack user is already connected to another account" });
          }
          return json(200, { ok: true, created: linked.created });
        }

        if (req.method === "DELETE") {
          const guarded = await guardPortal(req, { html: false });
          if (!guarded.ok) return guarded.response;
          const body = await readJson(req);
          const teamId = typeof body?.teamId === "string" ? body.teamId : "";
          const slackUserId = typeof body?.slackUserId === "string" ? body.slackUserId : "";
          if (!teamId || !slackUserId) return json(400, { error: "teamId and slackUserId are required" });
          // Scoped to the caller's own account, so one person cannot remove
          // another's binding.
          const removed = await unlinkSlackIdentity(teamId, slackUserId, guarded.account.id);
          return removed ? json(200, { ok: true }) : json(404, { error: "no such connection on your account" });
        }

        return json(405, { error: "method not allowed" });
      }

      return json(404, { error: "not found" });
    } catch (e) {
      console.error(`[portal] ${req.method} ${url.pathname} failed:`, e);
      return json(500, { error: "internal" });
    }
  }

  return { fetch };
}

/**
 * Portal HTTP surface: everything under `/portal`. A separate mount from the
 * operator panel with its own guard — an ordinary user never reaches an operator
 * route, and the panel's guard is not relaxed to let them in.
 *
 *   GET    /portal              the app shell (React, served statically)
 *   GET    /portal/auth/*      sign-in (./auth-routes)
 *   GET    /portal/api/me      the signed-in account and its linked chat identities
 *   GET    /portal/api/my-agents   agents my linked chat identities hold a role on
 *   GET    /portal/link?t=…    confirmation page for an onboarding link
 *   POST   /portal/api/link    redeem a link: bind a chat identity
 *   DELETE /portal/api/link    unlink one of your own bindings
 *   GET    /portal/api/integrations                  what is offered + my status
 *   POST   /portal/api/integrations/:name/connect    start an OAuth connect
 *   GET    /portal/oauth/callback                    finish one
 *   DELETE /portal/api/integrations/:name            disconnect
 *
 * Redeeming is a POST behind a custom header, never a bare GET. A mutating GET
 * can be triggered cross-site by an image tag, and the consequence here is
 * specific: an attacker holding a link for their OWN Slack id could make a
 * signed-in victim's browser redeem it, binding the attacker's Slack identity to
 * the victim's account — after which the attacker's messages would run on the
 * victim's credentials. GET /portal/link only renders a confirmation page.
 */
import { randomBytes } from "node:crypto";
// The design tokens as text (see TOKENS_CSS).
import tokensCssText from "../../web/ui/tokens.css" with { type: "text" };
import type { SlackNames } from "../panel/slack-names";
import { env } from "../../config/env";
import { linkSlackIdentity, unlinkSlackIdentity, slackIdentitiesForAccount } from "../../db/accounts";
import { deleteCredential } from "../../db/mcp-credentials";
import { bumpMcpCredEpoch } from "../core/mcp-cred-epoch";
import { oauthKey } from "../../agent/mcp-oauth/store";
import { createPortalAuthRoutes, type PortalAuthRoutes } from "./auth-routes";
import { guardPortal } from "./guard";
import { verifyLinkToken } from "./link-token";
import { configuredServer, integrationsFor, portalServers, type PortalServer } from "./integrations";
import { finishPortalConnect, startPortalConnect, type PortalConnectDeps } from "./oauth";
import { servePortalStatic } from "./static";
import { myAgents } from "./my-agents";
import type {
  ConnectIntegrationResponse, ConnectResult, DisconnectIntegrationResponse, IntegrationsResponse, MyAgentsResponse, PortalMeResponse,
  PortalOkResponse,
} from "./api-types";
import {
  clearCookie,
  mintPortalOauthFlow,
  parseCookies,
  setCookie,
  verifyPortalOauthFlow,
  PORTAL_OAUTH_COOKIE,
  PORTAL_OAUTH_PATH,
  PORTAL_FLOW_TTL_SEC,
} from "./session";

export interface PortalApiDeps {
  /** Test seam: stand in for the identity provider on the auth routes. */
  authRoutes?: PortalAuthRoutes;
  /** Test seam: the deployment's connectable MCP servers. */
  servers?: () => PortalServer[];
  /** Test seam: discovery, registration and the token endpoint. */
  connect?: PortalConnectDeps;
  /** Workspace and Slack user names for display (ids stay the key). Absent: ids only. */
  names?: Pick<SlackNames, "teamName" | "userName"> | null;
}

/** The surface every linked identity is on: the account binding stores Slack identities only today. */
const IDENTITY_SURFACE = "slack";
/** Surface labels for the server-rendered link page (the web app's registry is src/web/shared/surfaces.ts). */
const SURFACE_LABEL: Readonly<Record<string, string>> = { slack: "Slack" };

export interface PortalApi {
  /** Handle a request; null when the path is not the portal's. */
  fetch(req: Request): Promise<Response | null>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A server-rendered page with a strict Content-Security-Policy: nothing loads
 * but the page's own inline style and script, each allowed by the response's
 * nonce; fetches go to this origin only; no forms, base or framing.
 */
export function portalCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const html = (status: number, page: (nonce: string) => string): Response => {
  const nonce = randomBytes(16).toString("base64");
  return new Response(page(nonce), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": portalCsp(nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
};

/** Text made safe for HTML element content and double-quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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

/**
 * The design tokens, inlined into the server-rendered pages. Imported as text,
 * so Bun resolves it with the module graph: from source in the Docker image and
 * the release tarball (both ship src/), embedded in a compiled build. A
 * `</style` in it could close the element early, so it is removed.
 */
const TOKENS_CSS: string = (typeof tokensCssText === "string" ? tokensCssText : "").replace(/<\/style/gi, "");

/** The page frame for the server-rendered portal pages: tokens inline, no SPA, light and dark. */
function pageFrame(nonce: string, title: string, main: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
${TOKENS_CSS}
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--sl-pad-lg, 1rem); background: var(--sl-page-bg, #fcfcfb); color: var(--sl-text, #0b0b0b); font: var(--sl-text-body, .875rem)/var(--sl-leading-body, 1.25rem) var(--sl-font-sans, system-ui, sans-serif); }
  main { width: 100%; max-width: 28rem; padding: var(--sl-pad-xl, 1.5rem); border-radius: var(--sl-radius-panel, .75rem); background: var(--sl-surface-2, #fff); box-shadow: var(--sl-panel-shadow); }
  .brand { display: flex; align-items: center; gap: .5rem; margin-bottom: var(--sl-gap-md, 1rem); font-weight: var(--sl-weight-semibold, 580); }
  .brand span { color: var(--sl-text-muted); font-weight: var(--sl-weight-regular, 400); }
  .mark { width: 1.125rem; height: 1.125rem; border-radius: .25rem; background: var(--sl-brand, #c6613f); }
  h1 { margin: 0 0 var(--sl-pad-sm, .5rem); font-size: var(--sl-text-title, 1.375rem); line-height: var(--sl-leading-title, 1.75rem); font-weight: var(--sl-weight-semibold, 580); }
  p { margin: 0 0 var(--sl-pad-md, .75rem); color: var(--sl-text-secondary); }
  dl { margin: 0 0 var(--sl-pad-lg, 1rem); padding: var(--sl-pad-sm, .5rem) var(--sl-pad-md, .75rem); border-radius: var(--sl-radius, .5rem); background: var(--sl-surface-0); box-shadow: inset 0 0 0 1px var(--sl-border); }
  .row { display: grid; grid-template-columns: 7rem 1fr; gap: var(--sl-gap-xs, .5rem); padding: var(--sl-pad-xs, .375rem) 0; }
  .row + .row { border-top: 1px solid var(--sl-border); }
  dt { color: var(--sl-text-secondary); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .name { display: block; color: var(--sl-text); }
  .name:empty { display: none; }
  .id { display: block; font: var(--sl-text-caption, .75rem)/var(--sl-leading-caption, 1.0625rem) var(--sl-font-mono, ui-monospace, monospace); color: var(--sl-text-muted); }
  button { font: inherit; height: var(--sl-control-h, 2rem); padding: 0 var(--sl-pad-md, .75rem); border: 0; border-radius: var(--sl-radius, .5rem); background: var(--sl-fill-primary, #0b0b0b); color: var(--sl-on-primary, #fff); cursor: pointer; font-weight: var(--sl-weight-medium, 500); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible { outline: none; box-shadow: var(--sl-focus-ring); }
  #result { margin: var(--sl-pad-md, .75rem) 0 0; min-height: 1.25rem; }
  #result.ok { color: var(--sl-text-success); }
  #result.err { color: var(--sl-text-danger); }
</style>
${main}
${script}
</html>`;
}

/** The page for an invalid or expired link. */
function expiredPage(nonce: string): string {
  return pageFrame(nonce, "Link expired", `<main>
  <div class="brand"><div class="mark" aria-hidden="true"></div>slaude <span>portal</span></div>
  <h1>This link has expired</h1>
  <p>It is invalid or too old. Ask the agent for a new one: send /link to the agent as a message.</p>
</main>`);
}

/**
 * The confirmation page. Nothing is interpolated into the script: every value
 * (the token, the ids, the names, which come from Slack and anyone can set)
 * is HTML-escaped into a data-* attribute, and the fixed script reads them
 * from the DOM and sets text with textContent. The button posts the token
 * with the anti-CSRF header; the page itself binds nothing.
 */
function confirmPage(nonce: string, token: string, team: string, slackUser: string, names: { teamName?: string; userName?: string } = {}): string {
  const attr = (v: string | undefined) => `"${escapeHtml(v ?? "")}"`;
  const main = `<main id="link" data-token=${attr(token)} data-surface=${attr(SURFACE_LABEL[IDENTITY_SURFACE] ?? IDENTITY_SURFACE)} data-team=${attr(team)} data-team-name=${attr(names.teamName)} data-user=${attr(slackUser)} data-user-name=${attr(names.userName)}>
  <div class="brand"><div class="mark" aria-hidden="true"></div>slaude <span>portal</span></div>
  <h1>Connect your account</h1>
  <p>This links the chat identity below to the account you are signed in as. Any agent you message as that user can then use the integrations you connect here.</p>
  <dl>
    <div class="row"><dt>Surface</dt><dd><span class="name" id="surface"></span></dd></div>
    <div class="row"><dt>Workspace</dt><dd><span class="name" id="team-name"></span><span class="id" id="team"></span></dd></div>
    <div class="row"><dt>User</dt><dd><span class="name" id="user-name"></span><span class="id" id="user"></span></dd></div>
  </dl>
  <button id="go" type="button">Connect</button>
  <p id="result" role="status"></p>
</main>`;
  const script = `<script nonce="${nonce}">
  const d = document.getElementById("link").dataset;
  document.getElementById("surface").textContent = d.surface || "";
  document.getElementById("team-name").textContent = d.teamName || "";
  document.getElementById("team").textContent = d.team || "";
  document.getElementById("user-name").textContent = d.userName || "";
  document.getElementById("user").textContent = d.user || "";
  document.getElementById("go").addEventListener("click", async () => {
    const res = await fetch("/portal/api/link", {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-csrf": "1" },
      body: JSON.stringify({ token: d.token }),
    });
    const body = await res.json().catch(() => ({}));
    const out = document.getElementById("result");
    out.textContent = res.ok ? "Connected. You can close this page." : (body.error || "Could not connect.");
    out.className = res.ok ? "ok" : "err";
    document.getElementById("go").disabled = res.ok;
  });
</script>`;
  return pageFrame(nonce, "Connect your account", main, script);
}

export function createPortalApi(deps: PortalApiDeps = {}): PortalApi {
  const authRoutes = deps.authRoutes ?? createPortalAuthRoutes();
  const servers = deps.servers ?? portalServers;
  const connectDeps = deps.connect ?? {};

  /** Display names of a workspace and a Slack user; whatever resolved (never throws). */
  async function identityNames(teamId: string, slackUserId: string): Promise<{ teamName?: string; userName?: string }> {
    if (!deps.names) return {};
    const ctx = { teamId };
    const [teamName, userName] = await Promise.all([
      deps.names.teamName(teamId, ctx).catch(() => null),
      deps.names.userName(slackUserId, ctx).catch(() => null),
    ]);
    return { ...(teamName ? { teamName } : {}), ...(userName ? { userName } : {}) };
  }

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
        if (!verified.ok) return html(400, expiredPage);
        const names = await identityNames(verified.claims.team, verified.claims.slackUser);
        return html(200, (nonce) => confirmPage(nonce, token!, verified.claims.team, verified.claims.slackUser, names));
      }

      if (seg.length === 3 && seg[1] === "api" && seg[2] === "me") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;
        const identities = await slackIdentitiesForAccount(guarded.account.id);
        return json(200, {
          email: guarded.account.email,
          accountId: guarded.account.id,
          issuer: guarded.account.issuer,
          slackIdentities: await Promise.all(
            identities.map(async (s) => ({
              surface: IDENTITY_SURFACE,
              teamId: s.team_id,
              slackUserId: s.slack_user_id,
              linkedAt: s.linked_at,
              linkedVia: s.linked_via,
              ...(await identityNames(s.team_id, s.slack_user_id)),
            })),
          ),
        } satisfies PortalMeResponse);
      }

      // GET /portal/api/my-agents: user-level roles of every linked identity.
      if (seg.length === 3 && seg[1] === "api" && seg[2] === "my-agents") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;
        const identities = await slackIdentitiesForAccount(guarded.account.id);
        const agents = await myAgents(identities.map((s) => ({ teamId: s.team_id, slackUserId: s.slack_user_id })));
        const named = await Promise.all(agents.map(async (a) => ({ ...a, ...(await identityNames(a.teamId, a.slackUserId)) })));
        return json(200, { agents: named } satisfies MyAgentsResponse);
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
            token: { jti: verified.claims.jti, expiresAt: verified.claims.exp * 1000 },
          });
          if (!linked.ok && linked.reason === "link-used") {
            return json(400, { error: "onboarding link already used" });
          }
          if (!linked.ok && linked.reason === "vetoed") {
            return json(409, { error: "that chat identity cannot be connected to this account until an operator allows it" });
          }
          if (!linked.ok) {
            return json(409, { error: "that chat identity is already connected to another account" });
          }
          // This Slack user now resolves to an account (and its integrations):
          // its warm sessions re-list their bridged tools on the next turn.
          await bumpMcpCredEpoch([{ kind: "user", team: verified.claims.team, slackUserId: verified.claims.slackUser }]);
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
          if (removed) await bumpMcpCredEpoch([{ kind: "user", team: teamId, slackUserId }]);
          return removed ? json(200, { ok: true } satisfies PortalOkResponse) : json(404, { error: "no such connection on your account" });
        }

        return json(405, { error: "method not allowed" });
      }

      // GET /portal/api/integrations
      if (seg.length === 3 && seg[1] === "api" && seg[2] === "integrations") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;
        return json(200, { integrations: await integrationsFor(guarded.account.id, servers()) } satisfies IntegrationsResponse);
      }

      // POST /portal/api/integrations/:name/connect
      if (seg.length === 5 && seg[1] === "api" && seg[2] === "integrations" && seg[4] === "connect") {
        const csrf = enforcePortalCsrf(req);
        if (csrf) return csrf;
        if (req.method !== "POST") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;

        const id = decodeURIComponent(seg[3]!);
        const server = configuredServer(id, servers());
        // Refused rather than attempted: the id arrives from the request, and
        // the URL it would otherwise imply is where an access token gets sent.
        if (!server) return json(404, { error: "no such integration" });

        // The server's own name, not the id: the credential is keyed on the name
        // the agents use, and the id is only how the page refers to the row.
        const started = await startPortalConnect(guarded.account.id, server.name, server.cfg, connectDeps);
        const res = json(200, { authorizeUrl: started.authorizeUrl } satisfies ConnectIntegrationResponse);
        res.headers.append(
          "set-cookie",
          setCookie(PORTAL_OAUTH_COOKIE, mintPortalOauthFlow(started.flowId), {
            path: PORTAL_OAUTH_PATH,
            maxAgeSec: PORTAL_FLOW_TTL_SEC,
          }),
        );
        return res;
      }

      // DELETE /portal/api/integrations/:name
      if (seg.length === 4 && seg[1] === "api" && seg[2] === "integrations") {
        const csrf = enforcePortalCsrf(req);
        if (csrf) return csrf;
        if (req.method !== "DELETE") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: false });
        if (!guarded.ok) return guarded.response;

        const id = decodeURIComponent(seg[3]!);
        const server = configuredServer(id, servers());
        if (!server) return json(404, { error: "no such integration" });
        // Scoped to the caller's own account, so one person cannot disconnect
        // another's integration.
        const removed = await deleteCredential({ kind: "account", accountId: guarded.account.id }, oauthKey(server.name, server.cfg));
        if (removed) await bumpMcpCredEpoch({ kind: "account", accountId: guarded.account.id });
        return json(200, { ok: true, removed } satisfies DisconnectIntegrationResponse);
      }

      // GET /portal/oauth/callback?code&state — the provider's redirect.
      if (seg.length === 3 && seg[1] === "oauth" && seg[2] === "callback") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        const guarded = await guardPortal(req, { html: true });
        if (!guarded.ok) return guarded.response;

        const jar = parseCookies(req.headers.get("cookie"));
        const cookie = verifyPortalOauthFlow(jar[PORTAL_OAUTH_COOKIE]);
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";

        // Every outcome lands back in the app with a result it can render, and
        // the cookie is cleared either way — the flow row is single use, so the
        // cookie has nothing left to refer to.
        const back = (result: ConnectResult) => {
          return new Response(null, {
            status: 302,
            headers: {
              location: `/portal?connect=${encodeURIComponent(result)}`,
              "set-cookie": clearCookie(PORTAL_OAUTH_COOKIE, PORTAL_OAUTH_PATH),
            },
          });
        };

        if (!cookie.ok) return back("expired");
        if (!code) return back("failed");
        const done = await finishPortalConnect(guarded.account.id, cookie.flowId, code, state, connectDeps);
        return back(done.ok ? "connected" : done.reason);
      }

      // The app's own hashed assets. Unguarded on purpose: they are the same
      // bytes for everyone, they carry nothing about the viewer, and gating them
      // means a person whose session expires with the page open gets redirects
      // for scripts instead of a sign-in page.
      if (req.method === "GET" && seg[1] === "assets") {
        const asset = await servePortalStatic(url.pathname);
        if (asset) return asset;
      }

      // Anything else under /portal that is not a route above is the app shell.
      // Guarded, so an unauthenticated visitor is sent to sign in rather than
      // handed a page that can only show them a 401. `auth` and `oauth` are
      // excluded so an unknown path under them 404s instead of rendering the app.
      if (req.method === "GET" && seg[1] !== "api" && seg[1] !== "auth" && seg[1] !== "oauth") {
        const guarded = await guardPortal(req, { html: true });
        if (!guarded.ok) return guarded.response;
        const asset = await servePortalStatic(url.pathname);
        if (asset) return asset;
      }

      return json(404, { error: "not found" });
    } catch (e) {
      console.error(`[portal] ${req.method} ${url.pathname} failed:`, e);
      return json(500, { error: "internal" });
    }
  }

  return { fetch };
}

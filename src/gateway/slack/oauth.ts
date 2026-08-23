/**
 * Slack OAuth install flow (spec §5, install model B — one app installed to
 * many workspaces). Two GET endpoints mounted on the HTTP Slack transport:
 *
 *   /slack/oauth/start     302 → slack.com/oauth/v2/authorize with the bot
 *                          scopes and a signed `state`
 *   /slack/oauth/callback  verify state, exchange `code` via oauth.v2.access,
 *                          upsert the slack_apps row (secrets encrypted at
 *                          rest by the repo), render a plain success page
 *
 * Feature-gated: both endpoints 404 unless SLACK_CLIENT_ID is set.
 *
 * `state` is a compact HS256 token `<b64url payload>.<b64url hmac>` with
 * {iat, exp, n} claims, TTL 10 minutes. The HMAC key is SLACK_CLIENT_SECRET:
 * it is already shared, secret config on every gateway replica, so a state
 * minted by replica 1 verifies on replica 2 — a per-process random secret
 * would break behind a load balancer.
 *
 * oauth.v2.access does NOT return the app's signing secret (app-level config,
 * identical across installs), so the callback stores SLACK_SIGNING_SECRET
 * from env on the row.
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { env } from "../../config/env";
import * as SlackApps from "../../db/slack-apps";
import type { SlackAppInput, SlackAppRow } from "../../db/slack-apps";
import { BOT_SCOPES } from "../../cli/manifest";

export const OAUTH_STATE_TTL_SEC = 10 * 60;

const b64u = (b: Buffer) => b.toString("base64url");

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time equality over sha256 digests (length-independent). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function mintOAuthState(opts: { secret: string; now?: number; ttlSec?: number }): string {
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload = b64u(
    Buffer.from(
      JSON.stringify({
        iat: nowSec,
        exp: nowSec + (opts.ttlSec ?? OAUTH_STATE_TTL_SEC),
        n: randomBytes(8).toString("base64url"),
      }),
    ),
  );
  return `${payload}.${hmac(payload, opts.secret)}`;
}

export type OAuthStateResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "expired" };

export function verifyOAuthState(
  state: string | null | undefined,
  opts: { secret: string; now?: number },
): OAuthStateResult {
  if (!state) return { ok: false, reason: "missing" };
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  if (!safeEqual(hmac(payload, opts.secret), sig)) return { ok: false, reason: "bad_signature" };
  let claims: { iat?: number; exp?: number };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true };
}

export interface OAuthDeps {
  /** All default to the SLACK_* env vars. */
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  redirectUrl?: string;
  scopes?: readonly string[];
  /** oauth.v2.access transport (test seam). */
  fetchFn?: typeof fetch;
  /** slack_apps upsert (test seam / explicit DbClient). */
  upsert?: (input: SlackAppInput) => Promise<SlackAppRow>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** HTML-escape & < > " ' — applied to EVERY interpolated value. */
export function escapeHtml(v: unknown): string {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The ONLY HTML sink in this module — and it escapes every interpolation
 * itself, so no caller (present or future) can reflect attacker-controlled
 * input (Slack's `?error=`, exchange error strings, team ids) as markup.
 * Body/title are treated as plain text; markup never passes through.
 */
const html = (status: number, title: string, body: string): Response => {
  const t = escapeHtml(title);
  const b = escapeHtml(body);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head>` +
      `<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto"><h1>${t}</h1><p>${b}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
};

/**
 * Handle a request under /slack/oauth/*. Returns null when the path is not an
 * OAuth endpoint OR the flow is disabled (no SLACK_CLIENT_ID) — the caller
 * falls through to its 404.
 */
export async function handleOAuth(
  req: Request,
  url: URL,
  deps: OAuthDeps = {},
): Promise<Response | null> {
  const clientId = deps.clientId ?? env.slack.clientId();
  if (!clientId) return null; // feature-gated: 404 via caller fall-through
  const path = url.pathname;
  if (path !== "/slack/oauth/start" && path !== "/slack/oauth/callback") return null;
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });

  const clientSecret = deps.clientSecret ?? env.slack.clientSecret();
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? Date.now;
  if (!clientSecret) {
    // Misconfiguration, not a client error: state cannot be signed/verified
    // and the code exchange cannot authenticate.
    return html(503, "OAuth not configured", "SLACK_CLIENT_SECRET is not set on this gateway.");
  }

  if (path === "/slack/oauth/start") {
    const scopes = (deps.scopes ?? BOT_SCOPES).join(",");
    const redirectUrl = deps.redirectUrl ?? env.slack.oauthRedirectUrl();
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("scope", scopes);
    authorize.searchParams.set("state", mintOAuthState({ secret: clientSecret, now: now() }));
    if (redirectUrl) authorize.searchParams.set("redirect_uri", redirectUrl);
    return Response.redirect(authorize.toString(), 302);
  }

  // /slack/oauth/callback
  const state = verifyOAuthState(url.searchParams.get("state"), { secret: clientSecret, now: now() });
  if (!state.ok) {
    log(`[slack-oauth] rejected callback: state ${state.reason}`);
    return html(400, "Install failed", `Invalid OAuth state (${state.reason}). Restart from /slack/oauth/start.`);
  }
  if (url.searchParams.get("error")) {
    return html(400, "Install cancelled", `Slack returned: ${url.searchParams.get("error")}`);
  }
  const code = url.searchParams.get("code");
  if (!code) return html(400, "Install failed", "Missing ?code parameter.");

  const signingSecret = deps.signingSecret ?? env.slack.signingSecret();
  if (!signingSecret) {
    return html(
      503,
      "OAuth not configured",
      "SLACK_SIGNING_SECRET is not set — the installed workspace could not be registered.",
    );
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
  const redirectUrl = deps.redirectUrl ?? env.slack.oauthRedirectUrl();
  if (redirectUrl) form.set("redirect_uri", redirectUrl);
  let data: any;
  try {
    const res = await fetchFn("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    data = await res.json();
  } catch (e: any) {
    log(`[slack-oauth] oauth.v2.access failed: ${e?.message ?? e}`);
    return html(502, "Install failed", "Could not reach Slack to exchange the code. Try again.");
  }
  if (!data?.ok) {
    log(`[slack-oauth] oauth.v2.access error: ${data?.error ?? "unknown"}`);
    return html(502, "Install failed", `Slack rejected the code exchange (${data?.error ?? "unknown error"}).`);
  }
  const appId = data.app_id;
  const teamId = data.team?.id;
  const botToken = data.access_token;
  if (!appId || !teamId || !botToken) {
    return html(502, "Install failed", "Slack's response was missing app_id, team.id or access_token.");
  }

  const upsert = deps.upsert ?? ((input: SlackAppInput) => SlackApps.upsert(input));
  try {
    await upsert({
      api_app_id: appId,
      team_id: teamId,
      bot_token: botToken,
      signing_secret: signingSecret,
      bot_user_id: data.bot_user_id ?? null,
    });
  } catch (e: any) {
    log(`[slack-oauth] slack_apps upsert failed: ${e?.message ?? e}`);
    return html(500, "Install failed", "The workspace could not be registered. Check gateway logs.");
  }

  log(`[slack-oauth] installed app=${appId} team=${teamId}`);
  // teamId is interpolated as plain text — html() escapes it like every
  // other value, so a hostile "team id" cannot become markup.
  return html(200, "App installed", `The app is now installed to workspace ${teamId}. You can close this tab.`);
}

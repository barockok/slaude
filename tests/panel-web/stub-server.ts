// Fixture-backed stand-in for the panel gateway, used by the Playwright e2e
// suite. Serves the built dist under /panel and implements the /panel/api
// contract against the shared fixtures (REST + SSE replay of the scripted
// turn). No Redis, no DB — deterministic. Env STUB_NO_REDIS=1 exercises the
// degraded 503 path; a preset lock owner drives the 409 path.
//
// Auth is NOT stubbed. `/panel/auth/*` and the static app are served by the
// real panel handler (createPanelApi().fetch), and `/panel/api/*` — fixture
// data, but real gates — runs the real guardRequest + requireSuperadmin before
// answering. What IS stubbed is the identity provider: /idp/* below speaks
// just enough OIDC (discovery, authorize, token) to complete a login round
// trip without a browser form or a network dependency.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_SESSIONS, SCRIPT, DETAIL_ID } from "../../src/gateway/panel/web/app/fixtures";

const PORT = Number(process.env.PORT ?? 4319);
const ORIGIN = `http://localhost:${PORT}`;
const NO_REDIS = process.env.STUB_NO_REDIS === "1";

// Panel configuration must be in place before the panel modules load: SLAUDE_HOME
// is captured at import time (config/home), so it is redirected at a throwaway
// directory to keep the suite away from the developer's real ~/.slaude — in
// particular its panel-roles.yaml, which would otherwise outrank the role lists
// set here.
process.env.SLAUDE_HOME = mkdtempSync(join(tmpdir(), "slaude-panel-e2e-"));
process.env.SLAUDE_PANEL = "1";
process.env.SLAUDE_PANEL_OIDC_ISSUER = `${ORIGIN}/idp`;
process.env.SLAUDE_PANEL_OIDC_CLIENT_ID = "slaude-panel";
process.env.SLAUDE_PANEL_OIDC_CLIENT_SECRET = "stub-secret";
process.env.SLAUDE_PANEL_PUBLIC_URL = ORIGIN;
process.env.SLAUDE_PANEL_SECRET = "e2e-secret-e2e-secret-e2e-secret!";
process.env.SLAUDE_PANEL_SUPERADMIN = "lead@example.com";
process.env.SLAUDE_PANEL_OPERATORS = "alice@example.com";
process.env.SLAUDE_PANEL_ROLES_FILE = "";

// Imported after the env above is set, so the panel reads this configuration.
const { createPanelApi, requireSuperadmin } = await import("../../src/gateway/panel/api");
const { guardRequest } = await import("../../src/gateway/panel/auth/guard");

// The real /panel handler: auth routes and the static app. Its own API
// handlers are never reached — /panel/api/* is answered from the fixtures
// below — so the DB/registry/pubsub seams stay unused.
const panelApi = createPanelApi({
  registry: null,
  pubsub: null,
  panelLock: null,
  chat: async () => {},
});

const sessions = FIXTURE_SESSIONS.map((s) => ({ ...s }));
const locks = new Map<string, string>();
for (const s of sessions) if (s.panel_locked_by) locks.set(s.id, s.panel_locked_by);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- stub IdP --
// Identities the stub provider can sign in as. The role each one resolves to
// is decided by the panel, from SLAUDE_PANEL_SUPERADMIN / _OPERATORS above:
// lead@ is superadmin, alice@ is operator, eve@ is on neither list.
const IDENTITIES: Record<string, string> = {
  operator: "alice@example.com",
  superadmin: "lead@example.com",
  unlisted: "eve@example.com",
};

// Which identity the *next* login should return. The browser asks for it with
// `/panel?role=<hint>`; the panel's own redirect to the provider carries no
// room for it, so it is parked here in between. A single variable is enough
// only because the Playwright config runs these specs serially with one worker
// (fullyParallel: false, workers: 1) — this is not a shared-state bug, but it
// would become one the moment the suite runs specs in parallel.
let roleHint = "operator";

// Issued authorization codes → the flow they belong to. Keying the nonce by
// code (rather than parking it in a variable) is what makes the round trip
// honest: the panel requires the id_token's nonce to equal the one it put in
// the authorize URL and kept in its flow cookie, so the value has to travel
// authorize → code → token exchange.
const codes = new Map<string, { nonce: string; role: string }>();

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

async function idpRoutes(url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === "/idp/.well-known/openid-configuration") {
    return Response.json({
      issuer: `${ORIGIN}/idp`,
      authorization_endpoint: `${ORIGIN}/idp/auth`,
      token_endpoint: `${ORIGIN}/idp/token`,
    });
  }

  // Auto-approving authorize endpoint: no login form, straight back to the
  // panel's callback with a fresh code.
  if (url.pathname === "/idp/auth") {
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (!state || !nonce) return json(400, { error: "invalid_request" });
    if (!redirectUri.startsWith(`${ORIGIN}/panel/`)) return json(400, { error: "invalid_redirect_uri" });
    const code = crypto.randomUUID();
    codes.set(code, { nonce, role: roleHint });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }

  // Token endpoint. The panel posts form-encoded and reads only `id_token`.
  // The JWT is unsigned on purpose: the panel deliberately does not verify the
  // signature of a token it received itself over the back channel (see the
  // module comment in src/gateway/panel/auth/oidc.ts) — it reads the claims.
  if (url.pathname === "/idp/token") {
    const form = new URLSearchParams(await req.text());
    const flow = codes.get(form.get("code") ?? "");
    if (!flow) return json(400, { error: "invalid_grant" });
    codes.delete(form.get("code")!); // single use, like a real provider
    const email = IDENTITIES[flow.role] ?? IDENTITIES.operator;
    const claims = {
      iss: `${ORIGIN}/idp`,
      aud: "slaude-panel",
      sub: `stub-sub-${flow.role}`,
      email,
      nonce: flow.nonce,
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    return Response.json({
      token_type: "Bearer",
      id_token: `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}.stub-sig`,
    });
  }

  // Harness-only: rewrite the panel's operator list while a browser holds a
  // live session — how an identity becomes unlisted without a redeploy. The
  // panel re-resolves roles from this env var on every request, so the change
  // lands on the next poll.
  // Harness-only: arm a one-shot SSE expiry. The next event stream ends the way
  // the real panel ends one at the access token's expiry — a named
  // `session-expired` frame, then close — so the browser's refresh-and-reopen
  // handshake can be observed without waiting 15 minutes. One-shot on purpose:
  // the stream that consumes it disarms it, so the reopened stream stays live.
  if (url.pathname === "/idp/expire-sse" && req.method === "POST") {
    expireNextStream = true;
    return json(200, { ok: true });
  }

  if (url.pathname === "/idp/operators" && req.method === "POST") {
    process.env.SLAUDE_PANEL_OPERATORS = url.searchParams.get("list") ?? "";
    return json(200, { ok: true, operators: process.env.SLAUDE_PANEL_OPERATORS });
  }

  return null;
}

// ------------------------------------------------------------ fixture data --
// Armed by POST /idp/expire-sse; consumed by the next stream to open.
let expireNextStream = false;

function sseReplay(id: string): Response {
  const frames = id === DETAIL_ID ? SCRIPT : SCRIPT.slice(0, 4);
  const enc = new TextEncoder();
  let i = 0, seq = 0;
  let closed = false;
  const stream = new ReadableStream({
    start(c) {
      const push = (s: string) => {
        if (closed) return false;
        try { c.enqueue(enc.encode(s)); return true; } catch { closed = true; return false; }
      };
      push(": open\n\n");
      const tick = () => {
        if (closed) return;
        if (expireNextStream) {
          expireNextStream = false;
          push("event: session-expired\ndata: {}\n\n");
          closed = true;
          try { c.close(); } catch { /* client already gone */ }
          return;
        }
        if (i >= frames.length) { push(": ping\n\n"); setTimeout(tick, 400); return; }
        const f = frames[i++]!;
        push(`id: stub-${++seq}\ndata: ${JSON.stringify(f.event)}\n\n`);
        setTimeout(tick, Math.max(30, Math.round((frames[i]?.delay ?? 200) * 0.35)));
      };
      setTimeout(tick, 30);
    },
    cancel() { closed = true; },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

/** /panel/api/* — fixture bodies behind the real session guard and role gate. */
async function fixtureApi(req: Request, url: URL, seg: string[]): Promise<Response> {
  const auth = guardRequest(req, { html: false });
  if (!auth.ok) return auth.response;
  const { operatorId: me, role } = auth;

  if (seg.length === 3 && seg[2] === "sessions") {
    const q = url.searchParams;
    const out = sessions
      .filter((s) => (!q.get("persona") || s.persona_id === q.get("persona")) && (!q.get("status") || s.status === q.get("status")))
      .map((s) => ({ ...s, panel_locked_by: locks.get(s.id) }));
    return json(200, { sessions: out });
  }

  if (seg.length >= 4 && seg[2] === "sessions") {
    const id = seg[3]!;
    const sub = seg[4];
    const row = sessions.find((s) => s.id === id);
    if (!row) return json(404, { error: "session not found" });

    if (!sub) return json(200, { session: row, panel_locked_by: locks.get(id) });
    if (sub === "events") return NO_REDIS ? json(503, { error: "no redis" }) : sseReplay(id);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : ({} as any);
    if (sub === "control") {
      const denied = requireSuperadmin(role, { action: `control.${body.action}`, operator: me, session: id });
      if (denied) return denied;
      if (body.action === "stop" && NO_REDIS) return json(503, { error: "stop unavailable (no Redis)" });
      if (body.action === "model" && body.model) row.model = body.model;
      if (body.action === "reset") row.claude_started = 0;
      return json(200, { ok: true, session: { ...row } });
    }
    if (sub === "chat") {
      if (NO_REDIS) return json(503, { error: "unavailable (no Redis)" });
      const owner = locks.get(id);
      if (owner && owner !== me) return json(409, { error: "driven by another operator", owner });
      locks.set(id, me);
      return json(202, { ok: true, locked_by: me });
    }
    if (sub === "lock") {
      if (NO_REDIS) return json(503, { error: "lock unavailable (no Redis)" });
      const owner = locks.get(id);
      if (owner && owner !== me) return json(409, { error: "held by another operator", owner });
      locks.set(id, me);
      return json(200, { ok: true, locked_by: me, ttl_ms: 45000 });
    }
    if (sub === "heartbeat") return json(200, { ok: true, ttl_ms: 45000 });
    if (sub === "release") { locks.delete(id); return json(200, { ok: true, released: true }); }
    if (sub === "force-release") {
      const denied = requireSuperadmin(role, { action: "force-release", operator: me, session: id });
      if (denied) return denied;
      const d = locks.get(id);
      locks.set(id, me);
      return json(200, { ok: true, displaced: d });
    }
  }
  return json(404, { error: "not found" });
}

process.on("unhandledRejection", (e) => console.error("[stub] unhandledRejection", e));

Bun.serve({
  port: PORT,
  error(e) { console.error("[stub] error", e); return new Response("stub error", { status: 500 }); },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/idp")) return (await idpRoutes(url, req)) ?? json(404, { error: "not found" });

    const seg = url.pathname.split("/").filter(Boolean);
    if (seg[0] !== "panel") return new Response("not found", { status: 404 });

    // A page load picks the identity the stub provider will hand back for the
    // login it is about to trigger; no `role` means the default identity, so a
    // spec never inherits the previous spec's hint. Auth routes are exempt:
    // they are the redirect chain in the middle of a flow already chosen.
    if (seg[1] !== "api" && seg[1] !== "auth") roleHint = url.searchParams.get("role") ?? "operator";

    if (seg[1] === "api") return fixtureApi(req, url, seg);
    return (await panelApi.fetch(req)) ?? json(404, { error: "not found" });
  },
});

console.log(`[stub] panel fixture server on ${ORIGIN}/panel/ (noRedis=${NO_REDIS})`);

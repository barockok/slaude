import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { openDb, type DbClient } from "../../../src/db/client";
import { runMigrations } from "../../../src/db/migrate";
import { __resetMasterKeyCache, isEncrypted } from "../../../src/db/crypto";
import * as SlackApps from "../../../src/db/slack-apps";
import {
  handleOAuth,
  mintOAuthState,
  verifyOAuthState,
  OAUTH_COOKIE,
  OAUTH_STATE_TTL_SEC,
} from "../../../src/gateway/slack/oauth";
import { buildManifest, BOT_SCOPES } from "../../../src/cli/manifest";
import { createHttpSlackTransport } from "../../../src/gateway/slack/http-transport";

const SECRET = "client-secret-for-tests";

let dbc: DbClient;
let prevKey: string | undefined;

beforeAll(async () => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
  dbc = await openDb({ dialect: "pg", driver: "pglite" });
  await runMigrations(dbc, { log: () => {} });
});

afterAll(async () => {
  await dbc.close();
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  __resetMasterKeyCache();
});

describe("OAuth state token", () => {
  it("round-trips", () => {
    const s = mintOAuthState({ secret: SECRET });
    expect(verifyOAuthState(s, { secret: SECRET })).toEqual({ ok: true, nonce: expect.any(String) });
  });

  it("rejects a tampered payload", () => {
    const s = mintOAuthState({ secret: SECRET });
    const [payload, sig] = s.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.exp += 3600;
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    expect(verifyOAuthState(forged, { secret: SECRET })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a wrong-secret signature", () => {
    const s = mintOAuthState({ secret: "other-secret" });
    expect(verifyOAuthState(s, { secret: SECRET })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired state", () => {
    const past = Date.now() - (OAUTH_STATE_TTL_SEC + 5) * 1000;
    const s = mintOAuthState({ secret: SECRET, now: past });
    expect(verifyOAuthState(s, { secret: SECRET })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing/malformed states", () => {
    expect(verifyOAuthState(null, { secret: SECRET })).toEqual({ ok: false, reason: "missing" });
    expect(verifyOAuthState("nodots", { secret: SECRET })).toEqual({ ok: false, reason: "malformed" });
    // Signed garbage payload: valid HMAC, unparseable JSON.
    const payload = Buffer.from("not json").toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyOAuthState(`${payload}.${sig}`, { secret: SECRET })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

function req(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`http://gw${path}`);
  return [new Request(url.toString(), { method: "GET", headers }), url];
}

/** Callback request with the browser-binding cookie set to `cookieState`
 *  (defaults to the state in the query, i.e. the legitimate browser). */
function cbReq(state: string, cookieState: string = state): [Request, URL] {
  return req(`/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
    cookie: `${OAUTH_COOKIE}=${cookieState}`,
  });
}

const baseDeps = () => ({
  clientId: "1234.5678",
  clientSecret: SECRET,
  signingSecret: "app-signing-secret",
  nonces: null, // replay test injects its own store
  log: () => {},
});

describe("handleOAuth", () => {
  it("is disabled (null → 404 fall-through) without a client id", async () => {
    const [r, u] = req("/slack/oauth/start");
    expect(await handleOAuth(r, u, { clientId: "" })).toBeNull();
  });

  it("start redirects to slack authorize with scopes + signed state", async () => {
    const [r, u] = req("/slack/oauth/start");
    const res = await handleOAuth(r, u, baseDeps());
    expect(res!.status).toBe(302);
    const loc = new URL(res!.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(loc.searchParams.get("client_id")).toBe("1234.5678");
    expect(loc.searchParams.get("scope")).toBe(BOT_SCOPES.join(","));
    const state = loc.searchParams.get("state")!;
    expect(verifyOAuthState(state, { secret: SECRET })).toEqual({ ok: true, nonce: expect.any(String) });
  });

  it("start includes redirect_uri only when configured", async () => {
    const [r, u] = req("/slack/oauth/start");
    const plain = await handleOAuth(r, u, baseDeps());
    expect(new URL(plain!.headers.get("location")!).searchParams.get("redirect_uri")).toBeNull();
    const withUri = await handleOAuth(r, u, {
      ...baseDeps(),
      redirectUrl: "https://gw.example.com/slack/oauth/callback",
    });
    expect(new URL(withUri!.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://gw.example.com/slack/oauth/callback",
    );
  });

  it("callback 400s on unknown/tampered state (no exchange attempted)", async () => {
    let fetched = 0;
    const deps = {
      ...baseDeps(),
      fetchFn: (async () => {
        fetched++;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    };
    // Cookie matches the (bad) state — the attacker's own browser — so the
    // rejection below is the SIGNATURE check, not the CSRF binding.
    for (const state of ["garbage", mintOAuthState({ secret: "wrong" })]) {
      const [r, u] = cbReq(state);
      const res = await handleOAuth(r, u, deps);
      expect(res!.status).toBe(400);
    }
    // Empty state: rejected by the binding check (nothing to match).
    const [r, u] = req(`/slack/oauth/callback?code=c`);
    expect((await handleOAuth(r, u, deps))!.status).toBe(400);
    expect(fetched).toBe(0);
  });

  it("callback 400s on an expired state", async () => {
    const past = Date.now() - (OAUTH_STATE_TTL_SEC + 5) * 1000;
    const state = mintOAuthState({ secret: SECRET, now: past });
    const [r, u] = cbReq(state);
    const res = await handleOAuth(r, u, baseDeps());
    expect(res!.status).toBe(400);
    expect(await res!.text()).toContain("expired");
  });

  it("callback HTML-escapes reflected values (no raw markup from ?error=)", async () => {
    const state = mintOAuthState({ secret: SECRET });
    const payload = `<script>alert(1)</script>`;
    const [r, u] = req(
      `/slack/oauth/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent(payload)}`,
      { cookie: `${OAUTH_COOKIE}=${state}` },
    );
    const res = await handleOAuth(r, u, baseDeps());
    expect(res!.status).toBe(400);
    const body = await res!.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("callback requires the browser-binding cookie (missing → 400, mismatch → 400, match → proceeds)", async () => {
    const state = mintOAuthState({ secret: SECRET });
    const exchange = (async () =>
      Response.json({
        ok: true,
        app_id: "A0CSRF",
        access_token: "xoxb-csrf",
        team: { id: "T0CSRF" },
      })) as unknown as typeof fetch;
    const deps = { ...baseDeps(), fetchFn: exchange, upsert: async (i: any) => SlackApps.upsert(i, dbc) };

    // Missing cookie.
    const [r1, u1] = req(`/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
    const res1 = await handleOAuth(r1, u1, deps);
    expect(res1!.status).toBe(400);
    expect(await res1!.text()).toContain("did not start the install");

    // Mismatched cookie (a different, even validly-signed, state).
    const other = mintOAuthState({ secret: SECRET });
    const [r2, u2] = cbReq(state, other);
    expect((await handleOAuth(r2, u2, deps))!.status).toBe(400);

    // Matching cookie proceeds to the exchange.
    const [r3, u3] = cbReq(state);
    const res3 = await handleOAuth(r3, u3, deps);
    expect(res3!.status).toBe(200);
    // Terminal callback responses clear the cookie.
    expect(res3!.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("start sets the state cookie (HttpOnly, SameSite=Lax, TTL) matching the redirect state", async () => {
    const [r, u] = req("/slack/oauth/start");
    const res = await handleOAuth(r, u, baseDeps());
    const cookie = res!.headers.get("set-cookie")!;
    const state = new URL(res!.headers.get("location")!).searchParams.get("state")!;
    expect(cookie).toContain(`${OAUTH_COOKIE}=${state}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${OAUTH_STATE_TTL_SEC}`);
    expect(cookie).toContain("Path=/slack/oauth");
  });

  it("uses the dedicated state secret when provided (client-secret states stop verifying)", async () => {
    const deps = { ...baseDeps(), stateSecret: "dedicated-state-secret" };
    const [rs, us] = req("/slack/oauth/start");
    const started = await handleOAuth(rs, us, deps);
    const state = new URL(started!.headers.get("location")!).searchParams.get("state")!;
    expect(verifyOAuthState(state, { secret: "dedicated-state-secret" }).ok).toBe(true);
    expect(verifyOAuthState(state, { secret: SECRET }).ok).toBe(false);
    // A state signed with the client secret is rejected by the callback.
    const legacy = mintOAuthState({ secret: SECRET });
    const [rc, uc] = cbReq(legacy);
    expect((await handleOAuth(rc, uc, deps))!.status).toBe(400);
  });

  it("state is single-use when a nonce store is present (replay → 400)", async () => {
    const issued = new Map<string, true>();
    const nonces = {
      put: async (n: string) => void issued.set(n, true),
      consume: async (n: string) => issued.delete(n),
    };
    const deps = {
      ...baseDeps(),
      nonces,
      fetchFn: (async () =>
        Response.json({
          ok: true,
          app_id: "A0ONCE",
          access_token: "xoxb-once",
          team: { id: "T0ONCE" },
        })) as unknown as typeof fetch,
      upsert: async (i: any) => SlackApps.upsert(i, dbc),
    };
    // Mint through /start so the nonce lands in the store.
    const [rs, us] = req("/slack/oauth/start");
    const started = await handleOAuth(rs, us, deps);
    const state = new URL(started!.headers.get("location")!).searchParams.get("state")!;

    const [r1, u1] = cbReq(state);
    expect((await handleOAuth(r1, u1, deps))!.status).toBe(200);

    // Replay: same state, second attempt.
    const [r2, u2] = cbReq(state);
    const replay = await handleOAuth(r2, u2, deps);
    expect(replay!.status).toBe(400);
    expect(await replay!.text()).toContain("already used");
  });

  it("callback exchanges the code and upserts an encrypted slack_apps row", async () => {
    const state = mintOAuthState({ secret: SECRET });
    const [r, u] = req(`/slack/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`, {
      cookie: `${OAUTH_COOKIE}=${state}`,
    });
    const calls: Array<{ url: string; body: string }> = [];
    const res = await handleOAuth(r, u, {
      ...baseDeps(),
      fetchFn: (async (url: any, init: any) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return Response.json({
          ok: true,
          app_id: "A0OAUTH",
          access_token: "xoxb-oauth-installed",
          bot_user_id: "U0OBOT",
          team: { id: "T0OAUTH", name: "Test Workspace" },
        });
      }) as unknown as typeof fetch,
      upsert: (input) => SlackApps.upsert(input, dbc),
    });
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("T0OAUTH");

    // Exchange call shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("client_id")).toBe("1234.5678");
    expect(form.get("client_secret")).toBe(SECRET);
    expect(form.get("code")).toBe("auth-code-1");

    // Row stored encrypted; decrypts to the exchanged token + env signing secret.
    const row = await SlackApps.find("A0OAUTH", "T0OAUTH", dbc);
    expect(row).not.toBeNull();
    expect(isEncrypted(row!.bot_token)).toBe(true);
    expect(isEncrypted(row!.signing_secret)).toBe(true);
    expect(row!.bot_token).not.toContain("xoxb-oauth-installed");
    const secrets = SlackApps.decryptTokens(row!);
    expect(secrets.botToken).toBe("xoxb-oauth-installed");
    expect(secrets.signingSecret).toBe("app-signing-secret");
    expect(row!.bot_user_id).toBe("U0OBOT");
  });

  it("callback 502s when slack rejects the exchange", async () => {
    const state = mintOAuthState({ secret: SECRET });
    const [r, u] = req(`/slack/oauth/callback?code=bad&state=${encodeURIComponent(state)}`, {
      cookie: `${OAUTH_COOKIE}=${state}`,
    });
    const res = await handleOAuth(r, u, {
      ...baseDeps(),
      fetchFn: (async () => Response.json({ ok: false, error: "invalid_code" })) as unknown as typeof fetch,
    });
    expect(res!.status).toBe(502);
    expect(await res!.text()).toContain("invalid_code");
  });

  it("callback 503s without a signing secret (nothing stored)", async () => {
    const state = mintOAuthState({ secret: SECRET });
    const [r, u] = cbReq(state);
    const res = await handleOAuth(r, u, { ...baseDeps(), signingSecret: "" });
    expect(res!.status).toBe(503);
  });
});

describe("transport mounting", () => {
  const booted: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    while (booted.length) await booted.pop()!.stop();
  });

  async function bootTransport(oauth?: Record<string, unknown>) {
    const t = createHttpSlackTransport({
      port: 0,
      loadApps: async () => [],
      oauth: { clientId: "1234.5678", clientSecret: SECRET, log: () => {}, ...oauth },
      log: () => {},
    });
    booted.push(t);
    await t.start();
    return `http://127.0.0.1:${t.port}`;
  }

  it("starts with an empty registry when the OAuth flow is enabled", async () => {
    const base = await bootTransport();
    const res = await fetch(`${base}/slack/oauth/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("slack.com/oauth/v2/authorize");
  });

  it("404s the oauth endpoints when no client id is configured", async () => {
    const t = createHttpSlackTransport({
      port: 0,
      loadApps: async () => [],
      oauth: { clientId: "", log: () => {} },
      log: () => {},
    });
    booted.push(t);
    // No oauth flow AND empty registry: boots anyway (bun run slack-app add
    // can register an app against the running process — see
    // http-transport.test.ts's "picks up an app registered after boot").
    // The oauth endpoints stay 404 since the flow itself is disabled.
    await t.start();
    const res = await fetch(`http://127.0.0.1:${t.port}/slack/oauth/start`);
    expect(res.status).toBe(404);
  });

  it("installs via callback and serves the new workspace without restart", async () => {
    const rows: SlackApps.SlackAppRow[] = [];
    const t = createHttpSlackTransport({
      port: 0,
      loadApps: async () => [...rows],
      oauth: {
        clientId: "1234.5678",
        clientSecret: SECRET,
        signingSecret: "app-signing-secret",
        log: () => {},
        fetchFn: (async () =>
          Response.json({
            ok: true,
            app_id: "A0LIVE",
            access_token: "xoxb-live",
            bot_user_id: "U0LIVE",
            team: { id: "T0LIVE" },
          })) as unknown as typeof fetch,
        upsert: async (input) => {
          const row = await SlackApps.upsert(input, dbc);
          rows.push(row);
          return row;
        },
      },
      makeClient: () => ({ auth: { test: async () => ({ ok: true }) } }) as any,
      log: () => {},
    });
    booted.push(t);
    await t.start();
    const base = `http://127.0.0.1:${t.port}`;
    const state = mintOAuthState({ secret: SECRET });
    const res = await fetch(
      `${base}/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${OAUTH_COOKIE}=${state}` } },
    );
    expect(res.status).toBe(200);
    // The registry reloaded: an event for the new app no longer 404s on the
    // unknown-app lookup (it now fails signature verification instead).
    const evt = JSON.stringify({
      type: "event_callback",
      api_app_id: "A0LIVE",
      team_id: "T0LIVE",
      event: { type: "message", text: "hi" },
    });
    const evtRes = await fetch(`${base}/slack/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: evt,
    });
    expect(evtRes.status).toBe(401); // known app, unsigned request
  });
});

describe("manifest oauth redirect", () => {
  it("http mode emits redirect_urls when provided", () => {
    const m = buildManifest({
      mode: "http",
      url: "https://gw.example.com",
      oauthRedirectUrl: "https://gw.example.com/slack/oauth/callback",
    });
    expect(m.oauth_config.redirect_urls).toEqual(["https://gw.example.com/slack/oauth/callback"]);
    expect(m.oauth_config.scopes.bot).toEqual([...BOT_SCOPES]);
  });

  it("socket mode never emits redirect_urls", () => {
    const m = buildManifest({ mode: "socket", oauthRedirectUrl: "https://x.example.com/cb" });
    expect(m.oauth_config.redirect_urls).toBeUndefined();
  });
});

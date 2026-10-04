/**
 * HTTP Slack transport — Events API + interactivity receiver (spec §5).
 *
 * Replaces Socket Mode in production (`SLAUDE_SLACK_MODE=http`) while keeping
 * the `Transport` interface unchanged, so `createGateway` is oblivious to the
 * ingress. One `Bun.serve` port carries everything: `POST /slack/events`,
 * `POST /slack/interactions`, plus `/healthz`, `/readyz`, `/metrics` when
 * health deps are passed (the standalone health server is not started in
 * http mode).
 *
 * Request flow per spec §5:
 *   1. parse `api_app_id` + team id → `slack_apps` lookup; unknown app → 404
 *   2. verify `X-Slack-Signature` over the RAW body (v0 HMAC, 5-min window)
 *   3. `url_verification` → echo challenge
 *   4. log `X-Slack-Retry-Num` (dedup itself is the gateway's seen-events job)
 *   5. respond 200 immediately; dispatch to handlers asynchronously with the
 *      same argument shapes the Socket Mode transport produces
 *
 * Multi-app: the transport holds one WebClient per registered (app, team) row
 * and resolves the client per request. Outbound calls take `clientFor(app)`,
 * which resolves the app a session, cron job or gate belongs to (D1.2);
 * `transport.client` lazily proxies to the primary app — the oldest
 * registered row — for callers with no identity. Both block until start().
 *
 * NOT here on purpose: `/slack/commands` — slaude has no Bolt slash-command
 * handlers; slash commands are plain message text parsed by commands.ts, so
 * they arrive through /slack/events like any other message.
 */
import type {
  ActionHandler,
  AppRef,
  EventHandler,
  Middleware,
  Transport,
  WebClientLike,
} from "../core/transport";
import * as SlackApps from "../../db/slack-apps";
import type { SlackAppRow } from "../../db/slack-apps";
import { handleOAuth, type OAuthDeps } from "./oauth";
import { verifySlackSignature } from "./verify";
import { healthRoutes, type HealthDeps } from "../../health";
import { env } from "../../config/env";
import { m } from "../../metrics";
import { readBodyCapped } from "../api/http";

type AppEntry = {
  row: SlackAppRow;
  signingSecret: string;
  client: WebClientLike;
  /** Decrypted bot token of THIS app, handed to event handlers (attachment download). */
  botToken: string;
};

export type HttpTransportOptions = {
  /** Listen port. Default SLAUDE_HTTP_PORT (8080); 0 = ephemeral (tests). */
  port?: number;
  /** Max request-body bytes. Default SLAUDE_HTTP_MAX_BODY_BYTES (1_000_000). */
  maxBodyBytes?: number;
  /** When set, /healthz /readyz /metrics are served on the same port. */
  health?: HealthDeps;
  /** Registry loader. Default: SlackApps.list() on the process db facade. */
  loadApps?: () => Promise<SlackAppRow[]>;
  /** Secret decryption. Default: SlackApps.decryptTokens (SLAUDE_MASTER_KEY). */
  decryptTokens?: (row: SlackAppRow) => { botToken: string; signingSecret: string };
  /** WebClient factory (test seam). Default: @slack/web-api WebClient. */
  makeClient?: (botToken: string) => WebClientLike;
  /** fetch used for response_url posting (test seam). */
  fetchFn?: typeof fetch;
  /** OAuth install flow seams (spec §5 model B). Endpoints are mounted only
   *  when SLACK_CLIENT_ID (or oauth.clientId) is set. */
  oauth?: OAuthDeps;
  now?: () => number;
  log?: (msg: string) => void;
};

export interface HttpSlackTransport extends Transport {
  /** Bound port once started (0-port resolves to the real one). */
  readonly port: number | null;
}

export function createHttpSlackTransport(opts: HttpTransportOptions = {}): HttpSlackTransport {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? fetch;
  const loadApps = opts.loadApps ?? (() => SlackApps.list());
  const decryptTokens = opts.decryptTokens ?? SlackApps.decryptTokens;
  const makeClient =
    opts.makeClient ??
    ((botToken: string): WebClientLike => {
      // Lazy import so tests (and socket-mode deploys) never construct the SDK client.
      const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");
      const slackApiUrl = env.slack.apiUrl();
      return new WebClient(botToken, slackApiUrl ? { slackApiUrl } : undefined) as unknown as WebClientLike;
    });

  const events = new Map<string, EventHandler[]>();
  const actions: Array<{ id: string | RegExp; h: ActionHandler }> = [];
  const middlewares: Middleware[] = [];

  /** (api_app_id:team_id) → entry; byApp groups installs of one app. */
  const entries = new Map<string, AppEntry>();
  const byApp = new Map<string, AppEntry[]>();
  let primary: AppEntry | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });

  /** (Re)build the app registry from loadApps(). Called at start() and again
   *  after a successful OAuth install. Resolves `started` once a primary
   *  (oldest-registered) app exists. */
  async function reloadRegistry(): Promise<SlackAppRow[]> {
    const rows = await loadApps();
    entries.clear();
    byApp.clear();
    primary = null;
    for (const row of rows) {
      const { botToken, signingSecret } = decryptTokens(row);
      const entry: AppEntry = { row, signingSecret, client: makeClient(botToken), botToken };
      entries.set(`${row.api_app_id}:${row.team_id}`, entry);
      const group = byApp.get(row.api_app_id) ?? [];
      group.push(entry);
      byApp.set(row.api_app_id, group);
      primary ??= entry;
    }
    if (primary) resolveStarted();
    return rows;
  }

  /** Cheap lazy pickup for `bun run slack-app add` run against a live process
   *  with no OAuth install to trigger the reload above: re-query the registry
   *  once when it's empty (a boot-transient state, not a steady one) so the
   *  first inbound request after registration finds the app instead of 404ing
   *  forever until a restart. No-ops once at least one app has loaded. */
  async function ensureRegistryLoaded(): Promise<void> {
    if (entries.size === 0) await reloadRegistry().catch(() => {});
  }

  async function runMiddlewares(payload: any): Promise<void> {
    let i = 0;
    const next = async (): Promise<void> => {
      const mw = middlewares[i++];
      if (mw) await mw({ payload, next });
    };
    await next();
  }

  async function dispatchEvent(body: any, entry: AppEntry): Promise<void> {
    const event = body.event;
    await runMiddlewares(event);
    const context = {
      teamId: body.team_id ?? event.team,
      apiAppId: body.api_app_id,
      botUserId: entry.row.bot_user_id ?? undefined,
      botToken: entry.botToken,
    };
    for (const h of events.get(event.type) ?? []) {
      await h({ event, client: entry.client, context });
    }
  }

  async function dispatchInteraction(payload: any, entry: AppEntry): Promise<void> {
    await runMiddlewares(payload);
    const respond = async (msg: any) => {
      if (!payload.response_url) {
        log("[slack-http] respond() with no response_url — dropped");
        return;
      }
      const res = await fetchFn(payload.response_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw new Error(`response_url post failed: ${res.status}`);
    };
    for (const action of payload.actions ?? []) {
      const entryH = actions.find((a) =>
        typeof a.id === "string" ? a.id === action.action_id : a.id.test(action.action_id),
      );
      if (!entryH) {
        log(`[slack-http] no action handler matches ${action.action_id}`);
        continue;
      }
      // The HTTP 200 already acked the request; ack() is a no-op here.
      await entryH.h({ ack: async () => {}, action, body: payload, respond });
    }
  }

  /** Fire-and-forget after the 200 ack; errors are logged, never re-thrown
   *  into the HTTP path (Slack would retry an event slaude already took). */
  function detach(work: () => Promise<void>, what: string) {
    queueMicrotask(() => {
      work().catch((e) => log(`[slack-http] ${what} handler failed: ${e?.message ?? e}`));
    });
  }

  function verifyFor(entry: AppEntry, rawBody: string, req: Request) {
    return verifySlackSignature({
      signingSecret: entry.signingSecret,
      rawBody,
      timestamp: req.headers.get("x-slack-request-timestamp"),
      signature: req.headers.get("x-slack-signature"),
      nowMs: now(),
    });
  }

  // Deliberately NO dedup here: retried deliveries are dispatched too. The
  // gateway layer owns cross-replica dedup — the in-memory seenEvents set in
  // core/gateway.ts, being replaced by the durable Postgres `seen_events`
  // table (spec §4/§5 step 4, milestone M2) — so every replica drops
  // duplicates consistently no matter which one Slack retried against.
  function logRetry(req: Request, body: any) {
    const retry = req.headers.get("x-slack-retry-num");
    if (retry) {
      const reason = req.headers.get("x-slack-retry-reason") ?? "?";
      log(
        `[slack-http] slack retry #${retry} (${reason}) event_id=${body?.event_id ?? "-"} — gateway dedup decides`,
      );
    }
  }

  const maxBodyBytes = opts.maxBodyBytes ?? env.slack.httpMaxBodyBytes();

  /** Buffer the request body under the size cap, BEFORE any signature work.
   *  Returns null when the cap is exceeded (caller sends 413). */
  const readCapped = (req: Request) => readBodyCapped(req, maxBodyBytes);

  async function handleEvents(req: Request, raw: string): Promise<Response> {
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    await ensureRegistryLoaded();

    // url_verification carries no team id — try every install of the app
    // (or every registered app when api_app_id is absent).
    if (body.type === "url_verification") {
      const candidates = body.api_app_id ? (byApp.get(body.api_app_id) ?? []) : [...entries.values()];
      if (candidates.length === 0) return new Response("unknown app", { status: 404 });
      for (const entry of candidates) {
        if (verifyFor(entry, raw, req).ok) return Response.json({ challenge: body.challenge });
      }
      return new Response("invalid signature", { status: 401 });
    }

    const teamId = body.team_id ?? body.event?.team;
    const entry = entries.get(`${body.api_app_id}:${teamId}`);
    if (!entry) return new Response("unknown app", { status: 404 });

    const v = verifyFor(entry, raw, req);
    if (!v.ok) {
      log(`[slack-http] rejected /slack/events: ${v.reason}`);
      return new Response("invalid signature", { status: 401 });
    }

    logRetry(req, body);

    if (body.type === "event_callback" && body.event?.type) {
      m.gatewayEventsTotal.inc({ type: body.event.type });
      detach(() => dispatchEvent(body, entry), `event ${body.event.type}`);
    }
    // Anything else (app_rate_limited, unknown envelope) is acked and dropped.
    return new Response("", { status: 200 });
  }

  async function handleInteractions(req: Request, raw: string): Promise<Response> {
    // Interactions arrive form-encoded: payload=<json>. Signature covers the
    // raw form body, so parse only after grabbing `raw`.
    let payload: any;
    try {
      const encoded = new URLSearchParams(raw).get("payload");
      if (!encoded) return new Response("bad request", { status: 400 });
      payload = JSON.parse(encoded);
      if (typeof payload !== "object" || payload === null) {
        return new Response("bad request", { status: 400 });
      }
    } catch {
      return new Response("bad request", { status: 400 });
    }

    await ensureRegistryLoaded();

    const teamId = payload?.team?.id ?? payload?.user?.team_id;
    const entry = entries.get(`${payload?.api_app_id}:${teamId}`);
    if (!entry) return new Response("unknown app", { status: 404 });

    const v = verifyFor(entry, raw, req);
    if (!v.ok) {
      log(`[slack-http] rejected /slack/interactions: ${v.reason}`);
      return new Response("invalid signature", { status: 401 });
    }

    detach(() => dispatchInteraction(payload, entry), `interaction ${payload.type ?? "?"}`);
    // Empty 200 acks the click; button removal happens via respond(response_url).
    return new Response("", { status: 200 });
  }

  const health = opts.health ? healthRoutes(opts.health) : null;

  async function handleSlack(req: Request, pathname: string): Promise<Response> {
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    // Size cap first — an oversize body is refused before any buffering
    // completes and before any signature work.
    const raw = await readCapped(req);
    if (raw === null) {
      log(`[slack-http] rejected ${pathname}: body over ${maxBodyBytes} bytes`);
      // The unread remainder of the upload would poison a kept-alive
      // connection for the next request — force a close.
      return new Response("payload too large", {
        status: 413,
        headers: { connection: "close" },
      });
    }
    // Slack's SSL certificate probe (`ssl_check=1` form post, sent when the
    // request URL is saved). Bolt semantics: bare 200, no signature check,
    // no dispatch — on either endpoint.
    if (
      (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded") &&
      new URLSearchParams(raw).get("ssl_check")
    ) {
      return new Response("", { status: 200 });
    }
    return pathname === "/slack/events" ? handleEvents(req, raw) : handleInteractions(req, raw);
  }

  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (health) {
      const r = await health(req, url);
      if (r) return r;
    }
    if (url.pathname === "/slack/events" || url.pathname === "/slack/interactions") {
      const res = await handleSlack(req, url.pathname);
      // Every ingress response is counted — 200s and rejects (401/404/400/413).
      m.httpRequestsTotal.inc({ route: url.pathname, status: String(res.status) });
      return res;
    }
    if (url.pathname.startsWith("/slack/oauth/")) {
      // OAuth install flow (spec §5 model B); null = disabled/unknown → 404.
      const res = await handleOAuth(req, url, { log, ...opts.oauth });
      if (res) {
        m.httpRequestsTotal.inc({ route: url.pathname, status: String(res.status) });
        // A successful install added a slack_apps row — pick it up without a
        // restart so the new workspace's events resolve immediately.
        if (url.pathname === "/slack/oauth/callback" && res.status === 200) {
          await reloadRegistry().catch((e) =>
            log(`[slack-http] registry reload after install failed: ${e?.message ?? e}`),
          );
        }
        return res;
      }
    }
    return new Response("not found", { status: 404 });
  }

  /** The registered app `app` names (D1.2). An exact (app, team) pair wins; a
   *  partial identity (rows written before the app was recorded) resolves only
   *  when exactly one registered app matches it; with a single registered app
   *  that app answers an identity naming NO app. An identity naming an app that
   *  is not registered (uninstalled) never falls through to another app.
   *  Anything else throws: posting as some other app is the defect this
   *  replaces. */
  function resolveEntry(app: AppRef): AppEntry {
    if (app.apiAppId && app.teamId) {
      const exact = entries.get(`${app.apiAppId}:${app.teamId}`);
      if (exact) return exact;
    } else if (app.apiAppId || app.teamId) {
      const matches = [...entries.values()].filter(
        (e) => (!app.apiAppId || e.row.api_app_id === app.apiAppId) && (!app.teamId || e.row.team_id === app.teamId),
      );
      if (matches.length === 1) return matches[0]!;
    }
    if (!app.apiAppId && entries.size === 1 && primary) return primary;
    throw new Error(
      `[slack-http] no registered Slack app for app=${app.apiAppId ?? "-"} team=${app.teamId ?? "-"} (${entries.size} registered)`,
    );
  }

  // Gateway construction touches clients before start() (boot-time agent-id
  // resolution fires auth.test asynchronously). A recursive Proxy forwards any
  // `a.b.c(...)` to the client `resolve` picks: the call parks on `started`,
  // then resolves the same path on the real client. A hand-listed proxy missed
  // methods twice, so a new Slack method must not need a change here.
  // Property names that serializers, inspectors and promise machinery probe: they
  // must read as absent, not as a callable that fires a (rejecting) Slack call.
  const PROBES = new Set(["then", "toJSON", "inspect", "valueOf", "toString", "asymmetricMatch", "$$typeof", "nodeType"]);
  const lazyAt = (resolve: () => AppEntry, path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, key) => (typeof key === "symbol" || PROBES.has(key) ? undefined : lazyAt(resolve, [...path, key])),
      apply: (_t, _this, args) =>
        started.then(() => {
          let parent: any = resolve().client;
          let fn: any = parent;
          for (const k of path) {
            parent = fn;
            fn = fn[k];
          }
          // An unknown method is not a function: this throws the TypeError a real client would.
          return Reflect.apply(fn, parent, args);
        }),
    });
  // The ROOT must not be callable: SlackSurface and Reactions treat a function
  // argument as a client resolver and would call it, getting a Promise back.
  const lazyRoot = (resolve: () => AppEntry): WebClientLike =>
    new Proxy({} as object, {
      get: (_t, key) => (typeof key === "symbol" || PROBES.has(key) ? undefined : lazyAt(resolve, [key])),
    }) as WebClientLike;
  /** App-level client: the primary (oldest-registered) app. Kept for callers
   *  with no identity at all; outbound paths use clientFor(). */
  const lazyClient = lazyRoot(() => primary!);
  /** One lazy client per identity, resolved per call so a registry reload
   *  (token rotation, a new install) reaches clients already held. */
  const perApp = new Map<string, WebClientLike>();

  return {
    client: lazyClient,
    clientFor(app: AppRef): WebClientLike {
      const key = `${app.apiAppId ?? ""}:${app.teamId ?? ""}`;
      let c = perApp.get(key);
      if (!c) {
        const ref = { apiAppId: app.apiAppId, teamId: app.teamId };
        c = lazyRoot(() => resolveEntry(ref));
        perApp.set(key, c);
      }
      return c;
    },
    botTokenFor(app: AppRef): string | undefined {
      try {
        return resolveEntry(app).botToken;
      } catch {
        return undefined;
      }
    },
    async apps() {
      await started;
      return [...entries.values()].map((e) => ({
        apiAppId: e.row.api_app_id,
        teamId: e.row.team_id,
        botUserId: e.row.bot_user_id ?? undefined,
        client: e.client,
      }));
    },
    get port() {
      return server?.port ?? null;
    },
    action(idOrRegex, h) {
      actions.push({ id: idOrRegex, h });
    },
    event(name, h) {
      const list = events.get(name) ?? [];
      list.push(h);
      events.set(name, list);
    },
    use(mw) {
      middlewares.push(mw);
    },
    async start() {
      const rows = await reloadRegistry();
      const oauthEnabled = Boolean(opts.oauth?.clientId ?? env.slack.clientId());
      if (rows.length === 0) {
        if (!oauthEnabled) {
          // Boot anyway rather than crash-looping a container: `bun run
          // slack-app add` runs against the same Postgres from a separate
          // process, and ensureRegistryLoaded() below picks up the new row
          // on the next inbound request — no restart needed.
          log(
            "[slack-http] slack_apps registry is empty — waiting for an app " +
              "to be registered (bun run slack-app add); requests 404 until then",
          );
        } else {
          // OAuth install flow enabled: an empty registry is the expected state
          // of a fresh deploy — the first /slack/oauth/start install populates it.
          log("[slack-http] slack_apps registry is empty — awaiting OAuth install (/slack/oauth/start)");
        }
      }
      const port = opts.port ?? env.slack.httpPort();
      // idleTimeout 0: /v1/pending long-polls (mounted on this port in http
      // mode) hold requests open ~30s — Bun's 10s default would kill them.
      server = Bun.serve({ port, idleTimeout: 0, fetch: serve });
      log(
        `[slack-http] listening on :${server.port} (${entries.size} app${entries.size === 1 ? "" : "s"}) — /slack/events /slack/interactions`,
      );
    },
    async stop() {
      await server?.stop();
      server = null;
    },
  };
}

/**
 * Dev-only stub of the portal API: a fetch interceptor over the fixtures, so
 * the portal runs and can be screenshotted without a gateway. Enabled by
 * `VITE_STUB=1 bun run portal:dev`; production builds never include it.
 *
 * URL switches (read once at load, kept for the tab's lifetime):
 *   ?stubDelay=800        response delay in ms (default 250; 0 for none)
 *   ?stubFail=integrations answer 500 for API paths containing the text
 *   ?stubEmpty=1          no linked identities, integrations or agents
 *   ?stubNoAgents=1       identities linked, but no agent grants any role
 *   ?stubHang=my-agents   never answer API paths containing the text (skeletons)
 *   ?stubConnect=exchange-failed  the result a Connect comes back with (default connected)
 *
 * Connect skips the provider: it answers an authorizeUrl that is the portal's
 * own return URL, `/portal?connect=<result>`, as /portal/oauth/callback sends.
 */
import type { ConnectIntegrationResponse, DisconnectIntegrationResponse, UnlinkRequest } from "../../../gateway/portal/api-types";
import { createFixtures } from "./fixtures";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installStub(): void {
  const params = new URLSearchParams(location.search);
  const sticky = (k: string) => {
    const v = params.get(k);
    try {
      if (v !== null) sessionStorage.setItem(`slaude.stub.${k}`, v);
      return v ?? sessionStorage.getItem(`slaude.stub.${k}`);
    } catch {
      return v;
    }
  };
  const delay = Number(sticky("stubDelay") ?? 250);
  const fail = sticky("stubFail");
  const hang = sticky("stubHang");
  const empty = sticky("stubEmpty") === "1";
  const noAgents = sticky("stubNoAgents") === "1";
  const connectResult = sticky("stubConnect") ?? "connected";

  const fx = createFixtures();
  if (empty) {
    fx.me.slackIdentities = [];
    fx.integrations = [];
    fx.agents = [];
  }
  if (noAgents) fx.agents = [];
  // A connect leaves the page, so remember what it connected for the reload.
  const CONNECTED = "slaude.stub.portalConnected";
  try {
    const ids: string[] = JSON.parse(sessionStorage.getItem(CONNECTED) ?? "[]");
    for (const i of fx.integrations) {
      if (ids.includes(i.id)) Object.assign(i, { connected: true, expiresAt: Date.now() + 3_600_000 });
    }
  } catch {
    /* no storage: start from the fixtures */
  }

  const realFetch = window.fetch.bind(window);

  function handle(method: string, path: string, body: unknown): Response {
    if (path === "/auth/me") return json(200, { email: fx.me.email });
    if (path === "/auth/refresh" || path === "/auth/logout") return json(200, { ok: true });
    if (path === "/api/me") return method === "GET" ? json(200, fx.me) : json(405, { error: "method not allowed" });
    if (path === "/api/my-agents") return json(200, { agents: fx.agents });
    if (path === "/api/link") {
      if (method !== "DELETE") return json(405, { error: "method not allowed" });
      const b = (body ?? {}) as Partial<UnlinkRequest>;
      if (!b.teamId || !b.slackUserId) return json(400, { error: "teamId and slackUserId are required" });
      const before = fx.me.slackIdentities.length;
      fx.me.slackIdentities = fx.me.slackIdentities.filter((s) => s.teamId !== b.teamId || s.slackUserId !== b.slackUserId);
      return fx.me.slackIdentities.length < before ? json(200, { ok: true }) : json(404, { error: "no such connection on your account" });
    }
    const seg = path.split("/").filter(Boolean); // ["api", "integrations", ...]
    if (seg[1] === "integrations") {
      if (seg.length === 2) return json(200, { integrations: fx.integrations });
      const id = decodeURIComponent(seg[2]!);
      const row = fx.integrations.find((i) => i.id === id);
      if (!row) return json(404, { error: "no such integration" });
      if (seg.length === 4 && seg[3] === "connect" && method === "POST") {
        if (connectResult === "connected") {
          try {
            const ids: string[] = JSON.parse(sessionStorage.getItem(CONNECTED) ?? "[]");
            sessionStorage.setItem(CONNECTED, JSON.stringify([...new Set([...ids, id])]));
          } catch {
            /* no storage */
          }
        }
        return json(200, { authorizeUrl: `/portal/?connect=${encodeURIComponent(connectResult)}` } satisfies ConnectIntegrationResponse);
      }
      if (seg.length === 3 && method === "DELETE") {
        const removed = row.connected;
        Object.assign(row, { connected: false, expiresAt: null });
        try {
          const ids: string[] = JSON.parse(sessionStorage.getItem(CONNECTED) ?? "[]");
          sessionStorage.setItem(CONNECTED, JSON.stringify(ids.filter((x) => x !== id)));
        } catch {
          /* no storage */
        }
        return json(200, { ok: true, removed } satisfies DisconnectIntegrationResponse);
      }
      return json(405, { error: "method not allowed" });
    }
    return json(404, { error: "not found" });
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/portal/")) return realFetch(input, init);
    const path = url.pathname.slice("/portal".length);
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return realFetch(input, init);

    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        return json(400, { error: "malformed JSON body" });
      }
    }
    const signal = init?.signal;
    if (hang && path.includes(hang)) return new Promise<Response>(() => undefined);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    if (fail && path.startsWith("/api/") && path.includes(fail)) return json(500, { error: "The stub was asked to fail this request." });
    return handle(method, path, body);
  };
  console.info("[slaude] portal API stub active (VITE_STUB=1)");
}

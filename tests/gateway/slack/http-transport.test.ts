import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { __resetMasterKeyCache, encrypt } from "../../../src/db/crypto";
import { signSlackRequest } from "../../../src/gateway/slack/verify";
import {
  createHttpSlackTransport,
  type HttpSlackTransport,
} from "../../../src/gateway/slack/http-transport";
import type { SlackAppRow } from "../../../src/db/slack-apps";
import type { WebClientLike } from "../../../src/gateway/core/transport";

const SECRET_A = "signing-secret-team-a";
const SECRET_B = "signing-secret-team-b";
let prevKey: string | undefined;

beforeAll(() => {
  prevKey = process.env.SLAUDE_MASTER_KEY;
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();
});

afterAll(() => {
  if (prevKey === undefined) delete process.env.SLAUDE_MASTER_KEY;
  else process.env.SLAUDE_MASTER_KEY = prevKey;
  __resetMasterKeyCache();
});

function appRow(over: Partial<SlackAppRow> = {}): SlackAppRow {
  return {
    api_app_id: "A0HTTP",
    team_id: "T0AAA",
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt("xoxb-fake-a"),
    signing_secret: encrypt(SECRET_A),
    bot_user_id: "U0BOT",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function fakeClient(tag: string): WebClientLike {
  return {
    __tag: tag,
    auth: { test: async () => ({ ok: true, user_id: "U0BOT", team: "T0AAA" }) },
    chat: {
      postMessage: async (a: any) => ({ ok: true, echo: a }),
      update: async (a: any) => ({ ok: true, echo: a }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: {
      info: async () => ({ ok: true }),
      members: async () => ({ ok: true }),
      replies: async () => ({ ok: true }),
    },
    users: {
      info: async () => ({ ok: true }),
      profile: { set: async () => ({ ok: true }) },
    },
    search: { messages: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true, status: "set" }) } },
  } as any;
}

type Boot = {
  t: HttpSlackTransport;
  base: string;
  logs: string[];
  clients: Map<string, WebClientLike>;
};

const booted: HttpSlackTransport[] = [];
afterEach(async () => {
  while (booted.length) await booted.pop()!.stop();
});

async function boot(
  rows: SlackAppRow[] = [appRow()],
  extra: Partial<Parameters<typeof createHttpSlackTransport>[0]> = {},
): Promise<Boot> {
  const logs: string[] = [];
  const clients = new Map<string, WebClientLike>();
  const t = createHttpSlackTransport({
    port: 0,
    loadApps: async () => rows,
    makeClient: (token) => {
      const c = fakeClient(token);
      clients.set(token, c);
      return c;
    },
    log: (m) => logs.push(m),
    ...extra,
  });
  booted.push(t);
  await t.start();
  return { t, base: `http://127.0.0.1:${t.port}`, logs, clients };
}

function signedHeaders(secret: string, raw: string, over: Record<string, string> = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlackRequest(secret, ts, raw),
    ...over,
  };
}

function eventEnvelope(over: any = {}) {
  return {
    type: "event_callback",
    api_app_id: "A0HTTP",
    team_id: "T0AAA",
    event_id: "Ev0000000001",
    event: {
      type: "message",
      channel: "C0CHAN",
      user: "U0USER",
      text: "hello",
      ts: "111.222",
      team: "T0AAA",
      ...over,
    },
  };
}

async function postEvents(base: string, secret: string, body: any, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/slack/events`, {
    method: "POST",
    headers: signedHeaders(secret, raw, headers),
    body: raw,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("http slack transport — events", () => {
  it("dispatches a signed event with socket-transport handler arg shapes", async () => {
    const seen: any[] = [];
    const { t, base, clients } = await boot();
    t.event("message", async (args) => {
      seen.push(args);
    });
    const res = await postEvents(base, SECRET_A, eventEnvelope());
    expect(res.status).toBe(200);
    await settle();
    expect(seen.length).toBe(1);
    expect(seen[0].event.type).toBe("message");
    expect(seen[0].event.text).toBe("hello");
    expect(seen[0].context.teamId).toBe("T0AAA");
    expect(seen[0].client).toBe(clients.get("xoxb-fake-a")!);
  });

  it("runs use() middleware before handlers with the inner event as payload", async () => {
    const order: string[] = [];
    const { t, base } = await boot();
    t.use(async ({ payload, next }) => {
      order.push(`mw:${payload.type}`);
      await next();
    });
    t.event("message", async () => {
      order.push("handler");
    });
    await postEvents(base, SECRET_A, eventEnvelope());
    await settle();
    expect(order).toEqual(["mw:message", "handler"]);
  });

  it("rejects an invalid signature with 401 and never dispatches", async () => {
    const seen: any[] = [];
    const { t, base, logs } = await boot();
    t.event("message", async (a) => {
      seen.push(a);
    });
    const res = await postEvents(base, "wrong-secret", eventEnvelope());
    expect(res.status).toBe(401);
    await settle();
    expect(seen.length).toBe(0);
    expect(logs.some((l) => l.includes("mismatch"))).toBe(true);
  });

  it("rejects a stale timestamp with 401", async () => {
    const { base } = await boot();
    const raw = JSON.stringify(eventEnvelope());
    const oldTs = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const res = await fetch(`${base}/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": oldTs,
        "x-slack-signature": signSlackRequest(SECRET_A, oldTs, raw),
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown (api_app_id, team_id)", async () => {
    const { base } = await boot();
    const res = await postEvents(base, SECRET_A, eventEnvelope({ team: "T0NOPE" }) , {});
    // envelope team_id also unknown
    const raw = JSON.stringify({ ...eventEnvelope(), team_id: "T0NOPE" });
    const res2 = await fetch(`${base}/slack/events`, {
      method: "POST",
      headers: signedHeaders(SECRET_A, raw),
      body: raw,
    });
    expect(res.status).toBe(200); // envelope team_id still T0AAA → known
    expect(res2.status).toBe(404);
  });

  it("echoes url_verification challenge after verifying the signature", async () => {
    const { base } = await boot();
    const body = { type: "url_verification", api_app_id: "A0HTTP", challenge: "ch4ll" };
    const res = await postEvents(base, SECRET_A, body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).challenge).toBe("ch4ll");
    // Without api_app_id it still resolves by trying every registered app.
    const res2 = await postEvents(base, SECRET_A, { type: "url_verification", challenge: "x2" });
    expect(((await res2.json()) as any).challenge).toBe("x2");
    // Bad signature → 401, unknown app id → 404.
    const res3 = await postEvents(base, "wrong", { type: "url_verification", challenge: "x3" });
    expect(res3.status).toBe(401);
    const res4 = await postEvents(base, SECRET_A, {
      type: "url_verification",
      api_app_id: "A0NOPE",
      challenge: "x4",
    });
    expect(res4.status).toBe(404);
  });

  it("acks retries with 200 and logs X-Slack-Retry-Num (dedup stays in the gateway)", async () => {
    const seen: any[] = [];
    const { t, base, logs } = await boot();
    t.event("message", async (a) => {
      seen.push(a);
    });
    const res = await postEvents(base, SECRET_A, eventEnvelope(), {
      "x-slack-retry-num": "2",
      "x-slack-retry-reason": "http_timeout",
    });
    expect(res.status).toBe(200);
    await settle();
    // The transport still dispatches — cross-replica dedup is the gateway's job.
    expect(seen.length).toBe(1);
    expect(logs.some((l) => l.includes("retry #2") && l.includes("http_timeout"))).toBe(true);
  });

  it("400s malformed JSON, drops non-event_callback envelopes, 404s other routes", async () => {
    const { t, base } = await boot();
    const seen: any[] = [];
    t.event("message", async (a) => {
      seen.push(a);
    });
    const bad = await fetch(`${base}/slack/events`, {
      method: "POST",
      headers: signedHeaders(SECRET_A, "{nope"),
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    const dropped = await postEvents(base, SECRET_A, { ...eventEnvelope(), type: "app_rate_limited" });
    expect(dropped.status).toBe(200);
    await settle();
    expect(seen.length).toBe(0);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/slack/events`)).status).toBe(404); // GET
  });

  it("a handler error is logged, not thrown into the HTTP path", async () => {
    const { t, base, logs } = await boot();
    t.event("message", async () => {
      throw new Error("boom-handler");
    });
    const res = await postEvents(base, SECRET_A, eventEnvelope());
    expect(res.status).toBe(200);
    await settle();
    expect(logs.some((l) => l.includes("boom-handler"))).toBe(true);
  });

  it("routes per-team: two registered apps resolve different clients", async () => {
    const rowB = appRow({
      api_app_id: "A0HTTP",
      team_id: "T0BBB",
      bot_token: encrypt("xoxb-fake-b"),
      signing_secret: encrypt(SECRET_B),
      created_at: 2,
    });
    const seen: any[] = [];
    const { t, base, clients } = await boot([appRow(), rowB]);
    t.event("message", async (a) => {
      seen.push(a);
    });
    await postEvents(base, SECRET_B, {
      ...eventEnvelope({ team: "T0BBB" }),
      team_id: "T0BBB",
    });
    // Team B's envelope must verify against B's secret and get B's client.
    await settle();
    expect(seen.length).toBe(1);
    expect(seen[0].context.teamId).toBe("T0BBB");
    expect(seen[0].client).toBe(clients.get("xoxb-fake-b")!);
    // And a signature crossover (team B envelope signed with A's secret) fails.
    const res = await postEvents(base, SECRET_A, { ...eventEnvelope(), team_id: "T0BBB" });
    expect(res.status).toBe(401);
  });
});

describe("http slack transport — interactions", () => {
  function interactionBody(over: any = {}) {
    const payload = {
      type: "block_actions",
      api_app_id: "A0HTTP",
      team: { id: "T0AAA" },
      user: { id: "U0CLICKER" },
      actions: [{ action_id: "slaude_perm:allow:tool1" }],
      ...over,
    };
    return { raw: `payload=${encodeURIComponent(JSON.stringify(payload))}`, payload };
  }

  async function postInteraction(base: string, secret: string, raw: string) {
    return fetch(`${base}/slack/interactions`, {
      method: "POST",
      headers: {
        ...signedHeaders(secret, raw),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: raw,
    });
  }

  it("dispatches a Block Kit action and respond() posts to response_url", async () => {
    // Fake response_url receiver.
    const received: any[] = [];
    const hook = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.json());
        return new Response("ok");
      },
    });
    try {
      const calls: any[] = [];
      const { t, base } = await boot();
      t.action(/^slaude_perm:(allow|always|deny):.+$/, async ({ ack, action, body, respond }) => {
        await ack(); // no-op after the HTTP 200
        calls.push({ action_id: action.action_id, clicker: body.user?.id });
        await respond({ replace_original: true, text: "decided", blocks: [] });
      });
      const { raw } = interactionBody({
        response_url: `http://127.0.0.1:${hook.port}/hook`,
      });
      const res = await postInteraction(base, SECRET_A, raw);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      await settle();
      expect(calls).toEqual([{ action_id: "slaude_perm:allow:tool1", clicker: "U0CLICKER" }]);
      expect(received).toEqual([{ replace_original: true, text: "decided", blocks: [] }]);
    } finally {
      await hook.stop();
    }
  });

  it("string action ids match exactly; unmatched ids are logged and skipped", async () => {
    const calls: string[] = [];
    const { t, base, logs } = await boot();
    t.action("exact:id", async ({ action }) => {
      calls.push(action.action_id);
    });
    const { raw } = interactionBody({ actions: [{ action_id: "exact:id" }, { action_id: "other" }] });
    await postInteraction(base, SECRET_A, raw);
    await settle();
    expect(calls).toEqual(["exact:id"]);
    expect(logs.some((l) => l.includes("no action handler matches other"))).toBe(true);
  });

  it("respond() without a response_url is dropped, failing response_url is surfaced", async () => {
    const { t, base, logs } = await boot();
    let responded = false;
    t.action("exact:id", async ({ respond }) => {
      await respond({ text: "into the void" });
      responded = true;
    });
    const { raw } = interactionBody({ actions: [{ action_id: "exact:id" }] });
    await postInteraction(base, SECRET_A, raw);
    await settle();
    expect(responded).toBe(true);
    expect(logs.some((l) => l.includes("no response_url"))).toBe(true);

    // Now with a response_url that 500s: the handler error is logged.
    const hook = Bun.serve({ port: 0, fetch: async () => new Response("nope", { status: 500 }) });
    try {
      const { raw: raw2 } = interactionBody({
        actions: [{ action_id: "exact:id" }],
        response_url: `http://127.0.0.1:${hook.port}/hook`,
      });
      await postInteraction(base, SECRET_A, raw2);
      await settle();
      expect(logs.some((l) => l.includes("response_url post failed: 500"))).toBe(true);
    } finally {
      await hook.stop();
    }
  });

  it("401s bad signatures, 404s unknown apps, 400s malformed payloads", async () => {
    const { base } = await boot();
    const { raw } = interactionBody();
    expect((await postInteraction(base, "wrong-secret", raw)).status).toBe(401);
    const { raw: rawUnknown } = interactionBody({ team: { id: "T0NOPE" } });
    expect((await postInteraction(base, SECRET_A, rawUnknown)).status).toBe(404);
    expect((await postInteraction(base, SECRET_A, "not-a-payload")).status).toBe(400);
  });

  it("falls back to user.team_id when the payload has no team object", async () => {
    const calls: string[] = [];
    const { t, base } = await boot();
    t.action("exact:id", async ({ action }) => {
      calls.push(action.action_id);
    });
    const { raw } = interactionBody({
      team: undefined,
      user: { id: "U0CLICKER", team_id: "T0AAA" },
      actions: [{ action_id: "exact:id" }],
    });
    await postInteraction(base, SECRET_A, raw);
    await settle();
    expect(calls).toEqual(["exact:id"]);
  });
});

describe("http slack transport — lifecycle and client proxy", () => {
  it("start() throws when the registry is empty", async () => {
    const t = createHttpSlackTransport({ port: 0, loadApps: async () => [] });
    await expect(t.start()).rejects.toThrow(/slack_apps registry is empty/);
    expect(t.port).toBeNull();
    await t.stop(); // no-op on an unstarted transport
  });

  it("transport.client parks until start() then proxies every method to the primary app", async () => {
    const logs: string[] = [];
    const clients = new Map<string, WebClientLike>();
    const t = createHttpSlackTransport({
      port: 0,
      loadApps: async () => [
        appRow(),
        appRow({ team_id: "T0BBB", bot_token: encrypt("xoxb-fake-b"), signing_secret: encrypt(SECRET_B), created_at: 2 }),
      ],
      makeClient: (token) => {
        const c = fakeClient(token);
        clients.set(token, c);
        return c;
      },
      log: (m) => logs.push(m),
    });
    booted.push(t);
    // Called BEFORE start — must park, not throw (gateway boots auth.test early).
    const early = t.client.auth.test();
    await t.start();
    expect(((await early) as any).ok).toBe(true);

    // Primary = oldest row (created_at 1) → client built from token a.
    const c: any = t.client;
    expect((await c.chat.postMessage({ text: "x" })).echo.text).toBe("x");
    expect((await c.chat.update({ ts: "1" })).ok).toBe(true);
    expect((await c.reactions.add({})).ok).toBe(true);
    expect((await c.reactions.remove({})).ok).toBe(true);
    expect((await c.conversations.info({})).ok).toBe(true);
    expect((await c.conversations.members({})).ok).toBe(true);
    expect((await c.conversations.replies({})).ok).toBe(true);
    expect((await c.users.info({})).ok).toBe(true);
    expect((await c.users.profile.set({})).ok).toBe(true);
    expect((await c.search.messages({})).ok).toBe(true);
    expect((await c.assistant.threads.setStatus({})).status).toBe("set");
    expect(logs.some((l) => l.includes("2 apps"))).toBe(true);
  });

  it("default makeClient constructs a real @slack/web-api WebClient (no network)", async () => {
    const t = createHttpSlackTransport({
      port: 0,
      loadApps: async () => [appRow()],
      log: () => {},
    });
    booted.push(t);
    await t.start();
    expect(t.port).toBeGreaterThan(0);
  });

  it("serves health endpoints on the same port when health deps are passed", async () => {
    const { base } = await boot([appRow()], { health: { liveSessions: () => 5 } });
    const h = (await (await fetch(`${base}/healthz`)).json()) as any;
    expect(h.status).toBe("ok");
    expect(h.sessions_live).toBe(5);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const m = await fetch(`${base}/metrics`);
    expect(m.status).toBe(200);
    expect(m.headers.get("content-type")).toContain("text/plain");
  });
});

/**
 * Control-panel integration (design §Testing). Real-Redis-gated, gateway role
 * with a live node — the same topology Slack drives, plus the /panel surface.
 *
 * Covers: session list ∩ warm registry; SSE tails events:<id>; the
 * active-surface lock's two gates (inbound Slack deferred + one notice +
 * replay on release; outbound Slack suppressed while the operator drives, with
 * the event stream still flowing); TTL auto-resume; force-release; and the
 * fail-closed / not-mounted guards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  realEnabled,
  until,
  sleep,
  cleanupPrefix,
  setupScenarioEnv,
  teardownScenarioEnv,
  bootReplica,
  bootNode,
  dm,
  replies,
  REAL_URL,
  testPrefix,
  type Replica,
} from "./harness";
import { mintSession, AT_COOKIE } from "../../src/gateway/panel/auth/session";

const d = describe.skipIf(!realEnabled);

const CH = "D0PANEL";
const T1 = "9100.1";
const PANEL_SECRET = "t".repeat(32);
/** Cookie header for an authenticated operator in tests. */
function opCookie(email = "op@example.com"): string {
  return `${AT_COOKIE}=${mintSession({ sub: "s", email }, "at", { secret: PANEL_SECRET })}`;
}
const HDR = { cookie: opCookie(), "x-panel-csrf": "1" };

let redis: any;
let keys: any;
let registry: any;
let pubsub: any;
let sessions: any;
let gw: Replica;
let node: { agent: any; worker: any };

beforeAll(async () => {
  if (!realEnabled) return;
  await setupScenarioEnv();
  process.env.SLAUDE_PANEL_SECRET = PANEL_SECRET;
  process.env.SLAUDE_PANEL_OPERATORS = "op@example.com,op2@example.com";
  const { makeKeys } = await import("../../src/queue/keys");
  const { makeRegistry } = await import("../../src/queue/registry");
  const { makePubSub } = await import("../../src/queue/pubsub");
  const { Redis } = await import("ioredis");
  sessions = await import("../../src/db/sessions");

  keys = makeKeys(testPrefix("panel"));
  redis = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  const sub = new Redis(REAL_URL, { maxRetriesPerRequest: null });
  registry = makeRegistry({ redis, keys, heartbeatSec: 1 });
  pubsub = makePubSub({ redis, sub, keys });

  gw = await bootReplica(keys, { panel: true });
  node = await bootNode(keys, gw.url, { nodeId: "panel-node-A" });
  node.agent.run = async ({ ctx }: any) => ctx.surface.reply({ text: "panel-reply via=panel-node-A" });
});

afterAll(async () => {
  if (!realEnabled) return;
  await node?.worker.stop({ drainSec: 1 }).catch(() => {});
  await gw?.stop().catch(() => {});
  if (redis) await cleanupPrefix(redis, keys.prefix);
  try {
    await redis?.quit();
  } catch {}
  delete process.env.SLAUDE_PANEL_SECRET;
  delete process.env.SLAUDE_PANEL_OPERATORS;
  teardownScenarioEnv();
});

const noticeCount = (t: any) =>
  t.outbound.filter((c: any) => typeof c.text === "string" && c.text.includes("handled in ops panel")).length;

let sessionId: string;

d("session control panel over real Redis", () => {
  test("list ∩ warm registry, and fail-closed without a session cookie", async () => {
    await gw.transport.feedMessage(dm(CH, T1, "hello panel"));
    await until(() => replies(gw.transport, "panel-reply").length >= 1, 20_000);
    const row = await sessions.findByThread({ team_id: "T_SIM", channel_id: CH, thread_ts: T1 });
    expect(row).not.toBeNull();
    sessionId = row!.id;
    await until(async () => (await registry.lookup(sessionId)) !== null, 10_000);

    const res = await fetch(`${gw.url}/panel/api/sessions`, { headers: HDR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const s = body.sessions.find((x: any) => x.id === sessionId);
    expect(s).toBeTruthy();
    expect(s.warm).toBe(true);
    expect(s.node).toBe("panel-node-A");

    // Fail-closed: no session cookie → 401.
    const noauth = await fetch(`${gw.url}/panel/api/sessions`);
    expect(noauth.status).toBe(401);
  }, 30_000);

  test("CSRF: mutating requests need the anti-CSRF header and reject cross-site", async () => {
    // A valid session cookie is NOT enough for a state change without the
    // custom anti-CSRF header (the browser attaches the cookie to forged
    // cross-site requests too).
    const noCsrf = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, {
      method: "POST",
      headers: { cookie: opCookie() },
    });
    expect(noCsrf.status).toBe(403);

    // Cross-site Sec-Fetch-Site is refused even with the header present.
    const crossSite = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, {
      method: "POST",
      headers: { ...HDR, "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    // Same-origin request carrying the header clears the CSRF gate.
    const ok = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, {
      method: "POST",
      headers: { ...HDR, "sec-fetch-site": "same-origin" },
    });
    expect(ok.status).not.toBe(403);
    await fetch(`${gw.url}/panel/api/sessions/${sessionId}/release`, { method: "POST", headers: HDR });
  }, 30_000);

  test("SSE tails events:<id> for a fresh turn", async () => {
    const ac = new AbortController();
    const res = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/events`, {
      headers: HDR,
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drive a turn after the tail is connected (backlog is skipped on connect).
    await gw.transport.feedMessage({ ...dm(CH, "9100.2", "second"), thread_ts: T1 });

    let buf = "";
    let sawData = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !sawData) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("\ndata: ")) sawData = true;
    }
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(sawData).toBe(true);
  }, 30_000);

  test("lock held ⇒ inbound deferred + one notice; outbound suppressed while the event stream still flows", async () => {
    const repliesBefore = replies(gw.transport, "panel-reply").length;
    const noticesBefore = noticeCount(gw.transport);

    // Operator takes control.
    const lockRes = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, { method: "POST", headers: HDR });
    expect(lockRes.status).toBe(200);
    expect(await redis.get(keys.panelLock(sessionId))).toBe("op@example.com");

    // Two inbound Slack messages while locked → both deferred, exactly one notice.
    await gw.transport.feedMessage({ ...dm(CH, "9100.3", "slack while locked A"), thread_ts: T1 });
    await gw.transport.feedMessage({ ...dm(CH, "9100.4", "slack while locked B"), thread_ts: T1 });
    await until(() => noticeCount(gw.transport) === noticesBefore + 1, 8_000);
    await sleep(600); // give any (wrongly) dispatched turn a chance to post
    expect(noticeCount(gw.transport)).toBe(noticesBefore + 1); // one notice, not two
    expect(replies(gw.transport, "panel-reply").length).toBe(repliesBefore); // nothing dispatched

    // Operator drives the session: the turn runs (events stream grows) but the
    // reply is suppressed from Slack.
    const eventsBefore = (await pubsub.readEvents(sessionId)).length;
    const chatRes = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { ...HDR, "content-type": "application/json" },
      body: JSON.stringify({ text: "driven from the panel" }),
    });
    expect(chatRes.status).toBe(202);
    await until(async () => (await pubsub.readEvents(sessionId)).length > eventsBefore, 20_000);
    expect(replies(gw.transport, "panel-reply").length).toBe(repliesBefore); // Slack echo suppressed
  }, 40_000);

  test("explicit release resumes Slack and replays the deferred inbound", async () => {
    const repliesBefore = replies(gw.transport, "panel-reply").length;
    const relRes = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/release`, { method: "POST", headers: HDR });
    expect(relRes.status).toBe(200);
    expect(await redis.get(keys.panelLock(sessionId))).toBeNull();
    // The two deferred Slack messages now dispatch and answer.
    await until(() => replies(gw.transport, "panel-reply").length >= repliesBefore + 2, 25_000);
  }, 40_000);

  test("TTL auto-expiry resumes Slack (deferred replayed by the sweeper)", async () => {
    // Take control, defer one inbound, then walk away — the lock TTL (1500ms)
    // lapses and the sweeper replays the deferred message without an explicit
    // release.
    await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, { method: "POST", headers: HDR });
    const repliesBefore = replies(gw.transport, "panel-reply").length;
    await gw.transport.feedMessage({ ...dm(CH, "9100.5", "deferred until TTL"), thread_ts: T1 });
    await sleep(300);
    expect(replies(gw.transport, "panel-reply").length).toBe(repliesBefore); // still deferred
    await until(() => replies(gw.transport, "panel-reply").length >= repliesBefore + 1, 20_000);
    expect(await redis.get(keys.panelLock(sessionId))).toBeNull(); // TTL released the lock
  }, 30_000);

  test("force-release TRANSFERS the lock to the caller and audits old→new", async () => {
    // A different operator now holds the lock…
    const other = { cookie: opCookie("op2@example.com"), "x-panel-csrf": "1" };
    const lock2 = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/lock`, { method: "POST", headers: other });
    expect(lock2.status).toBe(200);
    expect(await redis.get(keys.panelLock(sessionId))).toBe("op2@example.com");

    // …op@example.com force-releases (STEALS) it. Capture the audit line.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: any[]) => logs.push(a.join(" "));
    let body: any;
    try {
      const res = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/force-release`, { method: "POST", headers: HDR });
      body = (await res.json()) as any;
      expect(res.status).toBe(200);
    } finally {
      console.log = orig;
    }
    expect(body.displaced).toBe("op2@example.com");
    expect(body.owner).toBe("op@example.com");
    // Lock stays HELD, now under the calling operator (Slack still suppressed).
    expect(await redis.get(keys.panelLock(sessionId))).toBe("op@example.com");
    // The displaced operator's heartbeat now fails — they lost control.
    const hb = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/heartbeat`, { method: "POST", headers: other });
    const hbBody = (await hb.json()) as any;
    expect(hbBody.ok).toBe(false);
    expect(
      logs.some((l) => l.includes('"action":"force-release"') && l.includes('"operator":"op@example.com"')),
    ).toBe(true);
    // Clean up: hand the session back to Slack.
    await fetch(`${gw.url}/panel/api/sessions/${sessionId}/release`, { method: "POST", headers: HDR });
  }, 20_000);

  test("control op: stop publishes an abort; reset clears claude_started", async () => {
    const stop = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/control`, {
      method: "POST",
      headers: { ...HDR, "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    expect(stop.status).toBe(200);

    await sessions.markStarted(sessionId);
    const reset = await fetch(`${gw.url}/panel/api/sessions/${sessionId}/control`, {
      method: "POST",
      headers: { ...HDR, "content-type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    expect(reset.status).toBe(200);
    expect((await sessions.findById(sessionId)).claude_started).toBe(0);
  }, 20_000);

  test("panel is not mounted on a replica without panel infra (role=node parity)", async () => {
    const bare = await bootReplica(keys); // no panel
    try {
      const res = await fetch(`${bare.url}/panel/api/sessions`, { headers: HDR });
      expect(res.status).toBe(404); // fetchPanel returns null → server 404
    } finally {
      await bare.stop().catch(() => {});
    }
  }, 20_000);
});

/**
 * Feedback on a proactive post over Slack's HTTP event path (phase E, spec
 * §10.5): the real `createGateway` on the real HTTP transport, the fake Slack
 * on the other side, and a fake brain backend (the brain must be on: feedback
 * writes memory).
 *
 *   - a signed `reaction_added` event on the post is verified by the transport,
 *     reaches the gateway's handler and is recorded as an outcome in the
 *     recipient's own slice; a duplicate delivery records nothing new;
 *   - a signed "stop" reply in the post's thread mutes that topic in the
 *     replier's own profile, quoting the reply, and the agent says so in one
 *     line in that thread; the stop never reaches the agent as a turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { paths } from "../../src/config/home";
import { __resetMasterKeyCache, encrypt } from "../../src/db/crypto";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import type { SlackAppRow } from "../../src/db/slack-apps";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { StubAgent } from "../../src/gateway/sim/stub-agent";
import { WORLD, writeSoulFixture } from "../../src/gateway/sim/soul-fixture";
import { createHttpSlackTransport, type HttpSlackTransport } from "../../src/gateway/slack/http-transport";
import { setBackendForTest, resetBackend } from "../../src/knowledge/backend";
import { parseFrontmatter } from "../../src/knowledge/memory-pages";
import { profileSourceId, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { prefsFromProfile } from "../../src/proactive/prefs";
import { __resetSoulDataMemo } from "../../src/soul/extract";
import { fakeBrain } from "../../tests/memory/fake-brain";
import { signedHeaders } from "./core/inbound";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

const TEST_MS = 30_000;
const WAIT_MS = 15_000;
const TEAM = "T0FAKE";
const ENV_KEYS = ["SLAUDE_MASTER_KEY", "SLAUDE_SLACK_API_URL", "SLACK_BOT_TOKEN", "SLAUDE_BRAIN_DISABLED", "SLAUDE_BRAIN_MODE"];
const saved: Record<string, string | undefined> = {};

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let transport: HttpSlackTransport;
let handle: GatewayHandle;
let agent: StubAgent;
let app: Awaited<ReturnType<typeof ctl.addApp>>;
let base: string;
let fb: ReturnType<typeof fakeBrain>;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.SLAUDE_BRAIN_DISABLED;
  process.env.SLAUDE_BRAIN_MODE = "remote";
  fb = fakeBrain();
  setBackendForTest({ ready: () => true, call: fb.call, adminCall: async () => null } as never);
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();

  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 1000 });
  process.env.SLAUDE_SLACK_API_URL = `${fake.url}/api`;
  ctl = createControlClient(fake.url);
  app = await ctl.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  process.env.SLACK_BOT_TOKEN = app.botToken;
  for (const [id, name] of [["U0MGR", "manager"], ["U0ALICE", "alice"]] as const) await ctl.addUser({ id, name });
  await ctl.addChannel({ id: "D0MGR", name: "dm-mgr", isIm: true, members: ["U0MGR", "U0BOT"] });
  writeSoulFixture(WORLD);

  const row: SlackAppRow = {
    api_app_id: app.apiAppId,
    team_id: TEAM,
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt(app.botToken),
    signing_secret: encrypt(app.signingSecret),
    bot_user_id: app.botUserId,
    created_at: 1,
    updated_at: 1,
  };
  transport = createHttpSlackTransport({ port: 0, loadApps: async () => [row], log: () => {} });
  agent = new StubAgent();
  handle = createGateway(agent, transport);
  agent.attachGateway(handle);
  await handle.start();
  base = `http://127.0.0.1:${transport.port}`;
  await db.run("DELETE FROM proactive_posts");
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  await fake?.stop();
  resetBackend();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMasterKeyCache();
  __resetSoulDataMemo();
  rmSync(paths.soul, { force: true });
});

/** The agent's proactive post to the manager, as the heartbeat makes it: through the Web API, then recorded. */
async function proactivePost(topic: string): Promise<{ id: string; ts: string }> {
  const r = (await (
    await fetch(`${fake.url}/api/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "D0MGR", text: `Investigation into the ${topic} has been untouched for six days.` }),
    })
  ).json()) as { ok: boolean; ts: string; channel: string };
  expect(r.ok).toBe(true);
  const id = await Posts.recordPost({
    agentId: "U0BOT", audience: "manager", recipient: "U0MGR", topic, textHash: "h", evidenceHash: "e",
    channelId: r.channel, messageTs: r.ts, teamId: TEAM, postedAt: Date.now(),
  });
  return { id, ts: r.ts };
}

/** Deliver a signed `reaction_added` event to the gateway, as Slack would. */
async function react(ts: string, reaction: string, eventId: string): Promise<number> {
  const raw = JSON.stringify({
    token: "fake-verification-token", team_id: TEAM, api_app_id: app.apiAppId, type: "event_callback", event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: "reaction_added", user: "U0MGR", reaction, item: { type: "message", channel: "D0MGR", ts }, item_user: "U0BOT", event_ts: `${Date.now() / 1000}` },
    authorizations: [{ team_id: TEAM, user_id: app.botUserId, is_bot: true }],
  });
  const res = await fetch(`${base}/slack/events`, { method: "POST", headers: signedHeaders(app.signingSecret, raw, "application/json"), body: raw });
  return res.status;
}

const scopeOf = (source: string): BrainScope => ({ clientId: "t", sourceId: source, allowedSources: [source] });
const page = async (slug: string, source: string) => (await fb.call("get_page", { slug }, scopeOf(source))) as { content: string } | null;

describe("proactive feedback over the HTTP event path", () => {
  test("a reaction is verified, reaches the gateway and is recorded once as an outcome in the recipient's slice", async () => {
    const p = await proactivePost("flaky deploy");
    expect(await react(p.ts, "eyes", "Ev0REACT1")).toBe(200);
    const out = await until(async () => page(`outcomes/proactive-${p.id}`, userSourceId("U0MGR")), { timeoutMs: WAIT_MS, what: "the reaction outcome" });
    expect(out!.content).toContain("reacted :eyes:");
    // A redelivery (Slack retries) is acked and recorded nothing new.
    await fb.call("put_page", { slug: `outcomes/proactive-${p.id}`, content: "marker" }, { clientId: "U0MGR", sourceId: userSourceId("U0MGR"), allowedSources: [userSourceId("U0MGR")] });
    expect(await react(p.ts, "eyes", "Ev0REACT1")).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect((await page(`outcomes/proactive-${p.id}`, userSourceId("U0MGR")))!.content).toBe("marker");
    // A badly signed event is refused by the transport.
    const raw = JSON.stringify({ type: "event_callback", team_id: TEAM, api_app_id: app.apiAppId, event: { type: "reaction_added" } });
    const bad = await fetch(`${base}/slack/events`, { method: "POST", headers: signedHeaders("wrong-secret", raw, "application/json"), body: raw });
    expect(bad.status).toBe(401);
  }, TEST_MS);

  test("a \"stop\" reply mutes that topic in the replier's own profile and is answered in one line, never as a turn", async () => {
    const p = await proactivePost("release notes");
    const turnsBefore = (await ctl.messages("D0MGR")).messages.filter((m) => m.user === "U0BOT" && m.text.includes("ack: done")).length;
    const sent = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "stop", threadTs: p.ts, target: base });
    expect(sent.deliveries[0]!.finalStatus).toBe(200);
    const confirm = await until(
      async () => (await ctl.thread("D0MGR", p.ts)).messages.find((m) => m.user === "U0BOT" && m.text.includes("stop pinging you about release notes")),
      { timeoutMs: WAIT_MS, what: "the agent's one-line confirmation" },
    );
    expect(confirm!.text).toBe("Got it, I'll stop pinging you about release notes.");
    const prof = await page("profile", profileSourceId(TEAM, "U0MGR"));
    const { meta } = parseFrontmatter(prof!.content);
    expect(prefsFromProfile(meta).mutes).toEqual(["release notes"]);
    expect(meta.quote).toBe("stop");
    expect(meta.source).toBe("told by U0MGR");
    // The stop never became an agent turn.
    await new Promise((r) => setTimeout(r, 500));
    expect((await ctl.messages("D0MGR")).messages.filter((m) => m.user === "U0BOT" && m.text.includes("ack: done")).length).toBe(turnsBefore);
  }, TEST_MS);
});

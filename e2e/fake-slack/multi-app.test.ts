/**
 * D1.2 / D1.4 against the wire: two registered apps, A (the oldest) and B, the real
 * `createGateway` on the real HTTP transport, the sim's stub agent and the fake Slack. The
 * fake records which app's token made every Web API call, so "went out as B" is a fact on
 * the wire, not an assumption about which client object was used.
 *
 * Before the fix everything except the event handler's own client went out as A: replies,
 * reactions, status, approval cards, the error post and cron runs, whichever app the event
 * arrived through.
 *
 * Environment: as gateway.test.ts (SQLite under the preload's temp home, brain off, no Redis).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { paths } from "../../src/config/home";
import { __resetMasterKeyCache, encrypt } from "../../src/db/crypto";
import * as CronJobs from "../../src/db/cron-jobs";
import { db } from "../../src/db/schema";
import type { SlackAppRow } from "../../src/db/slack-apps";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { StubAgent } from "../../src/gateway/sim/stub-agent";
import { WORLD, writeSoulFixture } from "../../src/gateway/sim/soul-fixture";
import { createHttpSlackTransport, type HttpSlackTransport } from "../../src/gateway/slack/http-transport";
import { __resetSoulDataMemo } from "../../src/soul/extract";
import type { CallRecord } from "./core/call-log";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

const TEST_MS = 30_000;
const WAIT_MS = 15_000;
const TEAM = "T0FAKE";
const A = "A0FIRST";
const B = "A0SECOND";

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let rows: SlackAppRow[];
const running: Array<{ handle: GatewayHandle; transport: HttpSlackTransport }> = [];
let base: string;
let agent: StubAgent;
const bootCalls: CallRecord[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SLAUDE_MASTER_KEY", "SLAUDE_SLACK_API_URL", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLAUDE_BRAIN_DISABLED"];

/** Boot a gateway (a "process") over the shared registry; returns its base URL. */
async function bootGateway(): Promise<{ base: string; agent: StubAgent }> {
  const transport = createHttpSlackTransport({ port: 0, loadApps: async () => rows, log: () => {} });
  const a = new StubAgent();
  const handle = createGateway(a, transport);
  a.attachGateway(handle);
  await handle.start();
  running.push({ handle, transport });
  return { base: `http://127.0.0.1:${transport.port}`, agent: a };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SLAUDE_BRAIN_DISABLED = "1";
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  // HTTP mode has no environment token, and presence (a user token) is not app-scoped.
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  __resetMasterKeyCache();

  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 1000 });
  process.env.SLAUDE_SLACK_API_URL = `${fake.url}/api`;
  ctl = createControlClient(fake.url);
  const appA = await ctl.addApp({ apiAppId: A, name: "first", botUserId: "U0BOTA" });
  const appB = await ctl.addApp({ apiAppId: B, name: "second", botUserId: "U0BOTB" });
  for (const [id, name] of [["U0MGR", "manager"], ["U0APP", "approver"]] as const) await ctl.addUser({ id, name });
  await ctl.addChannel({ id: "D0MGRA", name: "dm-a", isIm: true, members: ["U0MGR", "U0BOTA"] });
  await ctl.addChannel({ id: "D0MGRB", name: "dm-b", isIm: true, members: ["U0MGR", "U0BOTB"] });
  writeSoulFixture(WORLD); // manager U0MGR, approver U0APP

  const row = (app: typeof appA, createdAt: number): SlackAppRow => ({
    api_app_id: app.apiAppId,
    team_id: TEAM,
    tenant_id: "default",
    persona_id: "default",
    bot_token: encrypt(app.botToken),
    signing_secret: encrypt(app.signingSecret),
    bot_user_id: app.botUserId,
    created_at: createdAt,
    updated_at: createdAt,
  });
  rows = [row(appA, 1), row(appB, 2)]; // A is the oldest: the transport's primary

  ({ base, agent } = await bootGateway());
  // D1.4: one boot auth.test per registered app.
  await until(async () => new Set((await ctl.calls({ method: "auth.test" })).calls.map((c) => c.app)).size >= 2, {
    timeoutMs: WAIT_MS,
    what: "a boot auth.test per app",
  });
  await new Promise((r) => setTimeout(r, 300));
  bootCalls.push(...(await ctl.calls()).calls);
}, 60_000);

afterAll(async () => {
  for (const r of running) await r.handle.stop().catch(() => {});
  await fake?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMasterKeyCache();
  __resetSoulDataMemo();
  rmSync(paths.soul, { force: true });
});

const fresh = async (behavior: string) => {
  agent.setBehavior(behavior);
  await ctl.reset();
};
const settle = () => new Promise((r) => setTimeout(r, 500));
const apiCalls = async () => (await ctl.calls()).calls.filter((c) => c.kind === "api");
/** "method:app" for every Web API call, auth.test excluded (the event's own client checks its bot id). */
const callsByApp = async () => (await apiCalls()).filter((c) => c.method !== "auth.test").map((c) => `${c.method}:${c.app}`);

describe("two registered apps: every outbound call goes out as the event's app", () => {
  test("boot runs auth.test exactly once per registered app", () => {
    const auth = bootCalls.filter((c) => c.method === "auth.test").map((c) => c.app).sort();
    expect(auth).toEqual([A, B]);
  });

  test("an event for B: the reply, the reactions and the status all go out as B", async () => {
    await fresh("reply");
    await ctl.send({ app: B, channel: "D0MGRB", user: "U0MGR", text: "hello", target: base });
    await until(async () => (await ctl.calls({ method: "reactions.add" })).calls.some((c) => c.args?.name === "white_check_mark"), {
      timeoutMs: WAIT_MS,
      what: "the done reaction",
    });
    await settle();
    const calls = await callsByApp();
    expect(calls).toContain(`chat.postMessage:${B}`);
    expect(calls).toContain(`reactions.add:${B}`);
    expect(calls).toContain(`assistant.threads.setStatus:${B}`);
    expect(calls.filter((c) => !c.endsWith(`:${B}`))).toEqual([]);
  }, TEST_MS);

  test("the control: an event for A still goes out as A", async () => {
    await fresh("reply");
    await ctl.send({ app: A, channel: "D0MGRA", user: "U0MGR", text: "hello", target: base });
    await until(async () => (await ctl.messages("D0MGRA")).messages.some((m) => m.user === "U0BOTA" && m.text.includes("ack: done")), {
      timeoutMs: WAIT_MS,
      what: "A's reply",
    });
    await settle();
    const calls = await callsByApp();
    expect(calls).toContain(`chat.postMessage:${A}`);
    expect(calls.filter((c) => !c.endsWith(`:${A}`))).toEqual([]);
  }, TEST_MS);

  test("a failed turn for B posts its error message as B", async () => {
    await fresh("boom");
    await ctl.send({ app: B, channel: "D0MGRB", user: "U0MGR", text: "fail please", target: base });
    await until(async () => (await ctl.calls({ method: "reactions.add" })).calls.some((c) => c.args?.name === "x"), {
      timeoutMs: WAIT_MS,
      what: "the error reaction",
    });
    await settle();
    const posts = (await apiCalls()).filter((c) => c.method === "chat.postMessage");
    expect(posts.length).toBe(1);
    expect(posts[0]!.app).toBe(B);
    expect((await callsByApp()).filter((c) => !c.endsWith(`:${B}`))).toEqual([]);
  }, TEST_MS);

  test("an approval requested under B is posted as B, and B's click updates it", async () => {
    await fresh("request_approval");
    await ctl.send({ app: B, channel: "D0MGRB", user: "U0MGR", text: "deploy prod", target: base });
    const card = await until(
      async () =>
        (await ctl.messages("D0MGRB")).messages.find((m) => JSON.stringify(m.blocks ?? []).includes("slaude_appr:approve:")),
      { timeoutMs: WAIT_MS, what: "the approval card" },
    );
    expect(card.user).toBe("U0BOTB");
    const approveId = (card.blocks as any[]).find((b) => b.type === "actions").elements[0].action_id as string;
    await ctl.click({ app: B, target: base, user: "U0APP", channel: "D0MGRB", messageTs: card.ts, actionId: approveId });
    await until(async () => (await ctl.messages("D0MGRB")).messages.some((m) => m.text.includes("approved by <@U0APP>")), {
      timeoutMs: WAIT_MS,
      what: "the post-approval reply",
    });
    const decided = (await ctl.calls({ method: "response_url" })).calls[0]!;
    expect(decided.detail).toMatchObject({ app: B, applied: "replace_original" });
    await settle();
    expect((await callsByApp()).filter((c) => !c.endsWith(`:${B}`))).toEqual([]);
  }, TEST_MS);

  test("a cron job created under B posts as B after a restart", async () => {
    await fresh("reply");
    // Simulated restart: the first process goes away, a new one boots over the same
    // database and registry, and its scheduler fires the due job at boot.
    const first = running.shift()!;
    await first.handle.stop();
    await db.run("DELETE FROM cron_jobs");
    await CronJobs.create({
      slackTeamId: TEAM,
      slackAppId: B,
      slackChannelId: "D0MGRB",
      channelId: "D0MGRB",
      createdBy: "U0MGR",
      cronExpr: "0 9 * * *",
      prompt: "daily summary",
      nextRunAt: Date.now() - 1000,
      target: "channel",
    });
    ({ base, agent } = await bootGateway());
    agent.setBehavior("reply");
    const post = await until(async () => (await apiCalls()).find((c) => c.method === "chat.postMessage"), {
      timeoutMs: WAIT_MS,
      what: "the cron run's post",
    });
    expect(post.app).toBe(B);
    await settle();
    expect((await callsByApp()).filter((c) => !c.endsWith(`:${B}`))).toEqual([]);
    await db.run("DELETE FROM cron_jobs");
  }, TEST_MS);
});

/**
 * The fidelity test of the fake: the real `createGateway` on the real HTTP transport, the
 * sim's stub agent, and the fake Slack on the other side, all in one process. It proves
 * signing, dispatch, dedup, retries and the approval click against real gateway code, and
 * that every Web API method the gateway calls is one the fake implements.
 *
 * Environment: SQLite under the preload's temp $SLAUDE_HOME (no Postgres needed), brain off
 * (SLAUDE_BRAIN_DISABLED=1, as the integration harness does), no Redis (mono: no queue, the
 * cron scheduler runs in process and is stopped by handle.stop()).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { paths } from "../../src/config/home";
import { __resetMasterKeyCache, encrypt } from "../../src/db/crypto";
import type { SlackAppRow } from "../../src/db/slack-apps";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { StubAgent } from "../../src/gateway/sim/stub-agent";
import { WORLD, writeSoulFixture } from "../../src/gateway/sim/soul-fixture";
import { createHttpSlackTransport, type HttpSlackTransport } from "../../src/gateway/slack/http-transport";
import { __resetSoulDataMemo } from "../../src/soul/extract";
import type { CallRecord } from "./core/call-log";
import { KNOWN_METHODS } from "./core/web-api";
import { createControlClient } from "./control-client";
import { startFakeSlack, type FakeSlack } from "./server";
import { until } from "./util";

let fake: FakeSlack;
let ctl: ReturnType<typeof createControlClient>;
let transport: HttpSlackTransport;
let handle: GatewayHandle;
let agent: StubAgent;
let app: Awaited<ReturnType<typeof ctl.addApp>>;
let base: string;
const saved: Record<string, string | undefined> = {};
/** Every call the fake saw, boot included: beforeEach's reset would otherwise drop them. */
const allCalls: CallRecord[] = [];

const ENV_KEYS = ["SLAUDE_MASTER_KEY", "SLAUDE_SLACK_API_URL", "SLACK_BOT_TOKEN", "SLAUDE_BRAIN_DISABLED"];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SLAUDE_BRAIN_DISABLED = "1";
  process.env.SLAUDE_MASTER_KEY = randomBytes(32).toString("base64");
  __resetMasterKeyCache();

  fake = await startFakeSlack({ port: 0, retryDelaysMs: [0, 0, 0], ackTimeoutMs: 1000 });
  process.env.SLAUDE_SLACK_API_URL = `${fake.url}/api`;
  ctl = createControlClient(fake.url);
  app = await ctl.addApp({ apiAppId: "A0FAKE", name: "agent", botUserId: "U0BOT" });
  process.env.SLACK_BOT_TOKEN = app.botToken;
  for (const [id, name] of [["U0MGR", "manager"], ["U0APP", "approver"], ["U0ALICE", "alice"]] as const) await ctl.addUser({ id, name });
  await ctl.addChannel({ id: "D0MGR", name: "dm-mgr", isIm: true, members: ["U0MGR", "U0BOT"] });
  await ctl.addChannel({ id: "C0TEAM", name: "team", members: ["U0MGR", "U0APP", "U0ALICE", "U0BOT"] });

  writeSoulFixture(WORLD); // manager U0MGR, approver U0APP, trusted C0TEAM

  const row: SlackAppRow = {
    api_app_id: app.apiAppId,
    team_id: "T0FAKE",
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
}, 60_000);

afterAll(async () => {
  await handle?.stop();
  await fake?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetMasterKeyCache();
  __resetSoulDataMemo();
  rmSync(paths.soul, { force: true });
});

beforeEach(async () => {
  agent.setBehavior("reply");
  allCalls.push(...(await ctl.calls()).calls);
  await ctl.reset();
});

const botMessages = async (channel: string) => (await ctl.messages(channel)).messages.filter((m) => m.user === "U0BOT");
const acks = async (channel: string) => (await botMessages(channel)).filter((m) => m.text.includes("ack: done"));
/** Room for a wrongly processed second copy to show up before an exactly-once assertion. */
const settle = () => new Promise((r) => setTimeout(r, 500));

describe("real gateway + HTTP transport + fake Slack", () => {
  test("a DM from the manager gets one reply, threaded on the inbound message", async () => {
    const sent = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "hello", target: base });
    expect(sent.deliveries[0]!.finalStatus).toBe(200);
    const reply = await until(async () => (await acks("D0MGR"))[0], { what: "the bot's reply" });
    // even in a DM the reply goes into a thread on the inbound message, not top level
    expect(reply.threadTs).toBe(sent.message.ts);
    // the turn's lifecycle reactions end on the inbound message as a check mark
    await until(async () => (await ctl.calls({ method: "reactions.add" })).calls.some((c) => c.args?.name === "white_check_mark"), { what: "the done reaction" });
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  test("a channel @mention from an allowed user gets a reply in the thread", async () => {
    const sent = await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0ALICE", text: "status?", target: base, mention: true });
    const reply = await until(async () => (await acks("C0TEAM"))[0], { what: "the channel reply" });
    expect(reply.threadTs).toBe(sent.message.ts);
  });

  test("a channel message without an @mention in an unengaged thread is not answered", async () => {
    await ctl.send({ app: "A0FAKE", channel: "C0TEAM", user: "U0ALICE", text: "just chatting", target: base });
    await settle();
    expect(await botMessages("C0TEAM")).toEqual([]);
    expect((await ctl.calls()).calls.filter((c) => c.kind === "api" && c.method === "chat.postMessage")).toEqual([]);
  });

  test("a duplicate delivery of the same event produces one reply", async () => {
    const sent = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "dedup me", target: base, duplicate: true, eventId: "Ev0DEDUP" });
    expect(sent.deliveries.map((d) => d.finalStatus)).toEqual([200, 200]);
    await until(async () => (await acks("D0MGR")).length >= 1, { what: "first reply" });
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  test("a Slack retry (X-Slack-Retry-Num) of an event already taken produces no second reply", async () => {
    const first = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "retry me", target: base, eventId: "Ev0RETRY" });
    await until(async () => (await acks("D0MGR")).length >= 1, { what: "first reply" });
    const retry = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", target: base, redeliverTs: first.message.ts, eventId: "Ev0RETRY", retryNum: 1 });
    expect(retry.deliveries[0]!.attempts).toEqual([{ retryNum: 1, status: 200 }]);
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  test("an event whose first delivery the gateway sees is a retry is still answered", async () => {
    // Slack's first attempt was lost (e.g. the gateway was down): only the retry arrives.
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "only the retry", target: base, retryNum: 2 });
    await until(async () => (await acks("D0MGR")).length >= 1, { what: "the reply to a retry-only delivery" });
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  test("the same message ts under a NEW event id is still one reply (dedup is by channel and ts)", async () => {
    const first = await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "same ts", target: base, eventId: "Ev0ONE" });
    await until(async () => (await acks("D0MGR")).length >= 1, { what: "first reply" });
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", target: base, eventId: "Ev0TWO", redeliverTs: first.message.ts });
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  test("an approval card is posted with buttons, only an approver's click resolves it, exactly once, and the agent continues", async () => {
    agent.setBehavior("request_approval");
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "deploy prod", target: base });
    const card = await until(
      async () => (await botMessages("D0MGR")).find((m) => JSON.stringify(m.blocks ?? []).includes("slaude_appr:approve:")),
      { what: "the approval card" },
    );
    const blocks = card.blocks as Array<{ type: string; elements?: Array<{ type: string; action_id?: string }> }>;
    const buttons = blocks.find((b) => b.type === "actions")!.elements!;
    expect(buttons.map((b) => b.type)).toEqual(["button", "button"]);
    const [approveId, denyId] = buttons.map((b) => b.action_id!);
    expect(approveId).toMatch(/^slaude_appr:approve:/);
    expect(denyId).toBe(approveId!.replace(":approve:", ":deny:"));
    expect(JSON.stringify(blocks)).toContain("Approver(s): <@U0APP>");

    const respond = async () => (await ctl.calls({ method: "response_url" })).calls;

    // a user who is not an approver is told so privately; the card and the gate stay open
    await ctl.click({ app: "A0FAKE", target: base, user: "U0ALICE", channel: "D0MGR", messageTs: card.ts, actionId: approveId! });
    const refused = await until(async () => (await respond())[0], { what: "the not-an-approver answer" });
    expect(refused.detail).toMatchObject({ applied: "ephemeral", user: "U0ALICE" });
    expect((refused.detail!.body as { text: string }).text).toContain("not on the approver allowlist");
    expect((await botMessages("D0MGR")).find((m) => m.ts === card.ts)!.blocks).toEqual(card.blocks);

    // the approver's click resolves it: the card is replaced by the decision, the agent continues
    const click = await ctl.click({ app: "A0FAKE", target: base, user: "U0APP", channel: "D0MGR", messageTs: card.ts, actionId: approveId! });
    expect(click.delivery.finalStatus).toBe(200);
    await until(async () => (await botMessages("D0MGR")).find((m) => m.text.includes("approved by <@U0APP>")), { what: "the post-approval reply" });
    const decided = (await respond())[1]!;
    expect(decided.detail).toMatchObject({ applied: "replace_original", body: { replace_original: true, text: "Plan → *Approved* by <@U0APP>", blocks: [] } });

    // a second click on the same card is answered as stale through response_url, not applied again
    await ctl.click({ app: "A0FAKE", target: base, user: "U0APP", channel: "D0MGR", messageTs: card.ts, actionId: approveId! });
    const stale = await until(async () => (await respond())[2], { what: "the stale-click response" });
    expect(stale.detail).toMatchObject({ applied: "replace_original", body: { text: ":lock: approval already decided" } });
    await settle();
    expect((await botMessages("D0MGR")).filter((m) => m.text.includes("approved by"))).toHaveLength(1);
    expect(await respond()).toHaveLength(3);
  });

  test("a Slack 429 on chat.postMessage does not lose the reply, and does not duplicate it", async () => {
    await ctl.addFault({ method: "chat.postMessage", status: 429, retryAfterSec: 1, times: 1 });
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "rate limited", target: base });
    await until(async () => (await acks("D0MGR")).length >= 1, { timeoutMs: 20_000, what: "the reply after a 429" });
    const posts = (await ctl.calls({ method: "chat.postMessage" })).calls;
    expect(posts.map((c) => c.status)).toEqual([429, 200]);
    await settle();
    expect(await acks("D0MGR")).toHaveLength(1);
  });

  // Keep last: it checks every call made since boot, collected across the tests above.
  test("the gateway only ever calls Web API methods the fake implements", async () => {
    await ctl.send({ app: "A0FAKE", channel: "D0MGR", user: "U0MGR", text: "one more", target: base });
    await until(async () => (await acks("D0MGR")).length >= 1, { what: "reply" });
    const calls = [...allCalls, ...(await ctl.calls()).calls].filter((c) => c.kind === "api");
    expect(calls.filter((c) => c.unknown).map((c) => c.method)).toEqual([]);
    const used = [...new Set(calls.map((c) => c.method))].sort();
    expect(used.every((m) => KNOWN_METHODS.includes(m))).toBe(true);
    // the boot itself was seen (the call log was not empty before the first test)
    expect(allCalls.some((c) => c.method === "auth.test")).toBe(true);
  });
});

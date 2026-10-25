/**
 * Mono profile writes (phase C, invariant 2): the route's ctx is rewritten by
 * every delivered message, so the gateway records who sent the messages the
 * running turn holds, and kb_memoize target:"profile" needs that record to be
 * exactly the speaker, from Slack. The stubbed agent never ends a turn on its
 * own; the test emits `done` where a turn ends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import { db } from "../../../src/db/schema";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as OneOnOne from "../../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../../src/knowledge/agent-identity";
import { classifyBrainOp, resetStandingGrants } from "../../../src/knowledge/gated-dispatch";
import { profileSourceId, resolveBrainScope, type BrainScope } from "../../../src/knowledge/scope";

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const PROFILE_REFUSAL = "refused: a profile is written only on that person's own turn";

/** Every put_page the brain received, with its write source. */
let puts: Array<{ slug: string; source: string }> = [];
const backend = {
  call: async (name: string, p: Record<string, unknown>, scope: BrainScope) => {
    if (name === "put_page") puts.push({ slug: String(p.slug), source: scope.sourceId });
    return { ok: true };
  },
  adminCall: async () => null,
};

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const client: any = {
    auth: { test: async () => ({ user_id: "U_SLAUDE", bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: { postMessage: async () => ({ ok: true, ts: "1.1" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: any = {
    client,
    action: () => {}, use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  /** A mention in C0TEAM's thread `thread`. */
  /** As Slack delivers a mention: app_mention, then the message copy. */
  const mention = async (user: string, thread: string, ts: string, text = "call me Al") => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@U_SLAUDE> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  return { t, mention };
}

async function callTool(cfg: any, name: string, args: Record<string, unknown>) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "t", version: "0.0.0" });
  await client.connect(clientT);
  try {
    return (await client.callTool({ name, arguments: args })) as any;
  } finally {
    await client.close();
  }
}

const profileWrite = { pages: [{ slug: "profile", content: "Call me Al.", summary: "name to use", type: "profile" }], target: "profile" };

let h: GatewayHandle | null = null;
let agent: AgentManager;
let sent: string[];
const waitSent = async (n: number) => {
  const end = Date.now() + 3000;
  while (sent.length < n && Date.now() < end) await Bun.sleep(10);
  expect(sent.length).toBeGreaterThanOrEqual(n);
};
const memoize = async (sid: string) => {
  const servers = (await h!.__resolveMcp(sid))!;
  return (await callTool(servers.slaude_kb, "kb_memoize", profileWrite)).content[0].text as string;
};

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  setBackendForTest(backend);
  setAgentId("U_SLAUDE");
});
afterAll(() => {
  resetBackend();
  resetAgentId();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  puts = [];
  sent = [];
  resetStandingGrants();
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  agent = new AgentManager();
  agent.sendMessage = async (id: string) => void sent.push(id);
});
afterEach(async () => {
  await h?.stop();
  h = null;
  await db.run("DELETE FROM cron_jobs");
});

describe("mono: a profile write needs a turn of the speaker's own Slack messages", () => {
  test("a single sender writes their own profile", async () => {
    const { t, mention } = transport();
    h = createGateway(agent, t);
    await mention("U0ALICE", "700.0", "700.1");
    await waitSent(1);
    const g = (await h.__brainGate!(sent[0]!))!;
    expect(g.turnSenders).toEqual([{ userId: "U0ALICE", teamId: "T", origin: "slack" }]);
    const text = await memoize(sent[0]!);
    expect(text).not.toContain("refused");
    expect(puts).toEqual([{ slug: "profile", source: profileSourceId("T", "U0ALICE") }]);
  });

  test("Bob posting during Alice's turn: refused, Bob's profile untouched; after the turn ends, Bob's own turn may", async () => {
    const { t, mention } = transport();
    h = createGateway(agent, t);
    await mention("U0ALICE", "710.0", "710.1");
    await waitSent(1);
    const sid = sent[0]!;
    await mention("U0BOB", "710.0", "710.2", "nice");
    await waitSent(2);
    const g = (await h.__brainGate!(sid))!;
    expect(g.userId).toBe("U0BOB"); // the live ctx flipped to the last speaker
    expect(classifyBrainOp("put_page", { ...resolveBrainScope({ ...g, kbSources: [] }), sourceId: profileSourceId("T", "U0BOB") }, g)).toBe("deny");
    expect(await memoize(sid)).toBe(PROFILE_REFUSAL);
    expect(puts).toEqual([]);

    agent.emit("event", { type: "done", sessionId: sid });
    await mention("U0BOB", "710.0", "710.3", "call me B");
    await waitSent(3);
    expect(await memoize(sid)).not.toContain("refused");
    expect(puts).toEqual([{ slug: "profile", source: profileSourceId("T", "U0BOB") }]);
  });

  test("a Slack message arriving during a cron turn: refused", async () => {
    await CronJobs.create({
      slackTeamId: "T", slackChannelId: "C0TEAM", slackThreadTs: "720.0", channelId: "C0TEAM",
      createdBy: "U0ALICE", cronExpr: "* * * * *", prompt: "tick", nextRunAt: Date.now() - 1000, target: "thread",
    });
    const { t, mention } = transport();
    h = createGateway(agent, t);
    await waitSent(1); // the due cron job ran
    const sid = sent[0]!;
    expect((await h.__brainGate!(sid))!.turnSenders).toEqual([{ userId: "U0ALICE", teamId: "T", origin: "cron" }]);
    await mention("U0ALICE", "720.0", "720.1");
    await waitSent(2);
    expect(sent[1]).toBe(sid);
    const g = (await h.__brainGate!(sid))!;
    expect(g).toMatchObject({ userId: "U0ALICE", origin: "slack", interactive: true });
    expect(await memoize(sid)).toBe(PROFILE_REFUSAL);
    expect(puts).toEqual([]);
  });
});

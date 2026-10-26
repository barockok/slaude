/**
 * A promise kept with proactiveness off, end to end (phase E, spec §10.6;
 * invariants 1 and 5), on the mono gateway. Real: the gateway's turn path,
 * kb_memoize with its commitment index hook, the promise checks and the
 * gateway's promise transport (route bound like a cron run, the lock check,
 * sendMessage carrying the run), the ledger and the surface reply tool. Fake:
 * the brain backend, the model (the test plays its tool calls) and Slack.
 *
 *   1. The SOUL has no `## Proactive`. In Alice's /1on1 the agent promises to
 *      tell her when the deploy is out, and writes an open commitment.
 *   2. +15 min: a check turn goes into her thread, budgeted; it passes.
 *   3. +30 min: the next check finds it done: it replies in her thread and
 *      writes the commitment as done, which closes the index row.
 *   4. The done page is in Alice's slice only; the ledger holds the two
 *      commitment runs with their cost; no heartbeat ran and no proactive post
 *      exists.
 *   5. Once the lock is released, a later promise from that /1on1 is not
 *      checked in the now-open thread.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager, type BackgroundTurnRun, type InputSender } from "../../src/agent/manager";
import { db } from "../../src/db/schema";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Commitments from "../../src/db/commitments";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import { resetStandingGrants } from "../../src/knowledge/gated-dispatch";
import { agentSourceId, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { promiseChecks, type AgentGroup } from "../../src/background/scheduler";
import { anyProactiveEnabled, __setProactiveSoulSource } from "../../src/soul/proactive";
import { loadSoul } from "../../src/soul/loader";
import { fakeBrain } from "../memory/fake-brain";

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED", "SLAUDE_PRICE_TABLE", "SLAUDE_MODEL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const AGENT_ID = "U_SLAUDE";
const LOCKED = "2600.0";
const MODEL = "test-model";
const MIN = 60_000;

let fb: ReturnType<typeof fakeBrain>;
let writes: Array<{ slug: string; source: string }>;

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const posts: Array<{ channel: string; thread_ts?: string; text: string }> = [];
  const client: any = {
    auth: { test: async () => ({ user_id: AGENT_ID, bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: {
      postMessage: async (m: { channel: string; thread_ts?: string; text: string }) => {
        posts.push({ channel: m.channel, thread_ts: m.thread_ts, text: m.text });
        return { ok: true, ts: `${1700 + posts.length}.1`, channel: m.channel };
      },
      update: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: { info: async () => ({}), members: async () => ({ members: [] }), replies: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: any = {
    client,
    action: () => {},
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const mention = async (user: string, thread: string, ts: string, text: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@${AGENT_ID}> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  return { t, mention, posts };
}

async function callTool(cfg: any, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverT);
  const client = new Client({ name: "t", version: "0.0.0" });
  await client.connect(clientT);
  try {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { text: r.content[0].text as string, isError: r.isError };
  } finally {
    await client.close();
  }
}

let h: GatewayHandle | null = null;
let agent: AgentManager;
let sent: Array<{ sid: string; text: string; sender?: InputSender; run?: BackgroundTurnRun }>;
let spies: Array<ReturnType<typeof spyOn>> = [];

const group: AgentGroup = { agentId: AGENT_ID, personaId: "default", personaIds: ["default"], timeZone: "UTC" };

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  process.env.SLAUDE_PRICE_TABLE = JSON.stringify({ [MODEL]: { input: 1, output: 10, cache_read: 0.1, cache_write: 1.25 } });
  process.env.SLAUDE_MODEL = MODEL;
  setAgentId(AGENT_ID);
});
afterAll(() => {
  resetBackend();
  resetAgentId();
  __setProactiveSoulSource(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  fb = fakeBrain();
  writes = [];
  const call = async (n: string, p: Record<string, unknown>, s: BrainScope): Promise<unknown> => {
    if (n === "put_page") writes.push({ slug: String(p.slug), source: s.sourceId });
    if (n === "search") return [];
    return fb.call(n, p, s);
  };
  setBackendForTest({ ready: () => true, call, adminCall: async () => null } as any);
  sent = [];
  resetStandingGrants();
  writeSoulFixture(WORLD);
  __setProactiveSoulSource(() => loadSoul());
  await OneOnOne._wipeForTests();
  for (const table of ["sessions", "commitments", "proactive_posts", "background_runs", "background_slots"]) await db.run(`DELETE FROM ${table}`);
  agent = new AgentManager();
  agent.sendMessage = async (sid: string, text: string, opts?: { sender?: InputSender; backgroundRun?: BackgroundTurnRun }) => {
    sent.push({ sid, text, ...(opts?.sender ? { sender: opts.sender } : {}), ...(opts?.backgroundRun ? { run: opts.backgroundRun } : {}) });
  };
  agent.turnSenders = () => {
    const last = sent.at(-1)?.sender;
    return last ? [last] : null;
  };
  spies = (["log", "warn", "debug"] as const).map((k) => spyOn(console, k).mockImplementation(() => {}));
});
afterEach(async () => {
  await h?.stop();
  h = null;
  // Slack event de-duplication is process-wide: leave no seen ts behind for later files.
  await db.run("DELETE FROM seen_events");
  for (const s of spies) s.mockRestore();
  spies = [];
});

const usage = (input: number, output: number) => ({ [MODEL]: { input, output, cache_read: 0, cache_write: 0 } });

describe("a promise kept with proactiveness off", () => {
  test("checked in Alice's own /1on1, budgeted, closed when done, and never anywhere else", async () => {
    expect(loadSoul()).not.toMatch(/##\s+proactive/i);
    expect(anyProactiveEnabled("default")).toBe(false);
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: LOCKED, lockedUser: "U0ALICE", createdBy: "U0ALICE" });
    const { t, mention, posts } = transport();
    h = createGateway(agent, t);

    // 1. Alice asks; the agent promises and writes an open commitment.
    await mention("U0ALICE", LOCKED, "2600.1", "tell me when the deploy is out?");
    const end = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < end) await Bun.sleep(10);
    const sid = sent[0]!.sid;
    const kb = (await h.__resolveMcp(sid))!.slaude_kb;
    const surface = (await h.__resolveMcp(sid))!.slaude_surface;
    const wrote = await callTool(kb, "kb_memoize", {
      pages: [{
        slug: "commitments/deploy", summary: "deploy promise", type: "commitment", content: "Tell Alice when the deploy is out.",
        fields: { promiser: AGENT_ID, beneficiary: "U0ALICE", thread: `C0TEAM:${LOCKED}`, due: "after the deploy", check: "deploy status", on_no_change: "silent", status: "open" },
      }],
    });
    expect(wrote.isError).toBeFalsy();
    const key = { agentId: AGENT_ID, source: userSourceId("U0ALICE"), slug: "commitments/deploy" };
    const row = await Commitments.get(key);
    expect(row).toMatchObject({ runAs: "U0ALICE", teamId: "T", channelId: "C0TEAM", threadTs: LOCKED, status: "open" });

    const checks = promiseChecks(h.__promises!);
    const at = (ms: number) => new Date(row!.createdAt + ms);

    // 2. +15 min: a check turn into her thread, carrying its run. The model passes.
    sent = [];
    expect(await checks(group, at(15 * MIN))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sid).toBe(sid);
    expect(sent[0]!.text).toStartWith('<runtime-check kind="commitment" last="no">');
    expect(sent[0]!.text).toContain("<@U0ALICE>");
    expect(sent[0]!.sender).toBeUndefined();
    await sent[0]!.run!.finish(usage(2_000, 100), "ok");

    // 3. +30 min: done. The model replies in her thread and writes the commitment as done.
    sent = [];
    expect(await checks(group, at(30 * MIN))).toBe(1);
    const reply = await callTool(surface, "reply", { text: "<@U0ALICE> the deploy is out." });
    expect(reply.isError).toBeFalsy();
    const done = await callTool(kb, "kb_memoize", {
      pages: [{
        slug: "commitments/deploy-done", summary: "kept", type: "commitment", content: "Told Alice the deploy is out.", supersedes: "commitments/deploy",
        fields: { promiser: AGENT_ID, beneficiary: "U0ALICE", thread: `C0TEAM:${LOCKED}`, due: "after the deploy", status: "done" },
      }],
    });
    expect(done.isError).toBeFalsy();
    await sent[0]!.run!.finish(usage(3_000, 200), "ok");

    // 4. Closed; the reply is in her thread; her writes only in her slice; two priced runs; no heartbeat, no proactive post.
    expect((await Commitments.get(key))!.status).toBe("done");
    expect(posts.filter((p) => p.text.includes("deploy is out"))).toEqual([{ channel: "C0TEAM", thread_ts: LOCKED, text: expect.stringContaining("deploy is out") }]);
    const commitmentWrites = writes.filter((w) => w.slug.startsWith("commitments/"));
    expect(new Set(commitmentWrites.map((w) => w.source))).toEqual(new Set([userSourceId("U0ALICE")]));
    expect(writes.some((w) => w.source === agentSourceId(AGENT_ID) && w.slug.startsWith("commitments/"))).toBe(false);
    const runs = await db.query<{ pass: string; outcome: string; cost_usd: number; scope: string }>("SELECT pass, outcome, cost_usd, scope FROM background_runs ORDER BY started_at");
    expect(runs.map((r) => [r.pass, r.outcome, r.scope])).toEqual([
      ["commitment", "ok", "user:U0ALICE"],
      ["commitment", "ok", "user:U0ALICE"],
    ]);
    expect(runs[0]!.cost_usd).toBeCloseTo((2_000 * 1 + 100 * 10) / 1e6, 9);
    expect(runs[1]!.cost_usd).toBeCloseTo((3_000 * 1 + 200 * 10) / 1e6, 9);
    expect((await db.query("SELECT * FROM proactive_posts")).length).toBe(0);
    // Nothing more is checked.
    sent = [];
    expect(await checks(group, at(45 * MIN))).toBe(0);

    // 5. A promise from the /1on1, after the lock is released: not checked in the now-open thread.
    await callTool(kb, "kb_memoize", {
      pages: [{
        slug: "commitments/review", summary: "review promise", type: "commitment", content: "Tell Alice when the review lands.",
        fields: { promiser: AGENT_ID, beneficiary: "U0ALICE", thread: `C0TEAM:${LOCKED}`, due: "after the review", status: "open" },
      }],
    });
    const review = await Commitments.get({ ...key, slug: "commitments/review" });
    expect(review).toMatchObject({ runAs: "U0ALICE" });
    await OneOnOne.unlock("C0TEAM", LOCKED);
    expect(await checks(group, new Date(review!.createdAt + 15 * MIN))).toBe(0);
    expect(sent).toEqual([]);
    const after = await Commitments.get({ ...key, slug: "commitments/review" });
    expect(after).toMatchObject({ status: "open", checks: 0 });
  });
});

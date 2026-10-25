/**
 * /1on1 containment end to end (phase C, spec §8.7, invariants 1 and 2), on
 * the mono gateway with the real slaude_kb tool server and the real
 * <memory-context> envelope; only the brain is a fake backend and the agent's
 * sendMessage/turnSenders are stubbed (each input runs alone, so the running
 * turn's senders are the last message's sender).
 *
 *   1. Alice's /1on1: an inferred note about Bob (`people/u0bob`, target
 *      "mine") and a told profile entry.
 *   2. Bob in a trusted channel: his <memory-context>, memory_about(bob) and
 *      kb_search carry none of Alice's /1on1 note.
 *   3. Alice in a channel: her profile is in her block, the /1on1 note is not.
 *   4. Bob inside Alice's locked thread: only Bob's profile is read.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager, type InputSender } from "../../src/agent/manager";
import { db } from "../../src/db/schema";
import * as OneOnOne from "../../src/db/one-on-one";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import { resetStandingGrants } from "../../src/knowledge/gated-dispatch";
import { composePage } from "../../src/knowledge/memory-pages";
import { agentSourceId, profileSourceId, SHARED_SOURCE, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { fakeBrain } from "./fake-brain";

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const AGENT = agentSourceId("U_SLAUDE");
const ALICE_PROFILE = profileSourceId("T", "U0ALICE");
const BOB_PROFILE = profileSourceId("T", "U0BOB");
const LOCKED = "500.0";
const LOCK_REFUSAL = "refused: in a /1on1, memory stays with this person; ask them before sharing it";

/** What Alice said about Bob in her /1on1, and what she asked to be called. */
const NOTE = "Bob seems stretched thin before the launch";
const ALICE_TOLD = "Call me Al. Short answers.";

let fb: ReturnType<typeof fakeBrain>;
/** Every write the brain received: op, slug, write source. */
let writes: Array<{ name: string; slug: string; source: string }>;
/** The read union of every get_page / search the brain received. */
let reads: string[][];

/** gbrain's `search` over the fake brain's contents: every query word must
 *  appear in the page; one hit per readable page. */
function search(query: string, scope: BrainScope) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...fb.contents.entries()]
    .map(([k, content]) => [...(k.split("\u0000") as [string, string]), content] as const)
    .filter(([src, , content]) => scope.allowedSources.includes(src) && words.every((w) => content.toLowerCase().includes(w)))
    .map(([src, slug, content]) => ({ slug, source_id: src, score: 1, chunk_text: content }));
}

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
  /** As Slack delivers a mention in C0TEAM: app_mention, then the message copy. */
  const mention = async (user: string, thread: string, ts: string, text: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@U_SLAUDE> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  return { t, mention };
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
/** Each sendMessage: the session, the envelope and its sender. */
let sent: Array<{ sid: string; text: string; sender?: InputSender }>;

/** A mention, then the turn it starts: its session and <memory-context> block ("" when absent). */
async function turn(mention: ReturnType<typeof transport>["mention"], user: string, thread: string, ts: string, text: string) {
  const before = sent.length;
  await mention(user, thread, ts, text);
  const end = Date.now() + 3000;
  while (sent.length === before && Date.now() < end) await Bun.sleep(10);
  expect(sent.length).toBe(before + 1);
  const { sid, text: env, sender } = sent[before]!;
  expect(sender?.userId).toBe(user);
  const open = env.indexOf("<memory-context>");
  const block = open < 0 ? "" : env.slice(open, env.indexOf("</memory-context>"));
  const tool = async (name: string, args: Record<string, unknown>) => callTool((await h!.__resolveMcp(sid))!.slaude_kb, name, args);
  return { sid, block, tool };
}

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
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
  fb = fakeBrain();
  writes = [];
  reads = [];
  setBackendForTest({
    call: async (n: string, p: Record<string, unknown>, s: BrainScope) => {
      if (n === "put_page" || n === "add_tag" || n === "remove_tag") writes.push({ name: n, slug: String(p.slug), source: s.sourceId });
      if (n === "get_page" || n === "search") reads.push(s.allowedSources);
      if (n === "search") return search(String(p.query), s);
      return fb.call(n, p, s);
    },
    adminCall: async () => null,
  } as any);
  sent = [];
  resetStandingGrants();
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
  await db.run("DELETE FROM cron_jobs");
  agent = new AgentManager();
  agent.sendMessage = async (sid: string, text: string, opts?: { sender?: InputSender }) => {
    sent.push({ sid, text, ...(opts?.sender ? { sender: opts.sender } : {}) });
  };
  // Each input runs alone: the running turn holds the last message's sender.
  agent.turnSenders = () => {
    const last = sent.at(-1)?.sender;
    return last ? [last] : null;
  };
});
afterEach(async () => {
  await h?.stop();
  h = null;
});

/** Bob's own profile and an ordinary agent-slice note about him, so his block
 *  and memory_about have something to show besides what must stay out. */
async function seedBob() {
  const put = async (source: string, slug: string, content: string, typed: { type: string; subject?: string }) => {
    const r = composePage({ slug, content, ...typed }, new Date("2026-10-20T12:00:00Z"));
    if ("error" in r) throw new Error(r.error);
    await fb.call("put_page", { slug, content: r.content }, { clientId: "seed", sourceId: source, allowedSources: [source] });
  };
  await put(BOB_PROFILE, "profile", "Bob likes bullet points.", { type: "profile", subject: "U0BOB" });
  await put(AGENT, "people/u0bob-review", "Bob reviews quickly when tagged.", { type: "person-note", subject: "U0BOB" });
}

describe("/1on1 containment, end to end", () => {
  test("Alice's /1on1 note about Bob never reaches Bob, a channel turn, or Bob inside her thread; her profile follows her", async () => {
    await seedBob();
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: LOCKED, lockedUser: "U0ALICE", createdBy: "U0ALICE" });
    const { t, mention } = transport();
    h = createGateway(agent, t);

    // 1. Alice's /1on1: the inferred note stays in her slice, her told profile in her profile.
    const a1 = await turn(mention, "U0ALICE", LOCKED, "500.1", "Bob looks overloaded. Also, call me Al.");
    const note = await a1.tool("kb_memoize", {
      pages: [{ slug: "people/u0bob", content: NOTE, summary: "how Bob is doing", type: "person-note" }],
      target: "mine", subject: "U0BOB",
    });
    expect(note.isError).toBeFalsy();
    const profile = await a1.tool("kb_memoize", {
      pages: [{ slug: "profile", content: ALICE_TOLD, summary: "name to use", type: "profile" }],
      target: "profile",
    });
    expect(profile.isError).toBeFalsy();
    // Neither shared nor the agent's own slice is reachable from inside the lock.
    expect((await a1.tool("kb_memoize", { pages: [{ slug: "people/u0bob", content: NOTE, summary: "s", type: "person-note" }], target: "shared", subject: "U0BOB" })).text).toBe(LOCK_REFUSAL);
    expect(writes.filter((w) => w.name === "put_page")).toEqual([
      { name: "put_page", slug: "people/u0bob", source: userSourceId("U0ALICE") },
      { name: "put_page", slug: "profile", source: ALICE_PROFILE },
    ]);
    expect(fb.contentOf(userSourceId("U0ALICE"), "people/u0bob")).toContain("confidence: inferred");
    for (const src of [AGENT, SHARED_SOURCE, BOB_PROFILE]) expect(fb.contentOf(src, "people/u0bob")).toBeUndefined();
    // Positive control: inside her own /1on1 the note is searchable.
    expect((await a1.tool("kb_search", { query: "stretched thin" })).text).toContain("people/u0bob");

    // 2. Bob in a trusted channel thread.
    const b = await turn(mention, "U0BOB", "510.0", "510.1", "what's on for the launch?");
    expect(b.block).toContain("Bob likes bullet points.");
    expect(b.block).not.toContain(NOTE);
    expect(b.block).not.toContain(ALICE_TOLD);
    const about = await b.tool("memory_about", { userId: "U0BOB" });
    expect(about.isError).toBeFalsy();
    expect(about.text).toContain("Bob reviews quickly when tagged.");
    expect(about.text).not.toContain(NOTE);
    const bobSearch = await b.tool("kb_search", { query: "stretched thin" });
    expect(bobSearch.isError).toBeFalsy();
    expect(bobSearch.text).not.toContain("stretched");
    expect(bobSearch.text).not.toContain("people/u0bob\"");
    // Positive control: the same search does find a page Bob may read.
    expect((await b.tool("kb_search", { query: "reviews quickly" })).text).toContain("people/u0bob-review");

    // 3. Alice in a channel thread: her profile applies, her /1on1 note does not come along.
    const a2 = await turn(mention, "U0ALICE", "520.0", "520.1", "status of the launch?");
    expect(a2.block).toContain(ALICE_TOLD);
    expect(a2.block).not.toContain(NOTE);
    expect((await a2.tool("kb_search", { query: "stretched thin" })).text).not.toContain("stretched");
    const aliceAbout = await a2.tool("memory_about", { userId: "U0ALICE" });
    expect(aliceAbout.text).toContain(ALICE_TOLD);
    expect(aliceAbout.text).not.toContain(NOTE);

    // 4. Bob inside Alice's locked thread (opened to guests): only Bob's profile is read.
    await OneOnOne.setOpen("C0TEAM", LOCKED, "guests may ask about the launch");
    reads = [];
    const b2 = await turn(mention, "U0BOB", LOCKED, "500.2", "any news?");
    expect(b2.block).toContain("Bob likes bullet points.");
    for (const absent of [ALICE_TOLD, NOTE]) expect(b2.block).not.toContain(absent);
    // Every read the turn's context made, and every tool read, holds Bob's
    // profile at most: never Alice's profile or her /1on1 slice.
    expect((await b2.tool("kb_search", { query: "stretched thin" })).text).not.toContain("stretched");
    const bobInLock = await b2.tool("memory_about", { userId: "U0BOB" });
    expect(bobInLock.text).not.toContain(NOTE);
    expect((await b2.tool("memory_about", { userId: "U0ALICE" })).isError).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    for (const union of reads) {
      expect(union).not.toContain(ALICE_PROFILE);
      expect(union).not.toContain(userSourceId("U0ALICE"));
    }
    expect(reads.some((u) => u.includes(BOB_PROFILE))).toBe(true);
    // And Bob's turn wrote nothing anywhere.
    expect(writes.filter((w) => w.name === "put_page")).toHaveLength(2);
  });
});

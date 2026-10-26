/**
 * The /1on1 nightly review end to end (phase D, spec §9.4; invariants 1, 2 and
 * 5), on the mono gateway. Real: the gateway's turn path and its scoped memory
 * sync (makeScopedMemory → BrainMemoryProvider), the scheduler with its slot
 * claims, the nightly review, the pass runner and its slaude_pass tools, the
 * ledger, the proposal cards and their click handler (registered by
 * createGateway), and the weekly digest. Fake: the brain backend (an
 * in-memory fake behind setBackendForTest), the SDK `query` (a scripted
 * "model" that calls the pass's own tools) and Slack.
 *
 *   1. Day D: Alice's locked /1on1 and Bob's channel thread each have a turn;
 *      memory sync writes them into `user-u0alice` and the agent slice.
 *   2. D+1 02:30: the nightly review runs one agent pass and one pass as Alice.
 *      Alice's pass writes a person-note and a profile entry quoting her, and
 *      proposes a team fact (a `promote` to shared); the channel pass writes a
 *      note about Bob into the agent slice.
 *   3. The proposal is posted to Alice's DM only. Her Approve forwards it to
 *      the manager; nothing is written to shared yet.
 *   4. Bob's later channel turn sees none of Alice's /1on1-derived pages.
 *   5. The ledger has one row per pass with its cost; the next Monday's digest
 *      renders them and cards the forwarded proposal for the manager, whose
 *      Approve writes it to shared.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createGateway, type GatewayHandle } from "../../src/gateway/core/gateway";
import { AgentManager, type InputSender } from "../../src/agent/manager";
import { db } from "../../src/db/schema";
import * as OneOnOne from "../../src/db/one-on-one";
import * as Proposals from "../../src/db/proposals";
import * as Runs from "../../src/db/background-runs";
import { writeSoulFixture, WORLD } from "../../src/gateway/sim/soul-fixture";
import { setBackendForTest, resetBackend } from "../../src/knowledge/backend";
import { resetAgentId, setAgentId } from "../../src/knowledge/agent-identity";
import { resetStandingGrants } from "../../src/knowledge/gated-dispatch";
import { brainAdminCall, brainCall } from "../../src/knowledge/brain";
import { agentSourceId, profileSourceId, SHARED_SOURCE, userSourceId, type BrainScope } from "../../src/knowledge/scope";
import { __setMemoryForTests, memory as processMemory } from "../../src/memory";
import { BrainMemoryProvider } from "../../src/memory/brain-provider";
import type { MemoryProvider } from "../../src/memory/provider";
import { createBackgroundScheduler, defaultAgentGroups, passHandlers } from "../../src/background/scheduler";
import { cardPoster, postPersonProposals, PROPOSAL_ACTION, approveActionId } from "../../src/background/proposal-cards";
import { PROFILE_SCOPE_REFUSAL, QUOTE_REFUSAL, SHARED_REFUSAL } from "../../src/background/pass-tools";
import type { RunnerDeps } from "../../src/background/runner";
import type { PriceTable } from "../../src/background/prices";
import type { ActionHandler } from "../../src/gateway/core/transport";
import { fakeBrain } from "../memory/fake-brain";

const ENV = ["SLAUDE_BRAIN_MODE", "SLAUDE_BRAIN_DISABLED", "SLAUDE_BACKGROUND_TIMEZONE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const AGENT_ID = "U_SLAUDE";
const AGENT = agentSourceId(AGENT_ID);
const ALICE_SLICE = userSourceId("U0ALICE");
const ALICE_PROFILE = profileSourceId("T", "U0ALICE");
const LOCKED = "1600.0";
const CHANNEL_THREAD = "1610.0";

/** Day D (a Sunday): the conversations. The nightly runs on D+1; the digest the Monday after. */
const DAY = "2026-10-25";
const NIGHTLY_AT = "2026-10-26T02:30:00Z";
const DIGEST_AT = "2026-11-02T09:00:00Z";

const ALICE_SAID = "Bob looks overloaded. Call me Al, and keep answers short.";
const QUOTE = "Call me Al, and keep answers short.";
const NOTE = "Bob seems stretched thin before the launch";
const TEAM_FACT = "The launch moved to Friday the 13th.";
const BOB_SAID = "I keep the deploy runbook in the wiki now.";
const AGENT_NOTE = "Bob maintains the deploy runbook.";

const MODEL = "test-model";
const TABLE: PriceTable = { [MODEL]: { input: 1, output: 10, cache_read: 0.1, cache_write: 1.25 } };
/** Each pass's cumulative usage as the fake model reports it in its result. */
const USAGE = {
  agent: { inputTokens: 20_000, outputTokens: 1_000, cacheReadInputTokens: 100_000, cacheCreationInputTokens: 8_000 },
  alice: { inputTokens: 30_000, outputTokens: 2_000, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 0 },
};
// USD per million tokens × tokens.
const COST = {
  agent: (20_000 * 1 + 1_000 * 10 + 100_000 * 0.1 + 8_000 * 1.25) / 1e6, // 0.05
  alice: (30_000 * 1 + 2_000 * 10 + 50_000 * 0.1) / 1e6, // 0.055
};

let fb: ReturnType<typeof fakeBrain>;
/** Every put_page the brain received: slug and write source. */
let writes: Array<{ slug: string; source: string }>;

function search(query: string, scope: BrainScope) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...fb.contents.entries()]
    .map(([k, content]) => [...(k.split("\u0000") as [string, string]), content] as const)
    .filter(([src, , content]) => scope.allowedSources.includes(src) && words.every((w) => content.toLowerCase().includes(w)))
    .map(([src, slug, content]) => ({ slug, source_id: src, score: 1, chunk_text: content }));
}

/** Timeline rows per source and slug (get_timeline), stamped with day D as gbrain stamps created_at. */
let timelines: Map<string, Map<string, unknown[]>>;
let stamp = 0;

function transport() {
  const handlers = new Map<string, (args: any) => Promise<void>>();
  const actions: Array<[RegExp | string, ActionHandler]> = [];
  const posts: Array<{ channel: string; text: string; blocks: any[] }> = [];
  const client: any = {
    auth: { test: async () => ({ user_id: AGENT_ID, bot_id: "B_SLAUDE", team: "T", url: "x" }) },
    chat: {
      postMessage: async (m: { channel: string; text: string; blocks?: any[] }) => {
        posts.push({ channel: m.channel, text: m.text, blocks: m.blocks ?? [] });
        return { ok: true, ts: "1.1" };
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
    action: (pattern: RegExp | string, fn: ActionHandler) => void actions.push([pattern, fn]),
    use: () => {}, start: async () => {}, stop: async () => {},
    event: (name: string, fn: any) => void handlers.set(name, fn),
  };
  const mention = async (user: string, thread: string, ts: string, text: string) => {
    const event = { type: "message", channel: "C0TEAM", channel_type: "channel", user, team: "T", ts, thread_ts: thread, text: `<@${AGENT_ID}> ${text}` };
    const args = { event, client, context: { teamId: "T" } };
    await handlers.get("app_mention")?.({ ...args, event: { ...event, type: "app_mention" } });
    await handlers.get("message")!(args);
  };
  /** A click on a card's button, as Slack delivers it to the registered action handler. */
  const click = async (by: string, actionId: string, message: { text: string; blocks: any[] }) => {
    const handler = actions.find(([p]) => p === PROPOSAL_ACTION)?.[1];
    if (!handler) throw new Error("no proposal action registered");
    const replies: any[] = [];
    await handler({
      ack: async () => {},
      action: { action_id: actionId },
      body: { user: { id: by }, team: { id: "T" }, message },
      respond: async (m) => void replies.push(m),
    });
    return replies;
  };
  return { t, mention, click, posts };
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
/** The scoped memory provider the gateway installed on the agent (mono). */
let scoped: MemoryProvider;
let sent: Array<{ sid: string; text: string; sender?: InputSender }>;
let spies: Array<ReturnType<typeof spyOn>> = [];
const originalMemory = processMemory;

/** A mention, the turn it starts, and that turn synced to memory as the gateway's provider does at turn end. */
async function turn(mention: ReturnType<typeof transport>["mention"], user: string, thread: string, ts: string, text: string, reply = "ok") {
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
  const sync = () => scoped.syncTurn({ sessionId: sid, user: env, assistant: reply });
  return { sid, block, tool, sync };
}

type Tools = Record<string, { handler: (a: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;

/** What the scripted model saw and what its tool calls answered, per pass. */
interface Seen {
  who: "agent" | "alice";
  prompt: string;
  answers: Record<string, string>;
}

/**
 * The fake model: per pass, the tool calls a model reviewing that transcript
 * would make, then one assistant turn and a result carrying that pass's
 * cumulative modelUsage.
 */
function fakeQuery(seen: Seen[]): RunnerDeps["query"] {
  return ((args: { prompt: AsyncIterable<{ message: { content: string } }>; options: { mcpServers: Record<string, { instance: { _registeredTools: Tools } }> } }) =>
    (async function* () {
      let prompt = "";
      for await (const m of args.prompt) prompt = m.message.content;
      const tools = args.options.mcpServers.slaude_pass!.instance._registeredTools;
      const answer = async (name: string, a: unknown) => {
        const r = await tools[name]!.handler(a, {});
        return r.isError ? r.content[0]!.text : "ok";
      };
      const who: Seen["who"] = prompt.includes("U0ALICE: ") ? "alice" : "agent";
      const answers: Record<string, string> = {};
      if (who === "alice") {
        answers.note = await answer("memoize", { pages: [{ slug: "people/u0bob", type: "person-note", content: NOTE, subject: "U0BOB", confidence: "inferred" }] });
        answers.profile = await answer("memoize", { pages: [{ slug: "profile", type: "profile", content: "Call her Al. Short answers.", quote: QUOTE }] });
        // The agent's own words are not hers: no profile entry from them.
        answers.agentQuote = await answer("memoize", { pages: [{ slug: "profile", type: "profile", content: "x", quote: "Noted, Al. Short answers it is." }] });
        answers.shared = await answer("memoize", { pages: [{ slug: "team/launch", type: "team-fact", content: TEAM_FACT, target: "shared" }] });
        answers.propose = await answer("propose", {
          kind: "promote",
          to: "person",
          payload: { summary: "The launch date, for the team", pages: [{ slug: "team/launch", type: "team-fact", content: TEAM_FACT, confidence: "told" }] },
        });
      } else {
        answers.note = await answer("memoize", { pages: [{ slug: "people/u0bob-runbook", type: "person-note", content: AGENT_NOTE, subject: "U0BOB" }] });
        answers.profile = await answer("memoize", { pages: [{ slug: "profile", type: "profile", content: "x", quote: BOB_SAID }] });
      }
      seen.push({ who, prompt, answers });
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `m-${who}`, model: MODEL, usage: { input_tokens: 10, output_tokens: 1 }, content: [] } };
      yield { type: "result", subtype: "success", is_error: false, usage: {}, modelUsage: { [MODEL]: USAGE[who] } };
    })()) as unknown as RunnerDeps["query"];
}

beforeAll(() => {
  process.env.SLAUDE_BRAIN_MODE = "remote";
  delete process.env.SLAUDE_BRAIN_DISABLED;
  delete process.env.SLAUDE_BACKGROUND_TIMEZONE;
  setAgentId(AGENT_ID);
});
afterAll(() => {
  __setMemoryForTests(originalMemory);
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
  timelines = new Map();
  stamp = 0;
  const call = async (n: string, p: Record<string, unknown>, s: BrainScope): Promise<unknown> => {
    if (n === "put_page") writes.push({ slug: String(p.slug), source: s.sourceId });
    if (n === "search") return search(String(p.query), s);
    if (n === "add_timeline_entry") {
      let m = timelines.get(s.sourceId);
      if (!m) timelines.set(s.sourceId, (m = new Map()));
      const rows = m.get(String(p.slug)) ?? [];
      rows.push({ id: rows.length + 1, ...p, date: DAY, created_at: `${DAY}T1${stamp++}:00:00Z` });
      m.set(String(p.slug), rows);
      return { ok: true };
    }
    if (n === "get_timeline") return s.allowedSources.flatMap((src) => timelines.get(src)?.get(String(p.slug)) ?? []);
    return fb.call(n, p, s);
  };
  setBackendForTest({
    ready: () => true,
    call,
    adminCall: async (n: string) => {
      if (n !== "sources_list") return null;
      const ids = new Set([...timelines.keys(), ...[...fb.contents.keys()].map((k) => k.split("\u0000")[0]!)]);
      return { sources: [...ids].map((id) => ({ id })) };
    },
  } as any);
  // Brain-backed episodic memory, as in production with the brain on.
  __setMemoryForTests(new BrainMemoryProvider({ call: (n, p, s) => brainCall(n, p, s), ready: async () => {} }));
  sent = [];
  resetStandingGrants();
  writeSoulFixture(WORLD);
  await OneOnOne._wipeForTests();
  for (const table of ["cron_jobs", "sessions", "proposals", "background_runs", "background_slots"]) await db.run(`DELETE FROM ${table}`);
  agent = new AgentManager();
  agent.sendMessage = async (sid: string, text: string, opts?: { sender?: InputSender }) => {
    sent.push({ sid, text, ...(opts?.sender ? { sender: opts.sender } : {}) });
  };
  agent.turnSenders = () => {
    const last = sent.at(-1)?.sender;
    return last ? [last] : null;
  };
  const install = agent.setMemoryProvider.bind(agent);
  agent.setMemoryProvider = (p: MemoryProvider) => {
    scoped = p;
    install(p);
  };
  spies = (["log", "warn", "debug"] as const).map((k) => spyOn(console, k).mockImplementation(() => {}));
});
afterEach(async () => {
  await h?.stop();
  h = null;
  for (const s of spies) s.mockRestore();
  spies = [];
});

describe("/1on1 nightly review, end to end", () => {
  test("Alice's /1on1 is reviewed as Alice: her writes stay hers, her proposal reaches only her, Bob sees none of it; the ledger and digest account for every pass", async () => {
    await OneOnOne.lock({ channelId: "C0TEAM", threadTs: LOCKED, lockedUser: "U0ALICE", createdBy: "U0ALICE" });
    const { t, mention, click, posts } = transport();
    h = createGateway(agent, t);

    // 1. Day D: Alice's /1on1 and Bob's channel thread, synced through the gateway's scoped memory.
    const a = await turn(mention, "U0ALICE", LOCKED, "1600.1", ALICE_SAID, "Noted, Al. Short answers it is.");
    await a.sync();
    const b = await turn(mention, "U0BOB", CHANNEL_THREAD, "1610.1", BOB_SAID, "Thanks, Bob.");
    await b.sync();
    expect([...timelines.keys()].sort()).toEqual([AGENT, ALICE_SLICE].sort());
    expect(JSON.stringify([...timelines.get(ALICE_SLICE)!.values()])).toContain("Call me Al");
    expect(JSON.stringify([...timelines.get(AGENT)!.values()])).not.toContain("Call me Al");
    // The sessions were last touched on day D.
    await db.run("UPDATE sessions SET updated_at = ?", [Date.parse(`${DAY}T20:00:00Z`)]);
    writes = [];

    // 2. D+1 02:30: the scheduler claims the nightly slot and runs it.
    const seen: Seen[] = [];
    const runner: RunnerDeps = {
      query: fakeQuery(seen),
      brainCall,
      now: () => new Date(NIGHTLY_AT),
      priceTable: TABLE,
      model: () => MODEL,
      budget: () => ({ limitUsd: 1, timeZone: "UTC" }),
      kbSources: () => [],
      provider: async () => null,
    };
    const post = cardPoster(t);
    const handlers = passHandlers(
      {
        runner,
        call: brainCall,
        listSources: async () => (((await brainAdminCall("sources_list", {})) as { sources: Array<{ id: string }> }).sources ?? []).map((s) => s.id),
        deliver: (d) => postPersonProposals({ ...d, post }).then(() => {}),
      },
      { post, managers: () => [WORLD.manager, WORLD.backup!], digestRecipient: () => WORLD.manager },
    );
    let at = NIGHTLY_AT;
    const scheduler = createBackgroundScheduler({
      now: () => new Date(at),
      brainReady: () => true,
      agents: defaultAgentGroups,
      handlers,
      sweep: async () => {},
      quietDue: async () => [],
    });
    expect((await defaultAgentGroups()).map((g) => [g.agentId, g.personaIds, g.timeZone])).toEqual([[AGENT_ID, ["default"], "UTC"]]);
    await scheduler.tick();

    // One agent pass, then one as Alice; each saw only its own slice's day.
    expect(seen.map((s) => s.who)).toEqual(["agent", "alice"]);
    const [chan, alice] = seen as [Seen, Seen];
    expect(chan.prompt).toContain(`U0BOB: ${BOB_SAID}`);
    expect(chan.prompt).not.toContain("Call me Al");
    expect(alice.prompt).toContain(`U0ALICE: ${ALICE_SAID}`);
    expect(alice.prompt).not.toContain(BOB_SAID);
    expect(alice.answers).toEqual({ note: "ok", profile: "ok", agentQuote: QUOTE_REFUSAL, shared: SHARED_REFUSAL, propose: "ok" });
    expect(chan.answers).toEqual({ note: "ok", profile: PROFILE_SCOPE_REFUSAL });

    // Alice's writes land only in her slice and her profile; the channel pass's in the agent slice.
    expect(writes).toEqual([
      { slug: "people/u0bob-runbook", source: AGENT },
      { slug: "people/u0bob", source: ALICE_SLICE },
      { slug: "profile", source: ALICE_PROFILE },
    ]);
    expect(fb.contentOf(ALICE_SLICE, "people/u0bob")).toContain(NOTE);
    const profile = fb.contentOf(ALICE_PROFILE, "profile")!;
    expect(profile).toContain("Call her Al.");
    expect(profile).toContain(`quote: "${QUOTE}"`);
    for (const src of [AGENT, SHARED_SOURCE]) expect(fb.contentOf(src, "people/u0bob")).toBeUndefined();
    expect(fb.contentOf(SHARED_SOURCE, "team/launch")).toBeUndefined();
    expect(fb.contentOf(AGENT, "people/u0bob-runbook")).toContain(AGENT_NOTE);

    // 3. The proposal is Alice's, posted to her DM alone.
    const open = await Proposals.listOpen(AGENT_ID, "person", "U0ALICE");
    expect(open).toHaveLength(1);
    const prop = open[0]!;
    expect(prop).toMatchObject({ kind: "promote", toKind: "person", toUser: "U0ALICE", scope: "user:U0ALICE" });
    expect(await Proposals.listOpen(AGENT_ID, "manager")).toEqual([]);
    expect(posts.map((p) => p.channel)).toEqual(["U0ALICE"]);
    const dm = posts[0]!;
    expect(JSON.stringify(dm.blocks)).toContain(approveActionId(prop.id));
    expect(JSON.stringify(dm.blocks)).toContain("Friday the 13th");

    // A second tick (or a second replica) runs nothing again: the slot is claimed.
    await scheduler.tick();
    expect(seen).toHaveLength(2);

    // Bob may not decide Alice's proposal; Alice's Approve forwards it to the manager.
    const refused = await click("U0BOB", approveActionId(prop.id), dm);
    expect(JSON.stringify(refused)).toContain("only the person it is for");
    const approved = await click("U0ALICE", approveActionId(prop.id), dm);
    expect(JSON.stringify(approved)).toContain("sent to the manager");
    const forwarded = await Proposals.listOpen(AGENT_ID, "manager");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ kind: "promote", toKind: "manager", scope: "user:U0ALICE" });
    expect(forwarded[0]!.payload).toMatchObject({ target: "shared", promotedFrom: prop.id });
    expect(fb.contentOf(SHARED_SOURCE, "team/launch")).toBeUndefined();

    // 4. Bob's later channel turn: none of Alice's /1on1-derived pages; the channel pass's note is there.
    const later = await turn(mention, "U0BOB", "1630.0", "1630.1", "how is the launch going?");
    for (const absent of [NOTE, "Call her Al", TEAM_FACT]) expect(later.block).not.toContain(absent);
    const about = await later.tool("memory_about", { userId: "U0BOB" });
    expect(about.isError).toBeFalsy();
    expect(about.text).toContain(AGENT_NOTE);
    expect(about.text).not.toContain(NOTE);
    for (const q of ["stretched thin", "Call her Al", "Friday the 13th"]) {
      const r = await later.tool("kb_search", { query: q });
      expect(r.isError).toBeFalsy();
      expect(r.text).not.toContain(q.split(" ")[0]!);
    }
    // Positive control: Bob's search finds what he may read.
    expect((await later.tool("kb_search", { query: "deploy runbook" })).text).toContain("people/u0bob-runbook");
    expect((await later.tool("memory_about", { userId: "U0ALICE" })).text).not.toContain("Call her Al");

    // 5. The ledger: one row per pass, priced per model from the result's usage.
    const rows = await Runs.listBetween(AGENT_ID, "2026-10-26", "2026-10-26");
    expect(rows.map((r) => [r.pass, r.scope, r.outcome, r.model])).toEqual([
      ["nightly-review", "agent", "ok", MODEL],
      ["nightly-review", "user:U0ALICE", "ok", MODEL],
    ]);
    expect(rows[0]!.costUsd).toBeCloseTo(COST.agent, 10);
    expect(rows[1]!.costUsd).toBeCloseTo(COST.alice, 10);
    expect(await Runs.spentOn(AGENT_ID, "2026-10-26")).toBeCloseTo(COST.agent + COST.alice, 10);

    // The next Monday 09:00: the digest goes to the manager, rendering the week's runs and spend.
    at = DIGEST_AT;
    posts.length = 0;
    await scheduler.tick();
    expect(posts.map((p) => p.channel)).toEqual([WORLD.manager]);
    const digest = posts[0]!;
    const text = JSON.stringify(digest.blocks);
    expect(digest.text).toContain("Weekly digest, 2026-10-26 to 2026-11-01");
    expect(text).toContain("nightly-review: ok 2");
    expect(text).toContain(`2026-10-26: $${(COST.agent + COST.alice).toFixed(4)} of $1.0000`);
    expect(text).toContain("Skipped for budget*\\nNone.");
    // The forwarded proposal is carded for the manager; Alice's private pages are not in it.
    expect(text).toContain(approveActionId(forwarded[0]!.id));
    expect(text).toContain("agreed to share this from a private conversation");
    expect(text).toContain("Friday the 13th");
    for (const absent of [NOTE, "Call her Al", ALICE_SAID]) expect(text).not.toContain(absent);
    const digestRows = await Runs.listBetween(AGENT_ID, "2026-11-02", "2026-11-02");
    expect(digestRows.map((r) => [r.pass, r.outcome, r.costUsd])).toEqual([["digest", "ok", 0]]);

    // The manager's Approve writes the team fact to shared, and nothing else.
    writes = [];
    const managerApproves = await click(WORLD.manager, approveActionId(forwarded[0]!.id), digest);
    expect(JSON.stringify(managerApproves)).toContain("written to shared memory");
    expect(writes).toEqual([{ slug: "team/launch", source: SHARED_SOURCE }]);
    expect(fb.contentOf(SHARED_SOURCE, "team/launch")).toContain(TEAM_FACT);
    expect(fb.contentOf(SHARED_SOURCE, "people/u0bob")).toBeUndefined();
  });
});

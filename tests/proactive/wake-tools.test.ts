import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import * as WakeState from "../../src/db/heartbeat-wake-state";
import { __setProactiveSoulSource } from "../../src/soul/proactive";
import { finishRoundTool, proactivePostTool, readChannelTool, wakeThreadRefusal, type WakeToolContext, type WakeToolDeps } from "../../src/proactive/wake-tools";
import { composeRulePage } from "../../src/proactive/rules";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z");
const H = 3_600_000;
const SOUL = "## Proactive\n- Enabled: yes\n- Wake: yes\n- Highest: act\n- Max per person per day: 20\n- Cooldown: 0\n- Read: C0READABLE\n\n## Channel C0ONCHANNE\n### Proactive\n- Enabled: yes\n- Highest: act\n- Max per day: 20\n- Cooldown: 0\n\n## Channel C0ASKCHANN\n### Proactive\n- Enabled: yes\n- Highest: inform\n- Max per day: 20\n- Cooldown: 0\n";

function harness(over: Partial<WakeToolDeps> = {}, history: unknown = { messages: [] }) {
  const brain = fakeBrain();
  const posted: { channel: string; text: string }[] = [];
  const bound: string[] = [];
  const deps: WakeToolDeps = {
    post: async (m) => {
      posted.push({ channel: m.channel, text: m.text });
      return { channel: m.channel.startsWith("U") ? "D0DM" : m.channel, ts: `17000000${posted.length}.000100` };
    },
    call: brain.call,
    managerId: () => MGR,
    agentId: async () => AGENT,
    timeZone: () => "UTC",
    bindThread: async (p) => void bound.push(p.id),
    gate: () => ({ slotMs: 30 * 60_000, maxSleepMs: 24 * H }),
    now: () => NOW,
    ...over,
  };
  const client = {
    conversations: {
      history: async (a: unknown) => {
        if (history instanceof Error) throw history;
        return { ...(history as object), __args: a };
      },
    },
  };
  const ctx: WakeToolContext = { client: client as never, channel: MGR, wake: { runId: "run-1", deps }, apiAppId: "A0APP", teamId: "T0TEAM" };
  return { ctx, deps, brain, posted, bound };
}
const post = (over: Record<string, unknown> = {}) => ({ destination: "C0ONCHANNE", kind: "daily brief", text: "Today's numbers are up.", evidence: "projects/numbers", item_id: "brief-1", ...over });
const parsed = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

beforeEach(async () => {
  __setProactiveSoulSource(() => SOUL);
  await db.run("DELETE FROM proactive_posts");
  await db.run("DELETE FROM heartbeat_wake_state");
});
afterEach(() => __setProactiveSoulSource(null));

describe("proactive_post", () => {
  test("posts, records the run, and binds the thread for a reply", async () => {
    const h = harness();
    const r = parsed(await proactivePostTool(h.ctx, post()));
    expect(r.posted).toBe(true);
    expect(r.channel).toBe("C0ONCHANNE");
    expect(h.posted).toHaveLength(1);
    expect(h.bound).toHaveLength(1);
    const row = await Posts.findByMessage("C0ONCHANNE", r.ts);
    expect(row?.context?.wakeRun).toBe("run-1");
    expect(row?.context?.source).toBe("wake");
  });
  test("outside a wake it refuses", async () => {
    const h = harness();
    const { wake: _w, ...normal } = h.ctx;
    const r = await proactivePostTool(normal, post());
    expect(r.isError).toBe(true);
    expect(h.posted).toEqual([]);
  });
  test("a channel without its own enabled block is refused", async () => {
    const h = harness();
    const r = await proactivePostTool(h.ctx, post({ destination: "C0UNLISTED" }));
    expect(r.isError).toBe(true);
    expect(h.posted).toEqual([]);
  });
  test("the checklist or notes count as no evidence, and do not make later posts look repeated", async () => {
    const h = harness();
    expect(parsed(await proactivePostTool(h.ctx, post({ evidence: "self/heartbeat", item_id: "a", text: "First." }))).posted).toBe(true);
    await db.run("UPDATE proactive_posts SET posted_at = posted_at - 7200000");
    expect(parsed(await proactivePostTool(h.ctx, post({ evidence: "self/wake-journal", item_id: "b", text: "Second." }))).posted).toBe(true);
  });
  test("text alone is enough: it goes to the one place, as a plain update", async () => {
    const h = harness();
    __setProactiveSoulSource(() => "## Reporting\n- Manager: U0MANAGER\n\n## Channel C0ONCHANNE\n### Proactive\n- Enabled: yes\n");
    const r = parsed(await proactivePostTool(h.ctx, { text: "**Rendered** the reel: out.mp4" }));
    expect(r.channel).toBe("C0ONCHANNE");
    expect(h.posted[0]!.text).toBe("*Rendered* the reel: out.mp4");
    const row = await Posts.findByMessage("C0ONCHANNE", r.ts);
    expect(row?.topic).toBe("update");
    expect(row?.context?.level).toBe("inform");
  });
  test("several places: it must say which", async () => {
    const h = harness();
    const r = await proactivePostTool(h.ctx, { text: "Which?" });
    expect(r.isError).toBe(true);
    expect(h.posted).toEqual([]);
  });
  test("the same item goes out once", async () => {
    const h = harness();
    await proactivePostTool(h.ctx, post());
    const again = parsed(await proactivePostTool(h.ctx, post({ text: "Reworded." })));
    expect(again).toEqual({ refused: true, rule: "already-posted", retryable: false });
    expect(h.posted).toHaveLength(1);
  });
  test("no rule keeps the asked level; a ceiling lowers it", async () => {
    const h = harness();
    const a = parsed(await proactivePostTool(h.ctx, post({ needs_reply: true })));
    expect((await Posts.findByMessage("C0ONCHANNE", a.ts))?.context?.level).toBe("ask");
    const b = parsed(await proactivePostTool(h.ctx, post({ destination: "C0ASKCHANN", needs_reply: true, item_id: "brief-2", evidence: "projects/other", text: "Other." })));
    expect((await Posts.findByMessage("C0ASKCHANN", b.ts))?.context?.level).toBe("inform");
  });
  test("a taught ignore rule refuses", async () => {
    const h = harness();
    const page = composeRulePage({ kind: "daily brief", scope: "C0ONCHANNE", level: "ignore", how: null, taughtBy: MGR, taughtAt: "2026-10-01", thread: "t", quote: "stop" }, NOW);
    if ("error" in page) throw new Error(page.error);
    await h.brain.call("put_page", { slug: page.slug, content: page.content }, { clientId: AGENT, sourceId: `agent-${AGENT.toLowerCase()}`, allowedSources: [`agent-${AGENT.toLowerCase()}`] });
    const r = parsed(await proactivePostTool(h.ctx, post()));
    expect(r).toEqual({ refused: true, rule: "ignored", retryable: false });
    expect(h.posted).toEqual([]);
  });
  test("a cooldown says when to retry", async () => {
    __setProactiveSoulSource(() => "## Proactive\n- Enabled: yes\n- Wake: yes\n- Highest: act\n- Max per person per day: 20\n\n## Channel C0ONCHANNE\n### Proactive\n- Enabled: yes\n- Cooldown: 2\n- Max per day: 20\n");
    const h = harness();
    await proactivePostTool(h.ctx, post());
    const r = parsed(await proactivePostTool(h.ctx, post({ item_id: "brief-2", text: "Later batch.", evidence: "projects/later" })));
    expect(r.refused).toBe(true);
    expect(r.rule).toBe("cooldown");
    expect(r.retryable).toBe(true);
    expect(r.retryAfter).toBe(new Date(NOW.getTime() + 2 * H).toISOString());
  });
  test("at most the run's post cap", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(parsed(await proactivePostTool(h.ctx, post({ item_id: `i-${i}`, text: `T ${i}`, evidence: `e/${i}` }))).posted).toBe(true);
    expect((await proactivePostTool(h.ctx, post({ item_id: "i-9", text: "T 9", evidence: "e/9" }))).isError).toBe(true);
  });
});

describe("post_message in a wake", () => {
  test("only under a post this run opened", async () => {
    const h = harness();
    const r = parsed(await proactivePostTool(h.ctx, post()));
    expect(await wakeThreadRefusal(h.ctx.wake!, "C0ONCHANNE", r.ts)).toBeNull();
    expect(await wakeThreadRefusal(h.ctx.wake!, "C0ONCHANNE", undefined)).toContain("refused");
    expect(await wakeThreadRefusal(h.ctx.wake!, "C0ONCHANNE", "9.9")).toContain("refused");
    // A later wake may remind in the thread of an earlier post of this agent's.
    expect(await wakeThreadRefusal({ ...h.ctx.wake!, runId: "other" }, "C0ONCHANNE", r.ts)).toBeNull();
    const other = { ...h.ctx.wake!, deps: { ...h.ctx.wake!.deps, agentId: async () => "U0SOMEONEELSE" } };
    expect(await wakeThreadRefusal(other, "C0ONCHANNE", r.ts)).toContain("refused");
  });
});

describe("read_channel", () => {
  test("a listed channel reads, in any turn; secrets are redacted", async () => {
    const secret = `xoxb-${"1".repeat(20)}`;
    const h = harness({}, { messages: [{ ts: "1.0", user: "U1", text: `token ${secret}` }], has_more: false });
    const { wake: _w, ...normal } = h.ctx;
    const r = parsed(await readChannelTool(normal, { channel: "C0READABLE" }));
    expect(r.messages[0].ts).toBe("1.0");
    expect(r.messages[0].text).not.toContain(secret);
    expect(r.note).toContain("data");
  });
  test("an unlisted channel is refused, in a wake and out of one", async () => {
    const h = harness();
    const { wake: _w, ...normal } = h.ctx;
    expect((await readChannelTool(h.ctx, { channel: "C0OTHERCHA" })).isError).toBe(true);
    expect((await readChannelTool(normal, { channel: "C0OTHERCHA" })).isError).toBe(true);
  });
  test("a missing scope says the operator must fix it", async () => {
    const e = Object.assign(new Error("x"), { data: { error: "missing_scope" } });
    const h = harness({}, e);
    const r = await readChannelTool(h.ctx, { channel: "C0READABLE" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("operator");
  });
});

describe("finish_round", () => {
  test("saves the notes and clamps the time: a year away becomes the longest sleep", async () => {
    const h = harness();
    const r = parsed(await finishRoundTool(h.ctx, { journal: "Open: batch 2.", next_check_at: "2027-10-26T12:00:00Z" }));
    expect(r.nextCheckAt).toBe(new Date(NOW.getTime() + 24 * H).toISOString());
    const s = await WakeState.get(AGENT);
    expect(s?.nextCheckAt).toBe(NOW.getTime() + 24 * H);
    expect(s?.finishedAt).toBe(NOW.getTime());
  });
  test("no time, or a bad one: a few hours on", async () => {
    const h = harness();
    expect(parsed(await finishRoundTool(h.ctx, { journal: "x" })).nextCheckAt).toBe(new Date(NOW.getTime() + 4 * H).toISOString());
    expect(parsed(await finishRoundTool(h.ctx, { journal: "x", next_check_at: "soon" })).nextCheckAt).toBe(new Date(NOW.getTime() + 4 * H).toISOString());
  });
  test("outside a wake it refuses", async () => {
    const h = harness();
    const { wake: _w, ...normal } = h.ctx;
    expect((await finishRoundTool(normal, { journal: "x" })).isError).toBe(true);
  });
});

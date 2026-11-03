import { describe, expect, test } from "bun:test";
import { recentActivity, type ActivityMessage, type ActivityReader } from "../../src/proactive/wake-activity";
import type { ProactivePost } from "../../src/db/proactive-posts";

const NOW = new Date("2026-11-03T14:00:00.000Z");
const ts = (msAgo: number) => ((NOW.getTime() - msAgo) / 1000).toFixed(6);
const H = 3_600_000;
const AGENT = "U0AGENT";

const post = (over: Partial<ProactivePost> = {}): ProactivePost =>
  ({ id: "p", agentId: AGENT, audience: "channel", recipient: "C1", topic: "update", textHash: "x", evidenceHash: null, channelId: "C1", messageTs: ts(5 * H), teamId: "T", postedAt: NOW.getTime() - 5 * H, text: "Three concepts ready.", context: null, appId: null, ...over }) as ProactivePost;

const reader = (history: ActivityMessage[], replies: Record<string, ActivityMessage[]> = {}): ActivityReader => ({
  history: async () => history,
  replies: async (_c, t) => replies[t] ?? [],
});
const run = (r: ActivityReader, posts: ProactivePost[] = [], lastWakeAt: number | null = NOW.getTime() - 6 * H) =>
  recentActivity({ reader: r, channels: ["C1"], posts, agentId: AGENT, lastWakeAt, now: NOW });

describe("recentActivity", () => {
  test("a reply under a post shows as the answer", async () => {
    const p = post();
    const t = await run(reader([], { [p.messageTs!]: [{ ts: p.messageTs!, user: AGENT, text: "root" }, { ts: ts(H), user: "U0BOSS", text: "all approved" }] }), [p]);
    expect(t).toContain("all approved");
    expect(t).not.toContain("NO ANSWER");
  });
  test("a post nobody answered says so, with how long", async () => {
    const t = await run(reader([]), [post()]);
    expect(t).toContain("NO ANSWER after 5h");
  });
  test("a new top-level message and its thread both show", async () => {
    const root = { ts: ts(H), user: "U0BOSS", text: "approved, publish", reply_count: 1, latest_reply: ts(H / 2) };
    const t = await run(reader([root], { [root.ts]: [root, { ts: ts(H / 2), user: AGENT, text: "on it" }] }));
    expect(t).toContain("approved, publish");
    expect(t).toContain("you: on it");
  });
  test("its own post is listed once, under its posts", async () => {
    const p = post();
    const t = await run(reader([{ ts: p.messageTs!, user: AGENT, text: "Three concepts ready." }]), [p]);
    expect(t.match(/Three concepts ready/g)).toHaveLength(1);
  });
  test("a channel it cannot read says so, and says what to do", async () => {
    const r = reader([]);
    r.history = async () => {
      throw Object.assign(new Error("x"), { data: { error: "not_in_channel" } });
    };
    const t = await run(r);
    expect(t).toContain("could not be read (not_in_channel)");
  });
  test("a thread that fails does not lose the rest", async () => {
    const root = { ts: ts(H), user: "U0BOSS", text: "top level", reply_count: 2, latest_reply: ts(H / 2) };
    const r = reader([root]);
    r.replies = async () => {
      throw new Error("boom");
    };
    expect(await run(r)).toContain("top level");
  });
  test("looks back at most three days, and one day on a first wake", async () => {
    let oldest = "";
    const r = reader([]);
    r.history = async (_c, o) => {
      oldest = o;
      return [];
    };
    await run(r, [], NOW.getTime() - 30 * 24 * H);
    expect(Number(oldest)).toBeCloseTo((NOW.getTime() - 72 * H) / 1000, 0);
    await run(r, [], null);
    expect(Number(oldest)).toBeCloseTo((NOW.getTime() - 24 * H) / 1000, 0);
  });
  test("stays bounded, and secrets are redacted", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ts: ts(H + i), user: "U0X", text: "x".repeat(2000) }));
    const t = await run(reader(many));
    expect(t.length).toBeLessThan(7100);
    expect(await run(reader([{ ts: ts(H), user: "U0X", text: "token xoxb-1234567890-abcdefghij" }]))).not.toContain("xoxb-1234567890");
  });
  test("nothing new reads as nothing new", async () => {
    expect(await run(reader([]))).toContain("(nothing new)");
  });
});

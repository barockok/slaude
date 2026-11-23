/**
 * The proactive post path (src/proactive/post.ts): the argument checks, the
 * restraint verdict, Slack failures, a ledger failure after the post is out,
 * the checklist slug, and the once-a-day manager notice.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "../../src/db/schema";
import * as Posts from "../../src/db/proactive-posts";
import { agentPageBody, channelChecklistSlug, line, sendProactive, tellManagerOnce, type ProactivePostArgs, type ProactivePostContext } from "../../src/proactive/post";
import type { ResolvedProactive } from "../../src/soul/proactive";
import { composePage } from "../../src/knowledge/memory-pages";
import { agentScope } from "../../src/proactive/post";
import { fakeBrain } from "../memory/fake-brain";

const AGENT = "U0AGENT";
const MGR = "U0MANAGER";
const NOW = new Date("2026-10-26T12:00:00Z");
const OPEN: ResolvedProactive = { enabled: true, quietHours: null, maxPerPersonPerDay: 50, cooldownHours: 0, highest: "act" };

let posted: { channel: string; text: string }[];
let throwWith: unknown;
function ctx(over: Partial<ProactivePostContext> = {}): ProactivePostContext {
  return {
    agentId: AGENT,
    personaId: "default",
    managerId: MGR,
    post: async (m) => {
      if (throwWith) throw throwWith;
      posted.push({ channel: m.channel, text: m.text });
      return { channel: m.channel, ts: `1700000${posted.length}.000100` };
    },
    call: fakeBrain().call,
    now: () => NOW,
    timeZone: "UTC",
    config: () => OPEN,
    ...over,
  };
}
const args = (over: Partial<ProactivePostArgs> = {}): ProactivePostArgs => ({ audience: "channel", recipient: "C0TEAMCHAN", topic: "status", text: "Batch two is done.", evidence: "item:b2", ...over });

beforeEach(async () => {
  posted = [];
  throwWith = undefined;
  await db.run("DELETE FROM proactive_posts");
  await db.run("DELETE FROM background_slots");
});
afterEach(() => {
  throwWith = undefined;
});

describe("sendProactive", () => {
  test("a channel post goes out and is recorded", async () => {
    const state = { posts: 0 };
    const r = await sendProactive(args(), ctx(), state);
    expect(r.ok).toBe(true);
    expect(posted).toEqual([{ channel: "C0TEAMCHAN", text: "Batch two is done." }]);
    expect(state.posts).toBe(1);
    expect(await Posts.recentFor(AGENT, "C0TEAMCHAN", 0)).toHaveLength(1);
  });

  test("the per-run cap refuses", async () => {
    const r = await sendProactive(args(), ctx(), { posts: 3 });
    expect(r).toMatchObject({ ok: false, kind: "cap" });
    expect(posted).toEqual([]);
  });

  test("a post needs evidence, a text of 1 to 3000 characters, and a topic", async () => {
    for (const bad of [{ evidence: "  " }, { text: "" }, { text: "x".repeat(3001) }, { topic: " " }]) {
      const r = await sendProactive(args(bad), ctx(), { posts: 0 });
      expect(r).toMatchObject({ ok: false, kind: "invalid" });
    }
    expect(posted).toEqual([]);
  });

  test("the recipient must fit its audience, and a manager post defaults to the manager", async () => {
    expect(await sendProactive(args({ recipient: "U0PERSON" }), ctx(), { posts: 0 })).toMatchObject({ ok: false, kind: "invalid" });
    expect(await sendProactive(args({ audience: "person", recipient: "C0TEAMCHAN" }), ctx(), { posts: 0 })).toMatchObject({ ok: false, kind: "invalid" });
    const r = await sendProactive(args({ audience: "manager", recipient: undefined }), ctx(), { posts: 0 });
    expect(r.ok).toBe(true);
    expect(posted[0]!.channel).toBe(MGR);
  });

  test("the restraint rules refuse a disabled channel, and name the rule", async () => {
    const r = await sendProactive(args(), ctx({ config: () => ({ ...OPEN, enabled: false }) }), { posts: 0 });
    expect(r).toMatchObject({ ok: false, kind: "restraint", rule: "channel-disabled" });
    expect(posted).toEqual([]);
  });

  test("an unchanged post is refused the second time", async () => {
    expect((await sendProactive(args(), ctx(), { posts: 0 })).ok).toBe(true);
    expect(await sendProactive(args(), ctx(), { posts: 0 })).toMatchObject({ ok: false, kind: "restraint", rule: "unchanged" });
  });

  test("a Slack channel error is a channel refusal; any other error is thrown", async () => {
    throwWith = Object.assign(new Error("x"), { data: { error: "channel_not_found" } });
    expect(await sendProactive(args(), ctx(), { posts: 0 })).toMatchObject({ ok: false, kind: "channel", error: "refused: slack: channel_not_found" });
    throwWith = new Error("socket hang up");
    await expect(sendProactive(args(), ctx(), { posts: 0 })).rejects.toThrow("socket hang up");
  });

  test("a ledger failure after the post is out is logged and the post still counts as sent", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const rec = spyOn(Posts, "recordPost").mockRejectedValue(new Error("db down"));
    try {
      const r = await sendProactive(args(), ctx(), { posts: 0 });
      expect(r).toEqual({ ok: true, post: null });
      expect(posted).toHaveLength(1);
      expect(err).toHaveBeenCalled();
    } finally {
      rec.mockRestore();
      err.mockRestore();
    }
  });
});

describe("page helpers", () => {
  test("the checklist slug is lowercase and one function builds it", () => {
    expect(channelChecklistSlug("C0ABCDEF")).toBe("self/heartbeat/c0abcdef");
  });

  test("line is one bounded line with no tag that can open or close", () => {
    expect(line("a\n b <x>")).toBe("a  b ‹x>");
    expect(line(null)).toBe("");
    expect(line("x".repeat(500), 10)).toHaveLength(10);
  });

  test("agentPageBody reads a live page's body, or an empty string", async () => {
    const brain = fakeBrain();
    expect(await agentPageBody(AGENT, brain.call, "self/heartbeat/c0abcdef")).toBe("");
    const page = composePage({ slug: "self/heartbeat/c0abcdef", content: "check the invoices", type: "heartbeat" }, NOW);
    await brain.call("put_page", { slug: "self/heartbeat/c0abcdef", content: (page as { content: string }).content }, agentScope(AGENT));
    expect(await agentPageBody(AGENT, brain.call, "self/heartbeat/c0abcdef")).toBe("check the invoices");
  });
});

describe("tellManagerOnce", () => {
  const r = { agentId: AGENT, timeZone: "UTC" };
  const mk = (over: Partial<Parameters<typeof tellManagerOnce>[3]> = {}) => {
    const sent: { channel: string; text: string }[] = [];
    return { sent, a: { managerId: MGR, app: undefined, post: async (m: { channel: string; text: string }) => (sent.push({ channel: m.channel, text: m.text }), { channel: "D0DM", ts: "1.1" }), at: NOW, tag: "[t]", ...over } as Parameters<typeof tellManagerOnce>[3] };
  };

  test("one DM per reason per day; a different reason goes out", async () => {
    const { sent, a } = mk();
    await tellManagerOnce(r, "budget", "out of budget", a);
    await tellManagerOnce(r, "budget", "out of budget", a);
    await tellManagerOnce(r, "other", "something else", a);
    expect(sent.map((s) => s.text)).toEqual(["out of budget", "something else"]);
    expect(sent.every((s) => s.channel === MGR)).toBe(true);
  });

  test("with no manager nothing is sent, and a post failure is logged, never thrown", async () => {
    const none = mk({ managerId: null });
    await tellManagerOnce(r, "x", "t", none.a);
    expect(none.sent).toEqual([]);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await tellManagerOnce(r, "boom", "t", { ...none.a, managerId: MGR, post: async () => { throw new Error("slack down"); } });
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

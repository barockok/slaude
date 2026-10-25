import { describe, expect, it } from "bun:test";
import { buildGateInput, normalizeSlackText, resolveMentions, type GateContextDeps } from "../../../src/gateway/gate/context";

const selfIds = { botUserId: "UBOT", botIds: new Set(["BBOT"]) };
const ev = { channel: "C1", ts: "100.5", thread_ts: "100.0", text: "<@UBOT> hi <@U123>" };
const opts = { mentionsAgent: true, engaged: false, channelTrust: "allowed" as const, contextMessages: 8 };

function deps(over: Partial<GateContextDeps> = {}): GateContextDeps {
  return { replies: async () => [], kbSearch: null, selfIds, ...over };
}

describe("resolveMentions", () => {
  it("resolves mentions to roles", () =>
    expect(resolveMentions("<@UBOT> ask <@U123> pls", "UBOT")).toBe("<agent> ask <user> pls"));
});

describe("buildGateInput", () => {
  it("recent excludes the new message, keeps the last N, maps roles", async () => {
    const msgs = Array.from({ length: 11 }, (_, i) => ({
      user: i === 3 ? "UBOT" : i === 5 ? undefined : "U9",
      bot_id: i === 5 ? "BBOT" : undefined,
      text: `m${i}`,
      ts: `${i + 1}`,
    }));
    msgs.push({ user: "U9", bot_id: undefined, text: "mine", ts: "100.5" });
    let asked = 0;
    const g = await buildGateInput(ev, opts, deps({ replies: async (_c, _t, limit) => ((asked = limit), msgs) }));
    expect(asked).toBe(9);
    expect(g.recent).toHaveLength(8);
    expect(g.recent.map((r) => r.text)).toEqual(["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    expect(g.recent[0]!.role).toBe("agent");
    expect(g.recent[2]!.role).toBe("agent");
    expect(g.recent[1]!.role).toBe("user");
    expect(g.message).toBe("<agent> hi <user>");
    expect(g.mentionsAgent).toBe(true);
    expect(g.channelTrust).toBe("allowed");
  });

  it("top-level message has empty recent and no replies call", async () => {
    let called = false;
    const g = await buildGateInput({ channel: "C1", ts: "5", text: "x" }, opts, deps({ replies: async () => ((called = true), []) }));
    expect(g.recent).toEqual([]);
    expect(called).toBe(false);
  });

  it("history failure yields empty recent", async () => {
    const g = await buildGateInput(ev, opts, deps({ replies: async () => { throw new Error("boom"); } }));
    expect(g.recent).toEqual([]);
  });

  it("kbHitScore is the clamped top rankScore, null without a brain or on error", async () => {
    const hit = await buildGateInput(ev, opts, deps({ kbSearch: async () => [{ score: 0.4 }, { rerank_score: 1.7 }] }));
    expect(hit.kbHitScore).toBe(1);
    const low = await buildGateInput(ev, opts, deps({ kbSearch: async () => [{ score: 0.4 }, { score: -2 }] }));
    expect(low.kbHitScore).toBe(0.4);
    const none = await buildGateInput(ev, opts, deps({ kbSearch: async () => [] }));
    expect(none.kbHitScore).toBe(0);
    expect((await buildGateInput(ev, opts, deps())).kbHitScore).toBeNull();
    const err = await buildGateInput(ev, opts, deps({ kbSearch: async () => { throw new Error("x"); } }));
    expect(err.kbHitScore).toBeNull();
  });
});

describe("normalizeSlackText", () => {
  const n = (t: string) => normalizeSlackText(t, "UBOT");
  it("handles mention forms", () => {
    expect(n("<@UBOT|bot> <@U1|jane> <@W2>")).toBe("<agent> <user> <user>");
  });
  it("reduces other markup", () => {
    expect(n("<#C123> <#C123|general>")).toBe("<channel> <channel>");
    expect(n("<!subteam^S1> <!subteam^S1|@grp>")).toBe("<group> <group>");
    expect(n("<!here> <!channel> <!everyone> <!here|here>")).toBe("<here> <here> <here> <here>");
    expect(n("<https://example.com/a?b=1|the doc>")).toBe("the doc");
    expect(n("<https://example.com/a/b?q=1>")).toBe("example.com");
    expect(n("<mailto:a@b.co> <mailto:a@b.co|a@b.co>")).toBe("<email> <email>");
  });
});

describe("buildGateInput normalization and ordering", () => {
  it("normalizes recent, message and the kb query", async () => {
    let q = "";
    const g = await buildGateInput(
      { channel: "C1", ts: "9", thread_ts: "1", text: "see <#C9|x> <https://e.com/p>" },
      opts,
      deps({
        replies: async () => [{ user: "U2", text: "<!here> <@U3|bob>", ts: "2" }],
        kbSearch: async (s) => ((q = s), []),
      }),
    );
    expect(g.recent[0]!.text).toBe("<here> <user>");
    expect(g.message).toBe("see <channel> e.com");
    expect(q).toBe("see <channel> e.com");
  });

  it("uses only messages up to the event, from an oldest-first list", async () => {
    const msgs = ["1", "2", "3", "4", "100.5", "101", "102"].map((ts) => ({ user: "U9", text: `t${ts}`, ts }));
    const g = await buildGateInput(ev, { ...opts, contextMessages: 3 }, deps({ replies: async () => msgs }));
    expect(g.recent.map((r) => r.text)).toEqual(["t2", "t3", "t4"]);
  });
});

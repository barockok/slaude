import { describe, expect, it } from "bun:test";
import { buildGateInput, resolveMentions, type GateContextDeps } from "../../../src/gateway/gate/context";

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

import { describe, expect, test } from "bun:test";
import { ReactionTracker } from "../src/gateway/slack/reactions";

function fake(addImpl?: (a: any) => any, removeImpl?: (a: any) => any) {
  const calls: any[] = [];
  const c: any = {
    reactions: {
      add: async (a: any) => {
        calls.push({ op: "add", a });
        if (addImpl) {
          const e = addImpl(a);
          if (e) throw e;
        }
      },
      remove: async (a: any) => {
        calls.push({ op: "remove", a });
        if (removeImpl) {
          const e = removeImpl(a);
          if (e) throw e;
        }
      },
    },
  };
  return { client: c, calls };
}

describe("ReactionTracker", () => {
  test("set adds reaction", async () => {
    const f = fake();
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    expect(f.calls).toEqual([{ op: "add", a: { channel: "C", timestamp: "1", name: "eyes" } }]);
  });

  test("transition removes prior + adds new", async () => {
    const f = fake();
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    await r.set("S", "C", "1", "white_check_mark");
    expect(f.calls.map((c) => c.op)).toEqual(["add", "remove", "add"]);
  });

  test("same emoji → no-op", async () => {
    const f = fake();
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    await r.set("S", "C", "1", "eyes");
    expect(f.calls.length).toBe(1);
  });

  test("already_reacted treated as success", async () => {
    const e: any = new Error("x");
    e.data = { error: "already_reacted" };
    const f = fake(() => e);
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    // forget cleans up state
    r.forget("S");
  });

  test("missing_scope auto-disables", async () => {
    const e: any = new Error("x");
    e.data = { error: "missing_scope" };
    const f = fake(() => e);
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    await r.set("S", "C", "1", "x"); // disabled — no call
    expect(f.calls.length).toBe(1);
  });

  test("remove failure tolerated", async () => {
    const f = fake(undefined, () => new Error("boom"));
    const r = new ReactionTracker(f.client);
    await r.set("S", "C", "1", "eyes");
    await r.set("S", "C", "1", "x");
  });
});
